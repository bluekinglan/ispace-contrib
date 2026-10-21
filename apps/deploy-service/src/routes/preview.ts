import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, type User } from '@ispace/contracts';
import { z } from 'zod';
import { injectPreviewShim } from '../services/preview-shim.js';
import { injectStorageShim } from '../services/sandbox-storage-shim.js';
import { PREVIEW_IDLE_MS, type PreviewSession, type PreviewSessions } from '../services/preview-session.js';
import { detectKind } from '../services/preview-kind.js';
import { escapeHtml, noticePage, SANDBOX_CSP, serveFile } from '../services/static-serve.js';

/**
 * 工作区实时预览（见 docs/specs/2026-10-20-preview-runtime.md）。
 *
 * 创建屏右栏在发布之前就能看见页面真的在跑，错误经 shim 回流到对话里。
 *
 * ┌─ 凭据在路径里，不在 cookie 里 ──────────────────────────────────────┐
 * │ 这一条是改出来的，起因是一个会让整个功能形同虚设的问题：            │
 * │                                                                      │
 * │ 预览 iframe **不给 allow-same-origin**（给了等于没有沙箱）。于是     │
 * │ iframe 里的文档是 opaque origin，而浏览器把 opaque origin 文档自己   │
 * │ 发出的子资源请求当作**跨站**——会话 cookie 是 SameSite=Lax，跨站不带。│
 * │                                                                      │
 * │ 后果：HTML 进得来（那一跳由父页面发起，带得上 cookie），它引用的     │
 * │ 每一个 CSS、JS、图片都带不上身份。原先这里对每个请求都 requireAuth， │
 * │ 子资源于是全部 401——预览里只剩一具没有样式、没有脚本的骨架。        │
 * │ 线上已发布页面的试玩屏是同一个病，实测就是一页裸 HTML。             │
 * │                                                                      │
 * │ 所以凭据改放在**路径**里：previewId 是 24 字节随机数，相对路径的子   │
 * │ 资源天然继承这个前缀，一个 cookie 都不需要。                        │
 * │                                                                      │
 * │ 代价说清楚：拿到完整地址的人就能看这个预览。对冲的是三条——         │
 * │ 192 位熵猜不出来；最长 60 分钟、闲置 15 分钟即失效；响应带            │
 * │ `Referrer-Policy: no-referrer`，页面里的外链不会把地址捎出去。       │
 * │ 开预览本身仍然要登录（只有本人能换到这把钥匙）。                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 地址挂在 /deploy/api 下而不新开顶层路径：新增顶层路径要同步
 * RESERVED_PATHS、Caddyfile、reserved.test.ts 三处，而 /deploy 本来就是保留
 * 路径。代价是页面里的根绝对路径会穿出预览——这恰恰是好事，发布后同样挂在
 * 子路径下，等于把这个错提前暴露。
 */

export function registerPreviewRoutes(
  app: FastifyInstance,
  deps: {
    requireAuth: (req: FastifyRequest) => Promise<User>;
    workspaceRoot: string;
    sessions: PreviewSessions;
    /**
     * 这个人、这条会话对应哪个工作区目录（services/session-workspace.ts）。
     *
     * 预览必须和对话指着同一个目录，否则右边看到的不是左边在改的。不传时
     * 回落到改版前的 {workspaceRoot}/{username}——只有单测走这一支。
     */
    workspaceDir?: (user: User, sessionId: string | undefined) => Promise<string>;
  },
): void {
  const { requireAuth, workspaceRoot, sessions } = deps;
  const dirOf = (s: PreviewSession) => s.dir ?? join(workspaceRoot, s.username);

  /* 兜底回收。主动释放只是加速，浏览器崩溃时它发不出来。 */
  const timer = setInterval(() => { sessions.prune(); }, 5 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });

  // ── 开一个预览（要登录：这是换钥匙的那一步）────────────────────
  app.post(`${API_BASE}/preview-session`, async (req) => {
    const me = await requireAuth(req);
    /* 老客户端不带 body，新的带着创建屏那条会话的 id */
    const { sessionId } = z.object({ sessionId: z.string().max(64).optional() }).parse(req.body ?? {});
    const dir = deps.workspaceDir ? await deps.workspaceDir(me, sessionId) : undefined;
    const s = sessions.open(me.id, me.username, dir);
    return {
      previewId: s.id,
      token: s.token,
      /* 相对路径即可：portal 与本服务同域名同源。末尾斜杠不能少，
         否则页面里的 ./main.js 会解析到上一级去。 */
      url: `${API_BASE}/preview/${s.id}/`,
      expiresAt: sessions.expiresAt(s),
      idleMs: PREVIEW_IDLE_MS,
    };
  });

  /** 这个工作区能不能直接伺服出来看。创建屏每次刷新前问一遍。 */
  app.get(`${API_BASE}/preview-session/:previewId/kind`, async (req, reply) => {
    const me = await requireAuth(req);
    const { previewId } = req.params as { previewId: string };
    const s = sessions.get(previewId);
    if (!s || s.userId !== me.id) {
      return reply.status(404).send({ code: ERROR_CODES.NOT_FOUND, message: '没有这个预览。' });
    }
    sessions.touch(s);
    return detectKind(dirOf(s));
  });

  // ── 主动释放（创建屏卸载时 sendBeacon 打这里）────────────────────
  app.post(`${API_BASE}/preview-session/release`, async (req) => {
    const me = await requireAuth(req);
    const { previewId } = z.object({ previewId: z.string().min(1) }).parse(req.body);
    return { ok: sessions.release(previewId, me.id) };
  });

  // ── 文件 ──────────────────────────────────────────────────────────
  /*
    没有末尾斜杠的形态要跳转，不能直接出 index.html：那样页面里的相对路径
    会少解析一级（/preview/{id} 下的 ./main.js → /preview/main.js），
    表现是一屏白，而 HTML 本身返回了 200。
  */
  app.get(`${API_BASE}/preview/:previewId`, async (req, reply) =>
    reply.redirect(`${API_BASE}/preview/${encodeURIComponent((req.params as { previewId: string }).previewId)}/`, 302));

  app.get(`${API_BASE}/preview/:previewId/*`, async (req, reply) => {
    /*
      **这里刻意不 requireAuth**，见文件头那段说明：子资源带不上 cookie，
      要求它等于把功能做死。previewId 自己就是凭据。
    */
    const { previewId } = req.params as { previewId: string };
    const s = sessions.get(previewId);
    if (!s) {
      return reply
        .status(404).type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send(gonePage());
    }
    sessions.touch(s);

    const root = dirOf(s);
    const rel = (req.params as Record<string, string>)['*'] ?? '';

    /*
      根文档先问一句"这东西能不能直接伺服出来看"。带服务端的、要构建的，
      伺服出去是半截页面或白屏——而白屏最糟：人会以为预览坏了，或者以为
      模型写的东西有问题，两个方向都是错的。只拦根文档，不拦子资源。
    */
    if (rel === '' || rel.endsWith('/')) {
      const verdict = detectKind(root);
      if (verdict.kind === 'server' || verdict.kind === 'build') {
        return reply
          .status(200)
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .header('content-security-policy', SANDBOX_CSP)
          .type('text/html; charset=utf-8')
          .send(noPreviewPage(verdict.why));
      }
    }

    const r = await serveFile(reply, {
      root,
      rel,
      transformHtml: (html) => injectPreviewShim(injectStorageShim(html)),
    });
    if (!r.ok) {
      return reply
        .status(404).type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send(missingPage(rel, r.wantedIndex));
    }
    return reply;
  });
}

const noPreviewPage = (why: string) => noticePage(`
  <h1>这个项目不走预览</h1>
  <p>${escapeHtml(why)}</p>`);

const gonePage = () => noticePage(`
  <h1>预览已经过期</h1>
  <p>预览最多留一小时，闲置十五分钟也会收掉。刷新这一屏重新开始就好。</p>`);

const missingPage = (rel: string, wantedIndex: boolean) => noticePage(
  wantedIndex
    ? `<h1>还没有 index.html</h1>
       <p>工作区里暂时没有首页文件。等它写出来，这里会自动刷新。</p>`
    : `<h1>没有这个文件</h1>
       <p><code>${escapeHtml(rel)}</code> 不在工作区里。<br>
          如果页面里写的是 <code>/assets/x.js</code> 这样的根路径，改成
          <code>./assets/x.js</code> —— 页面发布后也挂在子路径下，根路径一样取不到。</p>`,
);
