import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import type { StorageConfig } from '@ispace/storage';
import type { AgentSessionRecord, AgentStore } from './agent-store.js';
import { copyRelease, liveRelease, type SeedOutcome } from './release-seed.js';
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
 *     → 最近一次把它发布出去的那个工作区；没有这样的记录，就从它的线上版本
 *       拷一份出来（services/release-seed.ts），当场把 slug 绑上；线上没有、
 *       或者拷不全，才落到 legacy（改版前所有页面都是从那里发出去的），再没有
 *       就用会话自己的
 *   带着一个会话表里没有的 id
 *     → 先看 {username}/{id}/ 在不在（会话过了保留期被清掉，工作区还在），
 *       不在就是改版前的会话——刷新前开着的工作台带着它回来，接回 legacy
 *   不带会话 id 的老客户端（部署那一刻开着的页面）
 *     → 这个人最近在做的那个；一个都没有就 legacy
 *
 * 为什么线上版本排在 legacy 前面：legacy 里所有改版前的页面叠在一起，
 * index.html 是最后做的那个页面的。改 /zhoubao/ 却照着它改、再发出去，
 * /zhoubao/ 就被换成了另一个页面。线上那份才一定是这个页面。
 */
export class SessionWorkspaces {
  /**
   * @param releases 线上版本在哪（/srv/sites、/srv/releases）。不给就不从线上拷——
   *                 路由单测走这一支，行为和加这条规则之前一样。
   */
  constructor(
    readonly store: AgentStore,
    readonly ws: Workspaces,
    private readonly releases: StorageConfig | null = null,
  ) {}

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
   * 按上一个页面的文件说话。seed 是"这一句从线上版本拷过一份"的结果（没拷
   * 就是 null）：拷成了要告诉模型这些文件哪来的；没拷成要告诉它为什么——
   * 它在别处做完再发，会整页替换线上那个它没见过的版本。
   */
  async forAsk(
    user: User,
    opts: { sessionId?: string | undefined; targetSlug?: string | undefined },
  ): Promise<{ record: AgentSessionRecord; switched: boolean; seed: SeedOutcome | null }> {
    let record = opts.sessionId ? await this.owned(user, opts.sessionId) : null;
    const target = opts.targetSlug ? await this.workspaceForSlug(user, opts.targetSlug, record) : null;
    const wanted = target?.key ?? null;
    const seed = target?.seed ?? null;
    /*
      刚从线上拷出来的工作区当场绑上 slug，不等发布：下一句、下一条会话再说
      「改 /zhoubao/」要找回的就是它，否则每说一句都拷一份新的，前面改的
      全不见了。
    */
    const bind = seed?.ok ? opts.targetSlug : undefined;

    if (!record) {
      const id = opts.sessionId ?? randomUUID();
      const workspace = wanted ?? (opts.sessionId ? await this.orphanWorkspace(user, id) : id);
      await this.ws.open(user.username, workspace);
      record = await this.store.create({ id, userId: user.id, workspace, slug: bind ?? null });
      return { record, switched: false, seed };
    }

    if (wanted && wanted !== record.workspace) {
      await this.ws.open(user.username, wanted);
      await this.store.save(record.id, { workspace: wanted, ...(bind ? { slug: bind } : {}) });
      return { record: { ...record, workspace: wanted, slug: bind ?? record.slug }, switched: true, seed };
    }
    await this.ws.open(user.username, record.workspace);
    return { record, switched: false, seed };
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
  ): Promise<{ key: string | null; seed: SeedOutcome | null }> {
    if (current?.slug === slug) return { key: current.workspace, seed: null };
    const bound = await this.store.workspaceForSlug(user.id, slug);
    if (bound) return { key: bound, seed: null };

    const seeded = await this.seedFromRelease(user, slug);
    if (seeded?.key) return seeded;
    const fallback = (await this.ws.hasLegacy(user.username)) ? LEGACY_KEY : null;
    return { key: fallback, seed: seeded?.seed ?? null };
  }

  /**
   * 从这个人这个页面的线上版本拷出一个新工作区。线上没有这个页面返回 null
   * （没什么可说的）；有但拷不了，返回原因、不建工作区。
   *
   * 只用 user.username 拼路径，slug 在 liveRelease 里校验过——这里永远碰不到
   * 别人的目录。新工作区的键是新的 uuid，不借会话 id：带着一个陌生会话 id 来时，
   * 那个 id 的目录可能还在（见 orphanWorkspace），不能往里倒。
   *
   * 拷的过程中出错（权限、盘满）也只当"没拷成"：这是锦上添花，不该让人连话
   * 都说不了。原因带回去，路由会记日志。
   */
  private async seedFromRelease(
    user: User,
    slug: string,
  ): Promise<{ key: string | null; seed: SeedOutcome } | null> {
    if (!this.releases) return null;
    const src = await liveRelease(this.releases, user.username, slug);
    if (!src) return null;

    const key = randomUUID();
    const staging = await this.ws.staging(user.username, key);
    try {
      const seed = await copyRelease(src, staging);
      if (!seed.ok) return { key: null, seed };
      await rename(staging, this.ws.dir(user.username, key));
      return { key, seed };
    } catch (e) {
      return { key: null, seed: { ok: false, reason: `拷线上版本时出错：${(e as Error).message}` } };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
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
