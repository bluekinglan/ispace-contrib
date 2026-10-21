import type { Sql } from '@ispace/db';
import type { EngineMessage } from '@ispace/agent';

/**
 * Agent 会话的持久化（迁移 0034）。
 *
 * ┌─ 为什么要落库 ──────────────────────────────────────────────────────┐
 * │ 会话原先只在内存里。每次部署都是一次重启，正在做页面的人回来说「再 │
 * │ 改一处」，模型已经不记得这个页面是怎么来的；刷新后工作台还显示着之 │
 * │ 前的对话，背后的上下文却是空的——人以为它记得，它其实全忘了。       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 接口而不是直接写 SQL：路由测试不起数据库（见 __tests__/agent-publish.test.ts
 * "这组用例一次都不该碰库"），用 MemoryAgentStore 顶上；线上用 PgAgentStore。
 */

export interface AgentSessionRecord {
  id: string;
  userId: string;
  /** 工作区键：/srv/workspaces/{username}/{workspace}/。见 services/workspaces.ts。 */
  workspace: string;
  /** 发布成功后才有：这条会话做出来的是哪个页面。 */
  slug: string | null;
  /** 不含 system 那一条，也不含图片字节。 */
  messages: EngineMessage[];
  updatedAt: number;
}

/** 会话列表里的一行（「历史版本」那个下拉）。不带整段消息——几十条会话的历史一起拉回来太重。 */
export interface AgentSessionSummary {
  id: string;
  workspace: string;
  slug: string | null;
  updatedAt: number;
  /** 第一条用户消息的原文，前端据此取标题。 */
  first: string;
}

export interface AgentStore {
  get(id: string): Promise<AgentSessionRecord | null>;
  create(r: { id: string; userId: string; workspace: string; slug?: string | null }): Promise<AgentSessionRecord>;
  save(id: string, patch: { messages?: EngineMessage[]; workspace?: string; slug?: string | null }): Promise<void>;
  /** 最近一条做出过这个页面的会话用的是哪个工作区。 */
  workspaceForSlug(userId: string, slug: string): Promise<string | null>;
  /** 这个人最近在做的那个工作区。给不带会话 id 的老客户端兜底。 */
  latestWorkspace(userId: string): Promise<string | null>;
  /** 清掉这么久没动过的会话。返回清了几条。 */
  prune(olderThanMs: number): Promise<number>;
  /** 这个人最近的会话，新的在前。一句话都没说过的（开了创建屏就走了）不算。 */
  listForUser(userId: string, limit: number): Promise<AgentSessionSummary[]>;
}

/** 会话保留多久。工作区文件本身不受影响，这里清的只是对话历史。 */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 存之前把图片字节去掉，在原处留一句话。
 *
 * 图有两种来源：用户贴的截图、screenshot_preview 截的页面。两种都是一次性
 * 的——模型当轮就看过了，它的判断已经落在后面的回话和改动里。存下来的话
 * 一张就是几百 KB 的 base64，下次续接还要原样发给网关重新计费。
 */
export function stripImages(messages: EngineMessage[]): EngineMessage[] {
  return messages.map((m) => {
    if (!m.images?.length) return m;
    const { images, ...rest } = m;
    return { ...rest, content: `${m.content}\n（这里原本附了 ${images.length} 张图，已不在上下文里。）`.trim() };
  });
}

export class MemoryAgentStore implements AgentStore {
  private readonly rows = new Map<string, AgentSessionRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r, messages: [...r.messages] } : null;
  }

  async create(r: { id: string; userId: string; workspace: string; slug?: string | null }) {
    const rec: AgentSessionRecord = {
      id: r.id, userId: r.userId, workspace: r.workspace, slug: r.slug ?? null,
      messages: [], updatedAt: this.now(),
    };
    this.rows.set(r.id, rec);
    return { ...rec };
  }

  async save(id: string, patch: { messages?: EngineMessage[]; workspace?: string; slug?: string | null }) {
    const r = this.rows.get(id);
    if (!r) return;
    if (patch.messages) r.messages = stripImages(patch.messages);
    if (patch.workspace !== undefined) r.workspace = patch.workspace;
    if (patch.slug !== undefined) r.slug = patch.slug;
    r.updatedAt = this.now();
  }

  async workspaceForSlug(userId: string, slug: string) {
    return this.latest((r) => r.userId === userId && r.slug === slug)?.workspace ?? null;
  }

  async latestWorkspace(userId: string) {
    return this.latest((r) => r.userId === userId)?.workspace ?? null;
  }

  async prune(olderThanMs: number) {
    const cut = this.now() - olderThanMs;
    let n = 0;
    for (const [k, r] of this.rows) if (r.updatedAt < cut) { this.rows.delete(k); n += 1; }
    return n;
  }

  async listForUser(userId: string, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && r.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((r) => ({
        id: r.id, workspace: r.workspace, slug: r.slug, updatedAt: r.updatedAt,
        first: r.messages.find((m) => m.role === 'user')?.content ?? '',
      }));
  }

  get size(): number { return this.rows.size; }

  private latest(pred: (r: AgentSessionRecord) => boolean): AgentSessionRecord | undefined {
    let best: AgentSessionRecord | undefined;
    for (const r of this.rows.values()) if (pred(r) && (!best || r.updatedAt >= best.updatedAt)) best = r;
    return best;
  }
}

interface Row {
  id: string;
  user_id: string;
  workspace: string;
  slug: string | null;
  messages: EngineMessage[];
  updated_at: Date;
}

const toRecord = (r: Row): AgentSessionRecord => ({
  id: r.id, userId: r.user_id, workspace: r.workspace, slug: r.slug,
  messages: Array.isArray(r.messages) ? r.messages : [],
  updatedAt: r.updated_at.getTime(),
});

/**
 * ⚠️ 写 jsonb 一律 `sql.json(值)`，不要 `${JSON.stringify(值)}::jsonb`——后者
 * 会被驱动再序列化一次，存进去的是一个字符串标量（见 routes/events.ts 顶上
 * 那段踩坑记录）。
 */
export class PgAgentStore implements AgentStore {
  constructor(private readonly sql: Sql) {}

  async get(id: string) {
    const rows = await this.sql<Row[]>`
      SELECT id, user_id, workspace, slug, messages, updated_at
        FROM ispace.agent_sessions WHERE id = ${id}
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(r: { id: string; userId: string; workspace: string; slug?: string | null }) {
    const rows = await this.sql<Row[]>`
      INSERT INTO ispace.agent_sessions (id, user_id, workspace, slug)
      VALUES (${r.id}, ${r.userId}, ${r.workspace}, ${r.slug ?? null})
      RETURNING id, user_id, workspace, slug, messages, updated_at
    `;
    return toRecord(rows[0]!);
  }

  async save(id: string, patch: { messages?: EngineMessage[]; workspace?: string; slug?: string | null }) {
    const messages = patch.messages ? this.sql.json(stripImages(patch.messages) as never) : null;
    /*
      COALESCE 让"没给的字段不动"。slug 要能显式写回 null 的场景目前没有
      （发布只会绑定、不会解绑），所以同样按"没给不动"处理。
    */
    await this.sql`
      UPDATE ispace.agent_sessions SET
        messages   = COALESCE(${messages}, messages),
        workspace  = COALESCE(${patch.workspace ?? null}, workspace),
        slug       = COALESCE(${patch.slug ?? null}, slug),
        updated_at = now()
      WHERE id = ${id}
    `;
  }

  async workspaceForSlug(userId: string, slug: string) {
    const rows = await this.sql<{ workspace: string }[]>`
      SELECT workspace FROM ispace.agent_sessions
       WHERE user_id = ${userId} AND slug = ${slug}
       ORDER BY updated_at DESC LIMIT 1
    `;
    return rows[0]?.workspace ?? null;
  }

  async latestWorkspace(userId: string) {
    const rows = await this.sql<{ workspace: string }[]>`
      SELECT workspace FROM ispace.agent_sessions
       WHERE user_id = ${userId}
       ORDER BY updated_at DESC LIMIT 1
    `;
    return rows[0]?.workspace ?? null;
  }

  async listForUser(userId: string, limit: number) {
    /* 只取第一条消息的 content，不把整段 jsonb 拉回来 */
    const rows = await this.sql<{ id: string; workspace: string; slug: string | null; updated_at: Date; first: string | null }[]>`
      SELECT id, workspace, slug, updated_at, messages->0->>'content' AS first
        FROM ispace.agent_sessions
       WHERE user_id = ${userId} AND jsonb_array_length(messages) > 0
       ORDER BY updated_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id, workspace: r.workspace, slug: r.slug, updatedAt: r.updated_at.getTime(), first: r.first ?? '',
    }));
  }

  async prune(olderThanMs: number) {
    const rows = await this.sql`
      DELETE FROM ispace.agent_sessions
       WHERE updated_at < now() - make_interval(secs => ${olderThanMs / 1000})
      RETURNING id
    `;
    return rows.length;
  }
}
