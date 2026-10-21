import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import type { AgentSessionRecord, AgentStore } from './agent-store.js';
import { LEGACY_KEY, Workspaces } from './workspaces.js';

/**
 * 「这条会话改的是哪个工作区」——对话、预览、扇出、代码页、撤回、发布都问
 * 这一个地方，说法只有一份。
 *
 * 规则（docs/specs/2026-10-21-agent-harness.md §1.3）：
 *
 *   新会话（创建屏开工 / 手机壳第一句）
 *     → 新工作区，键就是会话 id
 *   带着 targetSlug（「改我的 /zhoubao/」）
 *     → 最近一次把它发布出去的那个工作区；没有这样的记录就落到 legacy
 *       （改版前所有页面都是从那里发出去的），再没有就用会话自己的
 *   带着一个会话表里没有的 id
 *     → 先看 {username}/{id}/ 在不在（会话过了保留期被清掉，工作区还在），
 *       不在就是改版前的会话——刷新前开着的工作台带着它回来，接回 legacy
 *   不带会话 id 的老客户端（部署那一刻开着的页面）
 *     → 这个人最近在做的那个；一个都没有就 legacy
 */
export class SessionWorkspaces {
  constructor(readonly store: AgentStore, readonly ws: Workspaces) {}

  /** 开一条新会话、一个新工作区。 */
  async begin(user: User): Promise<AgentSessionRecord> {
    const id = randomUUID();
    await this.ws.open(user.username, id);
    return this.store.create({ id, userId: user.id, workspace: id });
  }

  /**
   * 对话用：找到（必要时建出）会话，并按 targetSlug 对准工作区。
   *
   * 返回的 switched 是"这一句把工作区换了"——调用方要告诉模型，否则它会接着
   * 按上一个页面的文件说话。
   */
  async forAsk(
    user: User,
    opts: { sessionId?: string | undefined; targetSlug?: string | undefined },
  ): Promise<{ record: AgentSessionRecord; switched: boolean }> {
    let record = opts.sessionId ? await this.owned(user, opts.sessionId) : null;
    const wanted = opts.targetSlug ? await this.workspaceForSlug(user, opts.targetSlug, record) : null;

    if (!record) {
      const id = opts.sessionId ?? randomUUID();
      const workspace = wanted ?? (opts.sessionId ? await this.orphanWorkspace(user, id) : id);
      await this.ws.open(user.username, workspace);
      record = await this.store.create({ id, userId: user.id, workspace });
      return { record, switched: false };
    }

    if (wanted && wanted !== record.workspace) {
      await this.ws.open(user.username, wanted);
      await this.store.save(record.id, { workspace: wanted });
      return { record: { ...record, workspace: wanted }, switched: true };
    }
    await this.ws.open(user.username, record.workspace);
    return { record, switched: false };
  }

  /**
   * 只读场景（预览、文件树、扇出）用：给出工作区键，不建会话记录。
   *
   * 带了会话 id 而会话表里没有时，按"改版前的会话"同一条规则认 legacy——
   * 预览和对话必须指着同一个目录，否则右边看到的不是左边在改的。
   */
  async keyFor(user: User, sessionId?: string | undefined): Promise<string> {
    if (sessionId) {
      const r = await this.owned(user, sessionId);
      if (r) return r.workspace;
      return this.orphanWorkspace(user, sessionId);
    }
    return (await this.store.latestWorkspace(user.id))
      ?? ((await this.ws.hasLegacy(user.username)) ? LEGACY_KEY : await this.fresh(user));
  }

  /**
   * 同 keyFor，但什么都不建：一个工作区都没有的人返回 null。
   *
   * 给纯读的接口（文件树、原始文件）用——GET 一下文件树不该凭空多出一条会话
   * 和一个空目录。
   */
  async peek(user: User, sessionId?: string | undefined): Promise<string | null> {
    if (sessionId) return this.keyFor(user, sessionId);
    return (await this.store.latestWorkspace(user.id))
      ?? ((await this.ws.hasLegacy(user.username)) ? LEGACY_KEY : null);
  }

  /** 会话存在就必须是本人的。不存在返回 null。 */
  async owned(user: User, sessionId: string): Promise<AgentSessionRecord | null> {
    const r = await this.store.get(sessionId);
    if (r && r.userId !== user.id) {
      // id 是 uuid，猜中概率极低，但仍要校验——否则知道 id 的人能读到别人的对话和文件
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '这个会话不属于你');
    }
    return r;
  }

  private async workspaceForSlug(
    user: User,
    slug: string,
    current: AgentSessionRecord | null,
  ): Promise<string | null> {
    if (current?.slug === slug) return current.workspace;
    return (await this.store.workspaceForSlug(user.id, slug))
      ?? ((await this.ws.hasLegacy(user.username)) ? LEGACY_KEY : null);
  }

  /** 会话表里没有的 id：自己的目录还在就用它，否则就是改版前的会话。 */
  private async orphanWorkspace(user: User, id: string): Promise<string> {
    if (!this.ws.isKey(id)) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '会话标识不合法');
    await this.ws.ensureLayout(user.username);
    if (existsSync(this.ws.dir(user.username, id))) return id;
    return (await this.ws.hasLegacy(user.username)) ? LEGACY_KEY : id;
  }

  /** 一个都没有的人：给他开一个空的，免得预览指向一个不存在的目录。 */
  private async fresh(user: User): Promise<string> {
    return (await this.begin(user)).workspace;
  }
}
