import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerAgentRoutes } from '../routes/agent.js';
import type { DeployInput } from '../services/deploy.js';
import { MemoryAgentStore } from '../services/agent-store.js';
import { SessionWorkspaces } from '../services/session-workspace.js';
import { Workspaces } from '../services/workspaces.js';
import { tempStorage } from './release-fixture.js';

/**
 * iDo 工作台的「发布」（/agent/publish-session）：不要确认令牌。
 *
 * 令牌是给"人不在界面前"的那条路用的（手机壳、外部 AI）。工作台里人点
 * 发布这一下就是确认，所以这条路由不收令牌——但别的闸门一道不能少：
 *   - 只能发本人的会话、发这段会话自己的工作区
 *   - 工作区里得真有页面
 *   - 地址被本人别的页面占着时，要明说覆盖
 */

/** 只认一种查询：按 owner + slug 找页面。叫 taken 的地址上"已经有页面"。 */
const fakeSql = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('?').includes('FROM ispace.apps WHERE owner_id') && values[1] === 'taken') {
      return [{ id: 'app-taken', owner_id: 'u-me', slug: 'taken', name: '老页面', size_bytes: 0 }];
    }
    return [];
  },
  { json: (x: unknown) => x },
) as never;

describe('工作台发布：点了就发，不要令牌', () => {
  let app: ReturnType<typeof Fastify>;
  let sw: SessionWorkspaces;
  const deployed: DeployInput[] = [];
  const me = { id: 'u-me', username: 'lixiao' } as User;
  const other = { id: 'u-other', username: 'wangke' } as User;

  beforeAll(async () => {
    sw = new SessionWorkspaces(
      new MemoryAgentStore(),
      new Workspaces(mkdtempSync(join(tmpdir(), 'ispace-pubsess-'))),
      tempStorage(),
    );
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const maybe = err as { issues?: unknown };
      if (maybe.issues) return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT });
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerAgentRoutes(app, {
      sql: fakeSql,
      workspaceRoot: '/unused',
      sessionWorkspaces: sw,
      requireAuth: async (req: FastifyRequest) => {
        if (req.headers['x-test-user'] === 'me') return me;
        if (req.headers['x-test-user'] === 'other') return other;
        throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
      },
      deployService: {
        deploy: async (input) => {
          deployed.push(input);
          return {
            app: { id: 'app-1', slug: input.slug } as never,
            release: { id: 'rel-1' } as never,
            url: `http://localhost/${input.user.username}/${input.slug}/`,
          };
        },
      },
      screenshot: null,
    });
    await app.ready();
  });

  afterAll(async () => { await app?.close(); });

  const post = (url: string, payload: unknown, who: 'me' | 'other' | null = 'me') =>
    app.inject({
      method: 'POST', url: `/deploy/api${url}`,
      ...(who ? { headers: { 'x-test-user': who } } : {}),
      payload: payload as never,
    });

  /** 开一条会话，并在它的工作区里放一个首页（相当于模型已经写完第一版）。 */
  const sessionWithPage = async (html = '<h1>周报</h1>') => {
    const sid = (await post('/agent/session', {})).json().sessionId as string;
    const rec = await sw.store.get(sid);
    writeFileSync(join(sw.ws.dir(me.username, rec!.workspace), 'index.html'), html);
    return { sid, dir: sw.ws.dir(me.username, rec!.workspace) };
  };

  it('不带令牌就能发，发的是这段会话自己的工作区，并记下地址', async () => {
    const { sid, dir } = await sessionWithPage();
    const res = await post('/agent/publish-session', { sessionId: sid, site: 'zhoubao', name: '周报' });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain('/lixiao/zhoubao/');
    const last = deployed[deployed.length - 1]!;
    expect(last.srcDir).toBe(dir);
    expect(last.slug).toBe('zhoubao');
    expect((await sw.store.get(sid))?.slug).toBe('zhoubao');

    /* 再点一次发布不用再填地址：就是更新这个页面 */
    const again = await post('/agent/publish-session', { sessionId: sid });
    expect(again.statusCode).toBe(200);
    expect(deployed[deployed.length - 1]!.slug).toBe('zhoubao');
  });

  it('没登录不行；别人的会话不行', async () => {
    const { sid } = await sessionWithPage();
    const n = deployed.length;
    expect((await post('/agent/publish-session', { sessionId: sid, site: 'a1' }, null)).statusCode).toBe(401);
    expect((await post('/agent/publish-session', { sessionId: sid, site: 'a1' }, 'other')).statusCode).toBe(403);
    expect(deployed).toHaveLength(n);
  });

  it('工作区里还没有页面时不发，并说清楚为什么', async () => {
    const sid = (await post('/agent/session', {})).json().sessionId as string;
    const res = await post('/agent/publish-session', { sessionId: sid, site: 'kong' });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('index.html');
  });

  it('没地址、地址不合法，都是 4xx', async () => {
    const { sid } = await sessionWithPage();
    expect((await post('/agent/publish-session', { sessionId: sid })).statusCode).toBe(422);
    expect((await post('/agent/publish-session', { sessionId: sid, site: 'Bad_Slug' })).statusCode).toBe(422);
  });

  it('地址上已经有别的页面：先拦下来，明说覆盖才发', async () => {
    const { sid } = await sessionWithPage();
    const n = deployed.length;
    const blocked = await post('/agent/publish-session', { sessionId: sid, site: 'taken' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain('老页面');
    expect(deployed).toHaveLength(n);

    const ok = await post('/agent/publish-session', { sessionId: sid, site: 'taken', overwrite: true });
    expect(ok.statusCode).toBe(200);
    expect(deployed).toHaveLength(n + 1);
  });
});
