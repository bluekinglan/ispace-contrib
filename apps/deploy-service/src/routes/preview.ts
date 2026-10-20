import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { z } from 'zod';
import { injectPreviewShim } from '../services/preview-shim.js';
import { PREVIEW_IDLE_MS, type PreviewSessions } from '../services/preview-session.js';
import { detectKind } from '../services/preview-kind.js';

/**
 * 工作区实时预览（见 docs/specs/2026-10-20-preview-runtime.md）。
 *
 * ┌─ 这一条补的是创建屏的那个洞 ────────────────────────────────────────┐
 * │ 改版前，右栏只在「已发布」之后才有东西可看（create.tsx 的           │
 * │ PreviewBody：没有 publishedUrl 就画一屏骨架）。模型写文件的那几分钟  │
 * │ 里人什么都看不见，更要紧的是——页面跑起来才暴露的错误（三维场景黑   │
 * │ 屏、动画循环里抛异常、取数拿到 404），发布之前谁都看不见，模型也就   │
 * │ 无从改起。它只能靠读自己写的代码来猜。                               │
 * │                                                                      │
 * │ 这里把工作区目录直接伺服出去，于是「写完即可见」，错误也能经 shim    │
 * │ 回流到对话里（services/preview-shim.ts）。                           │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 地址刻意挂在 `/deploy/api` 下面，不新开一级顶层路径：新增顶层路径要同步
 * 三处（RESERVED_PATHS、Caddyfile 的排除列表、reserved.test.ts），而 /deploy
 * 本来就是保留路径、Traefik 已整段路由到本服务，挂进来一行配置都不用改。
 *
 * 代价是页面里写了根绝对路径（/assets/x.js）会穿出预览——而这恰恰是好事：
 * 发布后的站点同样挂在 /{用户名}/{slug}/ 子路径下，平台本来就要求相对路径。
 * 两边踩同一个坑，等于把这个错误提前到预览阶段暴露。
 */

/** 按扩展名给 Content-Type。显式表而不是嗅探——嗅错一次就是一个白屏。 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // three.js 这类作品会加载模型文件。给错类型有些加载器会直接拒绝
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.hdr': 'image/vnd.radiance',
};

/**
 * 沙箱头。iframe 的 sandbox 属性只在被嵌入时生效——用户把预览地址复制到
 * 新标签页直接打开（调试时很自然的动作），那个属性就不存在了，页面于是
 * 跑在平台 origin 上，document.cookie 拿得到会话。
 *
 * CSP 的 sandbox 指令是响应头，顶层导航照样生效，把那种情况也按进 opaque
 * origin 里。取值与 create.tsx 的 iframe 属性一致（两者是取交集的关系，
 * 不一致只会让人以为某个能力还在）。
 */
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups';

export function registerPreviewRoutes(
  app: FastifyInstance,
  deps: {
    requireAuth: (req: FastifyRequest) => Promise<User>;
    workspaceRoot: string;
    sessions: PreviewSessions;
  },
): void {
  const { requireAuth, workspaceRoot, sessions } = deps;

  /* 兜底回收。主动释放（/release）只是加速，浏览器崩溃时它发不出来。 */
  const timer = setInterval(() => { sessions.prune(); }, 5 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });

  // ── 开一个预览 ────────────────────────────────────────────────────
  app.post(`${API_BASE}/preview-session`, async (req) => {
    const me = await requireAuth(req);
    const s = sessions.open(me.id, me.username);
    return {
      previewId: s.id,
      token: s.token,
      /* 相对路径即可：portal 与本服务同域名同源。末尾那个斜杠不能少，
         否则页面里的 ./main.js 会解析到上一级去。 */
      url: `${API_BASE}/preview/${s.id}/`,
      expiresAt: sessions.expiresAt(s),
      idleMs: PREVIEW_IDLE_MS,
    };
  });

  /**
   * 这个工作区能不能直接伺服出来看。
   *
   * 创建屏每次刷新预览前先问一下——工作区的内容一直在变，模型上一轮写的是
   * 一个单页面、这一轮加了个 server.js，判定就该跟着变。
   */
  app.get(`${API_BASE}/preview-session/:previewId/kind`, async (req, reply) => {
    const me = await requireAuth(req);
    const { previewId } = req.params as { previewId: string };
    const s = sessions.get(previewId);
    if (!s || s.userId !== me.id) {
      return reply.status(404).send({ code: ERROR_CODES.NOT_FOUND, message: '没有这个预览。' });
    }
    sessions.touch(s);
    return detectKind(join(workspaceRoot, s.username));
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
  app.get(`${API_BASE}/preview/:previewId`, async (req, reply) => {
    const { previewId } = req.params as { previewId: string };
    return reply.redirect(`${API_BASE}/preview/${encodeURIComponent(previewId)}/`, 302);
  });

  app.get(`${API_BASE}/preview/:previewId/*`, async (req, reply) => {
    const me = await requireAuth(req);
    const { previewId } = req.params as { previewId: string };
    const s = sessions.get(previewId);

    /*
      不存在 / 已过期 / 不是你的 —— 一律 404，一句话。

      区分了就等于告诉对方这个 id 是真的，和 authz.ts、svc-proxy.ts 同一套
      处理。**管理员也不放行**：预览是一个人手上还没成形的草稿，不是已发布
      的内容，没有哪种排查场景能压过这一点——真要看，让他看发布后的版本。
    */
    if (!s || s.userId !== me.id) {
      return reply.status(404).type('text/html; charset=utf-8').send(gonePage());
    }
    sessions.touch(s);

    const root = join(workspaceRoot, s.username);
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    /* 越界直接抛 IspaceError（403），由全局 errorHandler 转成响应 */
    let abs = await safeResolve(root, rel);

    /*
      根文档要先问一句"这东西能不能直接伺服出来看"。

      带服务端的、要构建的，伺服出去是半截页面或白屏——而白屏最糟：人会以为
      预览坏了，或者以为模型写的东西有问题，两个方向都是错的。所以这里直接
      出一页说明，把是哪一类、下一步干什么说清楚。

      只拦根文档，不拦子资源：子资源单独被打开的情形不存在，多一次判定只是
      白花时间。状态码是 200——这是我们**有意**给出的响应，不是哪里失败了。
    */
    if (rel === '' || rel.endsWith('/')) {
      const verdict = detectKind(root);
      if (verdict.kind === 'server' || verdict.kind === 'build') {
        return reply
          .status(200)
          .header('cache-control', 'no-store')
          .header('content-security-policy', SANDBOX_CSP)
          .type('text/html; charset=utf-8')
          .send(noPreviewPage(verdict.why));
      }
    }

    let st = await stat(abs).catch(() => null);
    // 目录（含预览根）→ 找里面的 index.html
    if (st?.isDirectory()) {
      abs = join(abs, 'index.html');
      st = await stat(abs).catch(() => null);
    }
    if (!st?.isFile()) {
      return reply.status(404).type('text/html; charset=utf-8').send(missingPage(rel));
    }

    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', SANDBOX_CSP);

    const type = TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    reply.type(type);

    if (type.startsWith('text/html')) {
      // HTML 要改写（注 shim），只能整份读进来。其余一律走流，
      // 免得一个几十 MB 的模型文件把内存顶上去。
      const html = await readFile(abs, 'utf8');
      return reply.send(injectPreviewShim(html));
    }
    return reply.send(createReadStream(abs));
  });
}

/**
 * 把 URL 里的相对路径解析成工作区内的绝对路径。
 *
 * 两道，缺一不可：
 *   1. resolve 之后必须仍在 root 之下 —— 挡 `../`、绝对路径。
 *      与 packages/agent/src/tools.ts 的 safePath 同一条判据：Agent 写得进
 *      哪里，预览才看得到哪里，两边说同一套话。
 *   2. realpath 之后再判一次 —— 挡符号链接。第 1 道对软链无效（`a → /etc`
 *      解析出来的字符串仍在 root 下）。Agent 的工具集造不出软链（没有那个
 *      工具），但工作区目录在宿主上是可能被运维手工动过的，这一道几微秒，
 *      顺手堵上。
 */
async function safeResolve(root: string, rel: string): Promise<string> {
  const abs = resolve(root, rel);
  if (!within(root, abs)) {
    throw new IspaceError(ERROR_CODES.FORBIDDEN, '路径越界：只能看自己工作区里的文件。');
  }

  /*
    ⚠️ 第 2 道必须拿 **root 的 realpath** 去比，不能拿 root 原样比。

    工作区根自己就可能落在软链后面：macOS 上 /var → /private/var，线上
    /srv/workspaces 也完全可能是条软链。拿原样的 root 去比，realpath 出来的
    /private/var/... 不以 /var/... 开头，于是**每一个正常请求都会 403**，
    而报错写的是"这个链接指到工作区外面了"——一句把人带去完全错误方向的话。
    实测就是这个状态，这一行是改出来的，不是想出来的。

    不存在的路径 realpath 会抛：那是 404 的事，返回 abs 交给调用方按 stat 判。
  */
  const realRoot = await realpath(root).catch(() => root);
  const real = await realpath(abs).catch(() => null);
  if (real !== null && !within(realRoot, real)) {
    throw new IspaceError(ERROR_CODES.FORBIDDEN, '路径越界：这个链接指到工作区外面了。');
  }
  return abs;
}

/** p 是否在 base 之下（或就是 base）。与 tools.ts 的 safePath 同一条判据。 */
function within(base: string, p: string): boolean {
  return p === base || p.startsWith(base + sep);
}

/**
 * 拒绝页与缺文件页都返回 HTML。
 *
 * 这两个响应会被渲染在创建屏右栏那个 iframe 里给人看，不是给程序看的。
 * 一串 JSON 只会让他去问"这是什么意思"。
 */
const shell = (body: string) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf8f3;
       color:#292724;font:14px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif}
  .box{max-width:320px;padding:28px;text-align:center}
  h1{font-size:16px;margin:0 0 8px}
  p{margin:0;color:#6b6762;font-size:13px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style>
<div class="box">${body}</div>`;

const noPreviewPage = (why: string) => shell(`
  <h1>这个项目不走预览</h1>
  <p>${escapeHtml(why)}</p>`);

const gonePage = () => shell(`
  <h1>预览已经过期</h1>
  <p>预览最多留一小时，闲置十五分钟也会收掉。刷新这一屏重新开始就好。</p>`);

const missingPage = (rel: string) => shell(
  rel === '' || rel.endsWith('/')
    ? `<h1>还没有 index.html</h1>
       <p>工作区里暂时没有首页文件。等它写出来，这里会自动刷新。</p>`
    : `<h1>没有这个文件</h1>
       <p><code>${escapeHtml(rel)}</code> 不在工作区里。<br>
          如果页面里写的是 <code>/assets/x.js</code> 这样的根路径，改成
          <code>./assets/x.js</code> —— 页面发布后也挂在子路径下，根路径一样取不到。</p>`,
);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}
