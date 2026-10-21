import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@ispace/contracts';
import { registerPreviewRoutes } from '../routes/preview.js';
import { PreviewSessions } from '../services/preview-session.js';

/**
 * 按页面分工作区之后，预览跟着创建屏那条会话的工作区走。
 *
 * 一个人同时有两个工作区时，右边必须显示左边正在改的那个——否则人看着
 * 上一个页面，以为模型什么都没改。
 */
describe('预览指向会话的工作区', () => {
  let app: ReturnType<typeof Fastify>;
  const me = { id: 'u-me', username: 'lixiao' } as User;
  const asked: (string | undefined)[] = [];

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'ispace-pvw-'));
    for (const k of ['aaa', 'bbb']) {
      mkdirSync(join(root, 'lixiao', k), { recursive: true });
      writeFileSync(join(root, 'lixiao', k, 'index.html'), `<h1>工作区 ${k}</h1>`);
    }
    app = Fastify();
    registerPreviewRoutes(app, {
      requireAuth: async () => me,
      workspaceRoot: root,
      sessions: new PreviewSessions(),
      workspaceDir: async (_u, sessionId) => {
        asked.push(sessionId);
        return join(root, 'lixiao', sessionId === 's-b' ? 'bbb' : 'aaa');
      },
    });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  const open = (payload?: unknown) => app.inject({
    method: 'POST', url: '/deploy/api/preview-session', ...(payload ? { payload } : {}),
  });

  it('带会话 id 开预览，伺服的就是那条会话的工作区', async () => {
    const r = (await open({ sessionId: 's-b' })).json() as { url: string; previewId: string };
    const page = await app.inject({ method: 'GET', url: r.url });
    expect(page.body).toContain('工作区 bbb');
    const kind = await app.inject({ method: 'GET', url: `/deploy/api/preview-session/${r.previewId}/kind` });
    expect(kind.json().kind).toBe('static');
  });

  it('老客户端不带 body 也开得了，交给解析器决定指向哪个', async () => {
    const res = await open();
    expect(res.statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: (res.json() as { url: string }).url });
    expect(page.body).toContain('工作区 aaa');
    expect(asked.at(-1)).toBeUndefined();
  });
});
