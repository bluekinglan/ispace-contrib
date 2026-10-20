import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerPreviewRoutes } from '../routes/preview.js';
import { PreviewSessions } from '../services/preview-session.js';

/**
 * 工作区实时预览的鉴权与边界（方案 §4.3、§4.4）。
 *
 * 这一组全部不碰库、不碰容器：预览伺服的是磁盘上的目录，判断只有
 * 「你是谁」「这个预览是不是你的」「这条路径在不在工作区里」三件事。
 *
 * 几条判据是刻意的，用例在这里钉住，免得以后被"顺手改好看一点"改掉：
 *   - 不存在 / 已过期 / 不是你的 —— 一律 404 且同一句话
 *   - **管理员也不放行**（预览是没成形的草稿，不是已发布内容）
 *   - 越界是 403 且不读任何文件
 */
describe('预览的鉴权与路径边界', () => {
  let app: ReturnType<typeof Fastify>;
  let root: string;
  let sessions: PreviewSessions;
  let mine: string;

  const me = { id: 'u-me', username: 'lixiao', role: 'employee', status: 'active' } as User;
  const other = { id: 'u-other', username: 'wangkai', role: 'employee', status: 'active' } as User;
  const admin = { id: 'u-admin', username: 'root', role: 'admin', status: 'active' } as User;
  const who: Record<string, User> = { me, other, admin };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ispace-preview-'));
    mkdirSync(join(root, 'lixiao', 'sub'), { recursive: true });
    writeFileSync(join(root, 'lixiao', 'index.html'), '<!doctype html><head></head><h1>嗨</h1>');
    writeFileSync(join(root, 'lixiao', 'sub', 'main.js'), 'console.log(1)');
    // 工作区外面放一个「秘密」，用软链从里面指过去——第 2 道边界要挡住它
    writeFileSync(join(root, 'outside.txt'), 'SECRET');
    symlinkSync(join(root, 'outside.txt'), join(root, 'lixiao', 'leak.txt'));

    sessions = new PreviewSessions();
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerPreviewRoutes(app, {
      requireAuth: async (req: FastifyRequest) => {
        const u = who[String(req.headers['x-test-user'] ?? '')];
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return u;
      },
      workspaceRoot: root,
      sessions,
    });
    await app.ready();

    mine = sessions.open(me.id, me.username).id;
  });

  afterAll(async () => { await app?.close(); });

  const get = (path: string, user?: string) =>
    app.inject({
      method: 'GET', url: path,
      ...(user ? { headers: { 'x-test-user': user } } : {}),
    });

  it('没登录连门都进不去', async () => {
    expect((await get(`/deploy/api/preview/${mine}/`)).statusCode).toBe(401);
  });

  it('开预览：没登录 401；登录了给地址和令牌，且地址带末尾斜杠', async () => {
    const no = await app.inject({ method: 'POST', url: '/deploy/api/preview-session' });
    expect(no.statusCode).toBe(401);

    const res = await app.inject({
      method: 'POST', url: '/deploy/api/preview-session',
      headers: { 'x-test-user': 'me' },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json() as { previewId: string; token: string; url: string };
    expect(b.url).toBe(`/deploy/api/preview/${b.previewId}/`);
    // 令牌不能和 id 是同一个东西：id 在地址栏里，令牌是真凭据
    expect(b.token).not.toBe(b.previewId);
    expect(b.token.length).toBeGreaterThan(30);
    /* 这一下把 beforeAll 开的那个顶掉了（一人一个），后面的用例要用新的 */
    mine = b.previewId;
  });

  it('释放要登录，且只收自己的预览', async () => {
    const release = (user?: string, previewId = mine) => app.inject({
      method: 'POST', url: '/deploy/api/preview-session/release',
      ...(user ? { headers: { 'x-test-user': user } } : {}),
      payload: { previewId },
    });
    expect((await release()).statusCode).toBe(401);
    expect((await release('other')).json().ok).toBe(false);
    expect((await release('me')).json().ok).toBe(true);
    // 收掉之后文件就看不到了
    expect((await get(`/deploy/api/preview/${mine}/`, 'me')).statusCode).toBe(404);
    mine = sessions.open(me.id, me.username).id;
  });

  it('自己的预览能看到工作区里的文件', async () => {
    const res = await get(`/deploy/api/preview/${mine}/`, 'me');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('嗨');
    const js = await get(`/deploy/api/preview/${mine}/sub/main.js`, 'me');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
  });

  it('HTML 响应带沙箱头与 no-store', async () => {
    const res = await get(`/deploy/api/preview/${mine}/`, 'me');
    /*
      iframe 的 sandbox 属性只在被嵌入时生效。用户把预览地址复制到新标签页
      直接打开，那个属性就不存在了——CSP 这一条让顶层导航也落进 opaque origin。
    */
    expect(res.headers['content-security-policy']).toBe(
      'sandbox allow-scripts allow-forms allow-popups',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('HTML 被注入了 shim，JS 之类不动', async () => {
    const html = await get(`/deploy/api/preview/${mine}/`, 'me');
    expect(html.body).toContain('data-ispace-preview');
    // shim 要在页面自己的脚本之前就换掉 fetch，所以得在 <head> 紧后面
    expect(html.body.indexOf('data-ispace-preview')).toBeLessThan(html.body.indexOf('<h1>'));
    const js = await get(`/deploy/api/preview/${mine}/sub/main.js`, 'me');
    expect(js.body).toBe('console.log(1)');
  });

  it('别人的预览 id 看不到，而且和「不存在」是同一句话', async () => {
    const notMine = await get(`/deploy/api/preview/${mine}/`, 'other');
    const nothing = await get('/deploy/api/preview/aaaaaaaaaaaaaaaaaaaaaa/', 'other');
    expect(notMine.statusCode).toBe(404);
    expect(nothing.statusCode).toBe(404);
    // 区分了就等于告诉对方这个 id 是真的
    expect(notMine.body).toBe(nothing.body);
  });

  it('管理员也不放行——预览是没成形的草稿，不是已发布内容', async () => {
    expect((await get(`/deploy/api/preview/${mine}/`, 'admin')).statusCode).toBe(404);
  });

  it('过期的预览当作不存在', async () => {
    let clock = 0;
    const s2 = new PreviewSessions(() => clock);
    const dead = s2.open(me.id, me.username);
    clock = 61 * 60 * 1000;             // 过了硬上限
    expect(s2.get(dead.id)).toBeNull();

    let clock2 = 0;
    const s3 = new PreviewSessions(() => clock2);
    const idle = s3.open(me.id, me.username);
    clock2 = 16 * 60 * 1000;            // 过了空闲上限
    expect(s3.get(idle.id)).toBeNull();
  });

  /*
    字面的 ../ 拿不到文件，但**它不是被我们的边界挡下的**。

    实测（Fastify 5 / light-my-request，浏览器同理）：`/preview/{id}/../../x`
    在路由之前就被规范化成 `/deploy/api/x`，请求根本到不了预览 handler，
    于是是一个路由级 404。所以这里断言的是"没把文件给出去"，不是某个具体
    状态码——真要求 403 就得去改一个我们从来没收到过的请求，那是假的。

    真正会打到边界上的是**编码**形式（浏览器不会规范化它），见下一条。
  */
  it('字面 ../ 拿不到工作区外面的文件', async () => {
    const res = await get(`/deploy/api/preview/${mine}/../../outside.txt`, 'me');
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain('SECRET');
  });

  it('URL 编码的 ../ 同样挡住（解码之后再判，不是按原文判）', async () => {
    const res = await get(`/deploy/api/preview/${mine}/%2e%2e%2f%2e%2e%2foutside.txt`, 'me');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SECRET');
  });

  it('指到工作区外面的软链也挡住（resolve 那道对软链无效）', async () => {
    const res = await get(`/deploy/api/preview/${mine}/leak.txt`, 'me');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SECRET');
  });

  it('没有末尾斜杠要跳转，不能直接出 index.html', async () => {
    // 否则页面里的 ./main.js 会少解析一级，表现是一屏白而 HTML 返回 200
    const res = await get(`/deploy/api/preview/${mine}`, 'me');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/deploy/api/preview/${mine}/`);
  });

  it('缺文件是 404，而且话里说清楚根路径取不到', async () => {
    const res = await get(`/deploy/api/preview/${mine}/assets/x.js`, 'me');
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('./assets/x.js');
  });

  it('工作区还没有 index.html 时说的是这件事，不是「没有这个文件」', async () => {
    const empty = sessions.open(other.id, 'wangkai');     // 这个人没有工作区目录
    const res = await get(`/deploy/api/preview/${empty.id}/`, 'other');
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('index.html');
  });

  it('一人只有一个预览：开新的，旧的当场失效', async () => {
    const s = new PreviewSessions();
    const first = s.open(me.id, me.username);
    const second = s.open(me.id, me.username);
    expect(s.get(first.id)).toBeNull();
    expect(s.get(second.id)).not.toBeNull();
    expect(s.byAccessToken(first.token)).toBeNull();
    expect(s.size).toBe(1);
  });

  it('hasFor 只在真有一块活着的预览时为真——系统提示那句话据此决定说不说', async () => {
    /*
      它会变成提示里的一句「你每写完一个文件它就刷新一次」。对一个根本没有
      预览的会话（比如手机壳）说这句就是假话，所以判断必须来自真实状态。
    */
    let clock = 0;
    const s = new PreviewSessions(() => clock);
    expect(s.hasFor(me.id)).toBe(false);

    const one = s.open(me.id, me.username);
    expect(s.hasFor(me.id)).toBe(true);
    expect(s.hasFor(other.id)).toBe(false);      // 别人的预览不算他的

    clock = 16 * 60 * 1000;                      // 空闲超时
    expect(s.hasFor(me.id)).toBe(false);

    clock = 0;
    const two = s.open(me.id, me.username);
    expect(s.hasFor(me.id)).toBe(true);
    s.release(two.id, me.id);
    expect(s.hasFor(me.id)).toBe(false);         // 发布后收掉，就不再说那句话
    void one;
  });

  /*
    带服务端 / 要构建的项目不渲染（services/preview-kind.ts）。这两条钉住
    「判定的结果真的影响了出什么」——判定本身的边界在 preview-kind.test.ts。
  */
  it('工作区里出现 server.js 之后，根文档出的是说明而不是页面', async () => {
    /*
      用一个专属目录，不借 wangkai 的。
      前面那条「工作区还没有 index.html」正是靠 wangkai 没有目录来验的——
      在这儿给他建目录，两条用例就按先后顺序互相影响，换个顺序就红。
    */
    mkdirSync(join(root, 'fullstack'), { recursive: true });
    writeFileSync(join(root, 'fullstack', 'index.html'), '<!doctype html><h1>前端</h1>');
    writeFileSync(join(root, 'fullstack', 'server.js'), 'require("express")');
    const s2 = sessions.open(other.id, 'fullstack');

    const res = await get(`/deploy/api/preview/${s2.id}/`, 'other');
    expect(res.statusCode).toBe(200);          // 这是有意给出的响应，不是哪里失败了
    expect(res.body).toContain('不走预览');
    expect(res.body).not.toContain('前端');     // 没把那个半截页面渲染出来
    /* 子资源不拦——单独打开子资源的情形不存在，多一次判定只是白花时间 */
    expect((await get(`/deploy/api/preview/${s2.id}/server.js`, 'other')).statusCode).toBe(200);
  });

  it('kind 接口：别人的预览问不到，自己的答得出判据', async () => {
    const s2 = sessions.open(other.id, 'fullstack');
    expect((await get(`/deploy/api/preview-session/${s2.id}/kind`, 'me')).statusCode).toBe(404);
    expect((await get(`/deploy/api/preview-session/${s2.id}/kind`)).statusCode).toBe(401);

    const mineKind = await get(`/deploy/api/preview-session/${mine}/kind`, 'me');
    expect(mineKind.statusCode).toBe(200);
    expect(mineKind.json().kind).toBe('static');

    const theirs = await get(`/deploy/api/preview-session/${s2.id}/kind`, 'other');
    expect(theirs.json().kind).toBe('server');
    expect(theirs.json().signals).toContain('server.js');
  });

  it('释放只认本人', async () => {
    const s = new PreviewSessions();
    const one = s.open(me.id, me.username);
    expect(s.release(one.id, other.id)).toBe(false);
    expect(s.get(one.id)).not.toBeNull();
    expect(s.release(one.id, me.id)).toBe(true);
    expect(s.get(one.id)).toBeNull();
  });
});
