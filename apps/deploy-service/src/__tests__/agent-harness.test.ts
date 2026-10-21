import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerAgentHarnessRoutes, snapshotsFor } from '../routes/agent-harness.js';
import { MemoryAgentStore } from '../services/agent-store.js';
import { SessionWorkspaces } from '../services/session-workspace.js';
import { Workspaces } from '../services/workspaces.js';

/**
 * 开会话、撤回、伺服工作区文件。全部不碰库、不碰模型。
 */
describe('harness 周边接口', () => {
  let app: ReturnType<typeof Fastify>;
  let sw: SessionWorkspaces;
  const busy = new Set<string>();
  const me = { id: 'u-me', username: 'lixiao' } as User;
  const other = { id: 'u-other', username: 'wangkai' } as User;
  const who: Record<string, User> = { me, other };

  beforeAll(async () => {
    sw = new SessionWorkspaces(new MemoryAgentStore(), new Workspaces(mkdtempSync(join(tmpdir(), 'ispace-h-'))));
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const maybe = err as { issues?: unknown };
      if (maybe.issues) return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT });
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerAgentHarnessRoutes(app, {
      requireAuth: async (req: FastifyRequest) => {
        const u = who[String(req.headers['x-test-user'] ?? '')];
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return u;
      },
      sessionWorkspaces: sw,
      isBusy: (id) => busy.has(id),
    });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  const post = (url: string, payload?: unknown, user = 'me') => app.inject({
    method: 'POST', url: `/deploy/api${url}`, headers: { 'x-test-user': user },
    ...(payload === undefined ? {} : { payload }),
  });
  const get = (url: string, user = 'me') =>
    app.inject({ method: 'GET', url: `/deploy/api${url}`, headers: { 'x-test-user': user } });

  const newSession = async () => (await post('/agent/session')).json().sessionId as string;

  it('开会话：每次一个新工作区，没登录不行', async () => {
    expect((await app.inject({ method: 'POST', url: '/deploy/api/agent/session' })).statusCode).toBe(401);
    const a = await newSession();
    const b = await newSession();
    expect(a).not.toBe(b);
    expect(existsSync(sw.ws.dir('lixiao', a))).toBe(true);
  });

  it('撤回：文件退回这一轮开始前，对话截回那一刻，快照用掉即删', async () => {
    const sid = await newSession();
    const dir = sw.ws.dir('lixiao', sid);
    writeFileSync(join(dir, 'index.html'), 'v1');
    const before = [{ role: 'user' as const, content: '做个周报' }, { role: 'assistant' as const, content: '好' }];
    await sw.store.save(sid, { messages: before });

    /* 模拟 /agent/ask 的一轮：开工前拍照，然后模型改了文件、多了两条消息 */
    await snapshotsFor(sw, 'lixiao', sid).take({ sessionId: sid, messageCount: 2, label: '标题改大' });
    writeFileSync(join(dir, 'index.html'), 'v2-改坏了');
    writeFileSync(join(dir, 'extra.css'), 'x');
    await sw.store.save(sid, { messages: [...before, { role: 'user', content: '标题改大' }, { role: 'assistant', content: '改了' }] });

    const res = await post('/agent/undo', { sessionId: sid });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: '标题改大', left: 0 });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('v1');
    expect(existsSync(join(dir, 'extra.css'))).toBe(false);
    expect((await sw.store.get(sid))!.messages).toEqual(before);

    const again = await post('/agent/undo', { sessionId: sid });
    expect(again.statusCode).toBe(404);
    expect(again.json().message).toContain('没有可以撤回');
  });

  it('撤回只认本人的会话；这一轮还在跑时不许撤', async () => {
    const sid = await newSession();
    expect((await post('/agent/undo', { sessionId: sid }, 'other')).statusCode).toBe(403);
    await snapshotsFor(sw, 'lixiao', sid).take({ sessionId: sid, messageCount: 0, label: 'x' });
    busy.add(sid);
    const res = await post('/agent/undo', { sessionId: sid });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('还在做');
    busy.delete(sid);
    expect((await post('/agent/undo', { sessionId: 'not-a-session' })).statusCode).toBe(404);
  });

  it('原始文件：图片内联、HTML 一律下载、nosniff；越界与别人的会话拒绝', async () => {
    const sid = await newSession();
    const dir = sw.ws.dir('lixiao', sid);
    mkdirSync(join(dir, '_uploads'));
    writeFileSync(join(dir, '_uploads', '图.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, 'evil.html'), '<script>alert(1)</script>');
    writeFileSync(join(dir, 'note.md'), '# 标题');

    const png = await get(`/agent/workspace/raw?sessionId=${sid}&path=${encodeURIComponent('_uploads/图.png')}`);
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/^inline/);
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    expect([...png.rawPayload]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const html = await get(`/agent/workspace/raw?sessionId=${sid}&path=evil.html`);
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(html.headers['content-disposition']).toMatch(/^attachment/);

    const md = await get(`/agent/workspace/raw?sessionId=${sid}&path=note.md`);
    expect(md.headers['content-type']).toContain('text/plain');
    expect(md.body).toBe('# 标题');

    expect((await get(`/agent/workspace/raw?sessionId=${sid}&path=../../x`)).statusCode).toBe(403);
    expect((await get(`/agent/workspace/raw?sessionId=${sid}&path=nope.png`)).statusCode).toBe(404);
    expect((await get(`/agent/workspace/raw?sessionId=${sid}&path=note.md`, 'other')).statusCode).toBe(403);
  });
});
