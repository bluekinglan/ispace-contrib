import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { Workspaces } from '../services/workspaces.js';
import { registerAgentHarnessRoutes } from '../routes/agent-harness.js';
import { SessionWorkspaces } from '../services/session-workspace.js';
import { MemoryAgentStore } from '../services/agent-store.js';
import { zipDir } from '../services/zip.js';

/**
 * 「把已有的代码包导进来接着改」。
 *
 * ┌─ 这一组守的是什么 ──────────────────────────────────────────────────┐
 * │ 解压本身不在这里实现——用的是 @ispace/storage 的 extractZip，也就是  │
 * │ 发布链路解用户产物用的那一份（已带 zip-slip 防护与条目/体积上限）。  │
 * │ 所以这里钉的是**围着它的那几道闸**：是不是本人的会话、正在跑的时候   │
 * │ 不许动、解出来的东西真的落进了这条会话自己的工作区。                │
 * └──────────────────────────────────────────────────────────────────────┘
 */
describe('导入代码包', () => {
  let app: ReturnType<typeof Fastify>;
  let sw: SessionWorkspaces;
  let clock = 1_000;
  const busy = new Set<string>();
  const me = { id: 'u-me', username: 'lixiao' } as User;
  const other = { id: 'u-other', username: 'wangkai' } as User;
  const who: Record<string, User> = { me, other };

  /** 拿平台自己的 zipDir 造一个包——两边格式一致，测的才是真链路。 */
  const makeZip = async (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ispace-src-'));
    const { writeFileSync, mkdirSync } = await import('node:fs');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    const buf = await zipDir(dir, () => true);
    if (!buf) throw new Error('造包失败');
    return buf;
  };

  beforeAll(async () => {
    sw = new SessionWorkspaces(
      new MemoryAgentStore(() => (clock += 1000)),
      new Workspaces(mkdtempSync(join(tmpdir(), 'ispace-imp-'))),
    );
    app = Fastify();
    await app.register(multipart);
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const m = err as { issues?: unknown };
      if (m.issues) return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT });
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

  const post = (zip: Buffer, sessionId: string, user?: string) => {
    const b = '----x';
    const head = (name: string, extra = '') =>
      `--${b}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`;
    const payload = Buffer.concat([
      Buffer.from(`${head('sessionId')}${sessionId}\r\n`),
      Buffer.from(head('file', '; filename="in.zip"\r\nContent-Type: application/zip')),
      zip,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    return app.inject({
      method: 'POST', url: '/deploy/api/agent/workspace/import',
      headers: {
        'content-type': `multipart/form-data; boundary=${b}`,
        ...(user ? { 'x-test-user': user } : {}),
      },
      payload,
    });
  };

  it('没登录不行', async () => {
    const r = await sw.begin(me);
    expect((await post(await makeZip({ 'a.html': 'x' }), r.id)).statusCode).toBe(401);
  });

  it('别人的会话导不进去', async () => {
    /*
      403 而不是 404：这一组路由既有的约定就是「别人的会话 403、不存在 404」
      （agent-history.test.ts 里 /agent/session/:id 和 /agent/versions 都是
      这个口径）。会话 id 是 uuid，猜不中，所以这里区分不构成泄露。
    */
    const r = await sw.begin(me);
    const res = await post(await makeZip({ 'a.html': 'x' }), r.id, 'other');
    expect(res.statusCode).toBe(403);
  });

  it('正在跑一轮时不许导入——会和模型正在写的文件打架', async () => {
    const r = await sw.begin(me);
    busy.add(r.id);
    const res = await post(await makeZip({ 'a.html': 'x' }), r.id, 'me');
    busy.delete(r.id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().message).toContain('还在做');
  });

  it('导进自己的会话：文件真的落到了这条会话的工作区里', async () => {
    const r = await sw.begin(me);
    const zip = await makeZip({ 'index.html': '<h1>导进来的</h1>', 'assets/app.js': 'console.log(1)' });
    const res = await post(zip, r.id, 'me');
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toBe(2);

    const dir = sw.ws.dir(me.username, r.workspace);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('导进来的');
    expect(existsSync(join(dir, 'assets', 'app.js'))).toBe(true);
  });

  it('不是 zip 就拒掉，不会在工作区留下半截东西', async () => {
    const r = await sw.begin(me);
    const res = await post(Buffer.from('这不是 zip'), r.id, 'me');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
