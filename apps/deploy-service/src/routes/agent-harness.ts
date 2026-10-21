import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { safePath, Snapshots } from '@ispace/agent';
import { z } from 'zod';
import type { SessionWorkspaces } from '../services/session-workspace.js';

/**
 * 创建屏 harness 的几条周边接口（docs/specs/2026-10-21-agent-harness.md）：
 *
 *   POST /agent/session          开一条会话、一个工作区
 *   POST /agent/undo             撤回这一步
 *   GET  /agent/workspace/raw    工作区里一个文件的原始字节（附件预览、生成的图）
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

  app.post(`${API_BASE}/agent/session`, async (req) => {
    const user = await requireAuth(req);
    const r = await sw.begin(user);
    return { sessionId: r.id };
  });

  /**
   * 撤回这一步。
   *
   * 退到这条会话最近拍的那张快照（每一轮开工前拍，见 routes/agent.ts），文件
   * 和对话一起退：只退文件的话，模型还记得自己"已经把标题改成红色了"，下一
   * 句话它会接着一个不存在的改动往下说。
   *
   * 用过的快照随即删掉，所以连点几次就是一步步往前退。
   */
  app.post(`${API_BASE}/agent/undo`, async (req) => {
    const user = await requireAuth(req);
    const { sessionId } = z.object({ sessionId: z.string().min(1).max(64) }).parse(req.body);
    const record = await sw.owned(user, sessionId);
    if (!record) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个会话。');
    if (isBusy(sessionId)) {
      /* 契约里没有"冲突"这个码；这确实是一次此刻不能做的请求 */
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, '这一轮还在做，等它停下来再撤回。');
    }

    const snaps = snapshotsFor(sw, user.username, record.workspace);
    const last = await snaps.lastFor(sessionId);
    if (!last) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有可以撤回的步骤了。');

    const r = await snaps.restore(last.seq);
    await sw.store.save(sessionId, { messages: record.messages.slice(0, last.messageCount) });
    await snaps.drop(last.seq);
    const left = (await snaps.list()).filter((m) => m.sessionId === sessionId).length;
    return { label: last.label, written: r.written, removed: r.removed, left };
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
