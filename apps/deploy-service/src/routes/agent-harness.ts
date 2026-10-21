import { createReadStream } from 'node:fs';
import { cp, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { safePath, Snapshots } from '@ispace/agent';
import { z } from 'zod';
import type { AgentSessionRecord } from '../services/agent-store.js';
import type { SessionWorkspaces } from '../services/session-workspace.js';
import { sessionTitle, toView } from '../services/session-view.js';
import { zipDir } from '../services/zip.js';
import { extractZip } from '@ispace/storage';

/**
 * 创建屏 harness 的几条周边接口（docs/specs/2026-10-21-agent-harness.md）：
 *
 *   POST /agent/session            开一条会话、一个工作区
 *   GET  /agent/sessions           我最近的会话（左上角「历史版本」）
 *   GET  /agent/session/:id        一条会话的对话流，点开历史会话时摆回来
 *   POST /agent/session/:id/fork   复制成一个新页面（「更多 → 复制为新页面」）
 *   GET  /agent/versions           这条会话的每一步快照（右上角「版本记录」）
 *   POST /agent/restore            退回到某一步之前；POST /agent/undo 是退一步的特例
 *   GET  /agent/workspace/raw      工作区里一个文件的原始字节（附件预览、生成的图）
 *   GET  /agent/workspace/zip      整个工作区打成 zip（「更多 → 导出代码」）
 *
 * 和对话本身（routes/agent.ts 的 /agent/ask）分开放，是因为它们都不碰模型：
 * 只是会话、工作区、快照三样东西的增删查。
 */

/** 原样伺服、可以在页面里直接显示的类型。其余一律当下载。 */
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', tsv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
};

/** 预览里最多伺服多大的文件。附件上限是 10 MB，生成的图约 2 MB。 */
const MAX_RAW_BYTES = 20 * 1024 * 1024;

export function snapshotsFor(sw: SessionWorkspaces, username: string, workspace: string): Snapshots {
  return new Snapshots(sw.ws.snapshotDir(username, workspace), sw.ws.dir(username, workspace));
}

/**
 * 导入代码包的限额。比发布链路那档小：那边解的是一次性产物，这边解进的是
 * 人的工作区，而工作区本身只有 500 MB 配额——一个包就不该把它占满。
 */
const IMPORT_LIMITS = { maxTotalBytes: 50 * 1024 * 1024, maxEntries: 3000 };

export function registerAgentHarnessRoutes(
  app: FastifyInstance,
  deps: {
    requireAuth: (req: FastifyRequest) => Promise<User>;
    sessionWorkspaces: SessionWorkspaces;
    /** 这条会话此刻是不是正在跑一轮。正在跑的时候不许撤回——撤回的快照和正在写的文件会打架。 */
    isBusy: (sessionId: string) => boolean;
  },
): void {
  const { requireAuth, sessionWorkspaces: sw, isBusy } = deps;

  /** 这条会话必须存在、必须是本人的。 */
  async function mine(user: User, sessionId: string): Promise<AgentSessionRecord> {
    const r = await sw.owned(user, sessionId);
    if (!r) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个会话。');
    return r;
  }

  /** 正在跑一轮的会话不许动它的工作区——快照、复制都会和正在写的文件打架。 */
  function notBusy(sessionId: string, message: string): void {
    /* 契约里没有"冲突"这个码；这确实是一次此刻不能做的请求 */
    if (isBusy(sessionId)) throw new IspaceError(ERROR_CODES.INVALID_INPUT, message);
  }

  app.post(`${API_BASE}/agent/session`, async (req) => {
    const user = await requireAuth(req);
    const r = await sw.begin(user);
    return { sessionId: r.id };
  });

  /** 历史会话最多列这么多条。再往前的，人多半也不记得是什么了。 */
  const MAX_SESSIONS = 30;

  /**
   * 我最近的会话（左上角「历史版本」）。
   *
   * 会话落库之前这个下拉没法做——会话活在内存里，一次部署就没了。现在每条会话
   * 带着自己的工作区和完整对话，点开就能接着做。
   */
  app.get(`${API_BASE}/agent/sessions`, async (req) => {
    const user = await requireAuth(req);
    const rows = await sw.store.listForUser(user.id, MAX_SESSIONS);
    return {
      items: rows.map((r) => ({ id: r.id, title: sessionTitle(r.first), slug: r.slug, updatedAt: r.updatedAt })),
    };
  });

  /** 一条会话的对话流（给人看的那份，见 services/session-view.ts）。 */
  app.get(`${API_BASE}/agent/session/:id`, async (req) => {
    const user = await requireAuth(req);
    const r = await mine(user, (req.params as { id: string }).id);
    return {
      id: r.id, slug: r.slug, updatedAt: r.updatedAt,
      title: sessionTitle(r.messages.find((m) => m.role === 'user')?.content ?? ''),
      says: toView(r.messages),
    };
  });

  /**
   * 复制成一个新页面：文件原样拷进一个新工作区，对话从头开始。
   *
   * 对话不跟着拷：新页面要往哪儿改是一件新的事，把旧页面的十几轮来回带过去，
   * 模型会以为还在改原来那个。文件都在，它 list_files 一下就知道现在有什么。
   * 快照也不拷——它们记的是另一条会话的步骤，撤回不该退到别人的历史里去。
   */
  app.post(`${API_BASE}/agent/session/:id/fork`, async (req) => {
    const user = await requireAuth(req);
    const src = await mine(user, (req.params as { id: string }).id);
    notBusy(src.id, '这一轮还在做，等它停下来再复制。');
    const next = await sw.begin(user);
    await cp(sw.ws.dir(user.username, src.workspace), sw.ws.dir(user.username, next.workspace), {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p),
    }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    return { sessionId: next.id };
  });

  /** 这条会话的每一步（右上角「版本记录」），新的在前。 */
  app.get(`${API_BASE}/agent/versions`, async (req) => {
    const user = await requireAuth(req);
    const { sessionId } = z.object({ sessionId: z.string().min(1).max(64) }).parse(req.query);
    const r = await mine(user, sessionId);
    const items = (await snapshotsFor(sw, user.username, r.workspace).list())
      .filter((m) => m.sessionId === sessionId)
      .reverse()
      .map((m) => ({ seq: m.seq, label: m.label, at: m.at }));
    return { items };
  });

  /**
   * 退回到第 seq 步之前：文件回到那一步开工前的样子，对话截回那一刻，那一步和
   * 它之后的快照全部作废（它们记的是已经不存在的未来）。
   *
   * 文件和对话一起退：只退文件的话，模型还记得自己"已经把标题改成红色了"，下一
   * 句话它会接着一个不存在的改动往下说。
   */
  async function restoreTo(user: User, record: AgentSessionRecord, seq: number | 'last') {
    notBusy(record.id, '这一轮还在做，等它停下来再撤回。');
    const snaps = snapshotsFor(sw, user.username, record.workspace);
    const own = (await snaps.list()).filter((m) => m.sessionId === record.id);
    const target = seq === 'last' ? own.at(-1) : own.find((m) => m.seq === seq);
    if (!target) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, seq === 'last' ? '没有可以撤回的步骤了。' : '没有这一步的记录了。');
    }
    const r = await snaps.restore(target.seq);
    await sw.store.save(record.id, { messages: record.messages.slice(0, target.messageCount) });
    await snaps.drop(...own.filter((m) => m.seq >= target.seq).map((m) => m.seq));
    const left = own.filter((m) => m.seq < target.seq).length;
    return { label: target.label, written: r.written, removed: r.removed, left };
  }

  app.post(`${API_BASE}/agent/restore`, async (req) => {
    const user = await requireAuth(req);
    const { sessionId, seq } = z.object({
      sessionId: z.string().min(1).max(64), seq: z.number().int().positive(),
    }).parse(req.body);
    return restoreTo(user, await mine(user, sessionId), seq);
  });

  /** 撤回这一步：退回到最近那一步之前。连点就一步步往前退。 */
  app.post(`${API_BASE}/agent/undo`, async (req) => {
    const user = await requireAuth(req);
    const { sessionId } = z.object({ sessionId: z.string().min(1).max(64) }).parse(req.body);
    return restoreTo(user, await mine(user, sessionId), 'last');
  });

  /**
   * 整个工作区打成 zip（「更多 → 导出代码」）。
   *
   * 不打平台草稿与附件（顶层 _ 开头）、node_modules、.git——和发布链路认的"页面产物"
   * 是同一条线：导出来的就是发布出去的那些东西，人拿回去能原样跑。
   */
  app.get(`${API_BASE}/agent/workspace/zip`, async (req, reply) => {
    const user = await requireAuth(req);
    const q = z.object({ sessionId: z.string().min(1).max(64), name: z.string().max(60).optional() }).parse(req.query);
    const r = await mine(user, q.sessionId);
    const buf = await zipDir(sw.ws.dir(user.username, r.workspace), (rel) => {
      const first = rel.split('/')[0] ?? '';
      return !first.startsWith('_') && !/(^|\/)(node_modules|\.git)(\/|$)/.test(rel);
    });
    if (!buf) throw new IspaceError(ERROR_CODES.NOT_FOUND, '工作区还是空的，没有可导出的文件。');
    const base = (q.name || r.slug || 'ispace-page').replace(/[\\/:*?"<>|]/g, '_');
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}.zip`)
      .header('cache-control', 'private, no-store')
      .send(buf);
  });

  /**
   * 把已有的代码包导进来接着改（改版稿「把已有的代码包导进来接着改」）。
   *
   * ┌─ 为什么敢把用户的 zip 解到工作区里 ─────────────────────────────────┐
   * │ 解压用的是 @ispace/storage 的 extractZip —— 发布链路解用户产物用的  │
   * │ 就是它：条目归一化后必须仍落在目标目录内（挡 ../../etc/passwd 和    │
   * │ Windows 风格的 ..\ 与绝对路径），条目数与总字节都有上限。         │
   * │ 这里不另写一份解压，正是因为那一份已经被发布链路验过。             │
   * └──────────────────────────────────────────────────────────────────────┘
   *
   * 限额比发布链路小一档：那边解的是一次性产物，这边解进的是人的工作区，
   * 而工作区本身有 500 MB 配额。
   */
  app.post(`${API_BASE}/agent/workspace/import`, async (req) => {
    const user = await requireAuth(req);
    const file = await req.file();
    if (!file) throw new IspaceError(ERROR_CODES.INVALID_ARTIFACT, '没收到代码包。');

    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const { sessionId } = z
      .object({ sessionId: z.string().min(1).max(64) })
      .parse({ sessionId: fields.sessionId?.value });
    const r = await mine(user, sessionId);
    /* 正在跑一轮时不许导入：解出来的文件会和模型正在写的打架 */
    notBusy(sessionId, '这一轮还在做，等它完了再导入。');

    const tmp = await mkdtemp(join(tmpdir(), 'ispace-import-'));
    const zipPath = join(tmp, 'in.zip');
    try {
      await writeFile(zipPath, await file.toBuffer());
      const out = await extractZip(zipPath, sw.ws.dir(user.username, r.workspace), IMPORT_LIMITS);
      return { ok: true, files: out.files.length, bytes: out.totalBytes };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /**
   * 工作区里一个文件的原始字节。
   *
   * ⚠️ 这是在 portal 同源下伺服用户（和模型）放进来的文件，必须当成不可信内容：
   *   - 只有图片、PDF、纯文本可以内联；HTML、SVG 一律 attachment——同源下内联
   *     一个 HTML 等于让它拿着用户的登录态跑脚本
   *   - nosniff，不让浏览器把一个 .png 猜成 HTML
   *   - 文本类型强制 text/plain，md 的预览由前端解析后画（apps/portal/src/md.ts）
   */
  app.get(`${API_BASE}/agent/workspace/raw`, async (req, reply) => {
    const user = await requireAuth(req);
    const q = z.object({
      path: z.string().min(1).max(512),
      sessionId: z.string().max(64).optional(),
    }).parse(req.query);
    const key = await sw.peek(user, q.sessionId);
    if (!key) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个文件。');
    const abs = safePath({ root: sw.ws.dir(user.username, key), username: user.username }, q.path);

    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个文件。');
    if (st.size > MAX_RAW_BYTES) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '文件太大，不在这里伺服。');

    const ext = q.path.toLowerCase().split('.').pop() ?? '';
    const type = INLINE_TYPES[ext];
    const name = encodeURIComponent(q.path.split('/').pop() ?? 'file');
    return reply
      .header('content-type', type ?? 'application/octet-stream')
      .header('content-disposition', `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-length', String(st.size))
      .send(createReadStream(abs));
  });
}
