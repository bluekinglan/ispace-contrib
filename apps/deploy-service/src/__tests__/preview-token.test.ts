import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerConnectorRoutes } from '../routes/connectors.js';
import { PreviewSessions } from '../services/preview-session.js';
import { makePreviewAuth } from '../services/preview-auth.js';
import { injectPreviewShim } from '../services/preview-shim.js';

/**
 * 预览取数令牌（方案 §5.2）。
 *
 * ┌─ 这一组用例守的是整个 L2 的安全支点 ────────────────────────────────┐
 * │ 预览页面跑在 sandbox 的 opaque origin 里，Origin 头是字符串 null。   │
 * │ 为了让它取得到数，/preview-data/connect 这条路要为 null origin 开    │
 * │ CORS。而 `Origin: null` **不是"我们的预览"的标识**——任何网站开一个  │
 * │ 沙箱 iframe 发出的请求都长这样。                                     │
 * │                                                                      │
 * │ 所以这条路必须**只认 Bearer、完全不看 cookie**，而且绝不能带          │
 * │ Access-Control-Allow-Credentials。两者凑齐就等于：随便哪个外站放一个  │
 * │ 沙箱 iframe，就能带着用户的平台会话打我们的接口。                     │
 * │                                                                      │
 * │ 下面「带 cookie 不带 Bearer 必须 401」那一条是这里最重要的用例。     │
 * └──────────────────────────────────────────────────────────────────────┘
 */
describe('预览取数令牌', () => {
  let app: ReturnType<typeof Fastify>;
  let sessions: PreviewSessions;
  let token: string;

  const me = {
    id: 'u-me', username: 'lixiao', displayName: '李骁',
    role: 'employee', status: 'active',
  } as User;

  /** 假的 sql：这一组只验闸门，走到真查连接器就说明判断跑过头了。 */
  const fakeSql = (() => {
    const q = async () => [] as unknown[];
    return Object.assign(q, { json: (v: unknown) => v });
  })() as never;

  beforeAll(async () => {
    sessions = new PreviewSessions();
    token = sessions.open(me.id, me.username).token;

    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });

    registerConnectorRoutes(app, {
      sql: fakeSql,
      /* 正门：靠一个假 cookie 判「登录了」。 */
      requireAuth: async (req: FastifyRequest) => {
        if (req.headers.cookie?.includes('isp_session=')) return me;
        throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
      },
      requireAdmin: async () => { throw new IspaceError(ERROR_CODES.FORBIDDEN, '不是管理员'); },
      /*
        侧门：真实现。它只读 Authorization，查库那一步换成本地的假用户
        ——这一组要验的是「凭据怎么认」，不是「用户表长什么样」。
      */
      previewAuth: makePreviewAuth(sessions, Object.assign(
        async () => [{ id: me.id, username: me.username, status: 'active' }],
        { json: (v: unknown) => v },
      ) as never),
    });
    await app.ready();
  });

  afterAll(async () => { await app?.close(); });

  const call = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.inject({ method: method as 'GET', url, headers });

  /*
    刻意用一个**内置目录里一定没有**的短名。目录里 authKind 为 none 的条目
    （open-meteo 这些）即使没登记也会被回落命中，那就会真去发一次外网请求
    ——一组只验闸门的用例不该连网，更不该因为以后有人往目录里加了条目而变味。
  */
  const DATA = '/deploy/api/preview-data/connect/nosuch-connector';

  it('没有任何凭据 → 401', async () => {
    expect((await call(DATA)).statusCode).toBe(401);
  });

  it('**带 cookie 但不带 Bearer → 401**（这条路一眼都不看 cookie）', async () => {
    /*
      最重要的一条。这条路为 Origin: null 开了 CORS，而那个 origin 任何
      外站都能伪造出来。如果它还认 cookie，外站放一个沙箱 iframe 就能
      带着用户的会话打进来。
    */
    const res = await call(DATA, { cookie: 'isp_session=whatever', origin: 'null' });
    expect(res.statusCode).toBe(401);
  });

  it('令牌不对 → 401', async () => {
    expect((await call(DATA, { authorization: 'Bearer nope' })).statusCode).toBe(401);
  });

  it('带对令牌就过闸门了（后面查连接器是另一回事）', async () => {
    const res = await call(DATA, { authorization: `Bearer ${token}` });
    // 过了鉴权就会去查连接器，假 sql 查不到 → NOT_FOUND。
    // 关键是它**不是** 401：凭据这一关认下来了。
    expect(res.statusCode).not.toBe(401);
    expect(res.json().code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('响应给 null origin 开门，但绝不带 allow-credentials', async () => {
    const res = await call(DATA, { authorization: `Bearer ${token}`, origin: 'null' });
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('预检答得出来，且同样不带 allow-credentials', async () => {
    // 带 Authorization 的跨源请求一定先发预检，没有这条浏览器就全挡下了
    const res = await call(DATA, { origin: 'null' }, 'OPTIONS');
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('只读：POST/DELETE 这条路上没有注册', async () => {
    for (const m of ['POST', 'DELETE', 'PUT'] as const) {
      const res = await call(DATA, { authorization: `Bearer ${token}` }, m);
      expect(res.statusCode).toBe(404);   // 路由不存在，不是"认不出凭据"
    }
  });

  it('预览令牌拿去走正门（/connect）不作数', async () => {
    // 它不是 JWT 也不是 isp_ 访问令牌，requireAuth 认不了它
    const res = await call('/deploy/api/connect/nosuch-connector', { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
  });

  it('释放之后令牌当场失效', async () => {
    const s = new PreviewSessions();
    const one = s.open(me.id, me.username);
    expect(s.byAccessToken(one.token)).not.toBeNull();
    s.release(one.id, me.id);
    expect(s.byAccessToken(one.token)).toBeNull();
  });
});

/**
 * shim 的注入位置。
 *
 * 它要在页面自己的脚本跑起来之前换掉 window.fetch，所以必须紧挨 <head>；
 * 而没有 <head> 的页面**不能**无脑插在最前面——插到 <!doctype> 前面会把
 * 浏览器推进怪异模式，布局当场走样，而且这种错极难往"是预览改的"上想。
 */
describe('shim 注入的落点', () => {
  it('有 head 就插在 head 紧后面', () => {
    const out = injectPreviewShim('<!doctype html><html><head><title>a</title></head><body>x');
    expect(out.indexOf('data-ispace-preview')).toBeLessThan(out.indexOf('<title>'));
  });

  it('没有 head 但有 html，插在 html 后面', () => {
    const out = injectPreviewShim('<!doctype html><html><body>x</body></html>');
    expect(out.startsWith('<!doctype html><html><script')).toBe(true);
  });

  it('只有 doctype 的，插在 doctype 之后——不能跑到它前面去', () => {
    const out = injectPreviewShim('<!doctype html><body>x');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('data-ispace-preview');
  });

  it('裸片段（连 doctype 都没有）插在最前面', () => {
    const out = injectPreviewShim('<h1>hi</h1>');
    expect(out.startsWith('<script')).toBe(true);
  });

  it('shim 把 /deploy/api/connect 改道到预览取数端点', () => {
    const out = injectPreviewShim('<head></head>');
    expect(out).toContain('/deploy/api/preview-data/connect/');
    // 令牌不能印在页面里——只能经 postMessage 握手拿
    expect(out).toContain('ispace:preview-ready');
    expect(out).toContain("credentials = 'omit'");
  });
});
