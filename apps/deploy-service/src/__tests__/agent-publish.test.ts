import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerAgentRoutes } from '../routes/agent.js';
import type { DeployInput } from '../services/deploy.js';

/**
 * 「发布到我的空间」那一下的闸门（改版稿 §创建 · 生成）。
 *
 * ┌─ 这组用例够到哪儿，够不到哪儿 ────────────────────────────────────┐
 * │ 够得到：没登录不行、令牌不对不行、入参不合法要 4xx 不要 500、      │
 * │         待确认列表只给自己的。                                    │
 * │                                                                   │
 * │ 够不到：令牌→发布那一段。确认令牌只在 Agent 调 request_deploy 时  │
 * │         生成，而那要一条真的模型通道；把 pending 表挖个口子出来给  │
 * │         测试写，等于为了测试在发布链路上开一扇侧门——这正是二次    │
 * │         确认要防的东西。那一段靠的是人工走一遍（创建屏点发布）。  │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * DeployService 换成一个假的：真发布要磁盘、产物和数据库，而它自己那条链路
 * （扫描、base path 校验、切软链）在别处有用例。
 */
describe('确认并发布的闸门', () => {
  let app: ReturnType<typeof Fastify>;
  const deployed: DeployInput[] = [];
  const me = { id: 'u-me', username: 'lixiao', displayName: '李骁', role: 'employee' } as User;

  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const maybe = err as { validation?: unknown; issues?: unknown; message?: string };
      if (maybe.validation || maybe.issues) {
        return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT, message: maybe.message ?? '入参不合法' });
      }
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });

    registerAgentRoutes(app, {
      // 这组用例一次都不该碰库：碰了说明闸门判断跑到了它不该去的地方
      sql: (() => { throw new Error('不该查库'); }) as never,
      workspaceRoot: '/tmp/ispace-test-ws',
      requireAuth: async (req: FastifyRequest) => {
        if (req.headers['x-test-user'] !== 'me') {
          throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        }
        return me;
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
    });
    await app.ready();
  });

  afterAll(async () => { await app?.close(); });

  const post = (url: string, payload?: unknown, auth = true) =>
    app.inject({
      method: 'POST', url: `/deploy/api${url}`,
      ...(auth ? { headers: { 'x-test-user': 'me' } } : {}),
      ...(payload === undefined ? {} : { payload }),
    });

  it('没登录连门都进不去', async () => {
    expect((await post('/agent/publish', { confirmToken: 'x' }, false)).statusCode).toBe(401);
  });

  it('令牌不对就不发布，也不去碰发布链路', async () => {
    const res = await post('/agent/publish', { confirmToken: 'not-a-real-token' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe(ERROR_CODES.NOT_FOUND);
    expect(deployed).toHaveLength(0);
  });

  it('令牌过期与令牌不存在给同一句话——区分了等于告诉对方令牌存在', async () => {
    /*
      比两条消息**是否一字不差**，而不是断言里面有没有某个数字。原来写的是
      toContain('10 分钟')，于是把有效期从 10 分钟放宽到 30 分钟时这条红了
      ——它测的其实是文案里的一个常数，而它要守的是"两种情形说同一句话"。
    */
    const a = await post('/agent/publish', { confirmToken: 'not-a-real-token' });
    const b = await post('/agent/publish', { confirmToken: 'another-wrong-one' });
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json().message).toBe(b.json().message);
    /* 而且这句话要告诉人下一步干什么，不能只说"无效" */
    expect(b.json().message).toContain('重新发起');
  });

  it('缺参数是 4xx 不是 500', async () => {
    const res = await post('/agent/publish', {});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(deployed).toHaveLength(0);
  });

  it('确认（只点头、不发布）那条的判断一致', async () => {
    const res = await post('/agent/confirm', { confirmToken: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  it('待确认列表为空时是空数组，不是报错', async () => {
    const res = await app.inject({
      method: 'GET', url: '/deploy/api/agent/pending', headers: { 'x-test-user': 'me' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('状态接口在没有模型通道时也答得出来（创建页据此决定显不显示模型名）', async () => {
    const res = await app.inject({ method: 'GET', url: '/deploy/api/agent/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('configured');
  });
});
