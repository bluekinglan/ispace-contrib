import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * 把一个目录当静态站点伺服出去，共两处在用：
 *   routes/preview.ts  工作区实时预览（还没发布的草稿）
 *   routes/play.ts     已发布页面的试玩（详情页与为你推荐里那个 iframe）
 *
 * 抽出来不是为了少写几行，是因为这里面有两样**错一次就很难查**的东西：
 * 路径边界，和沙箱头。两处各写一份，迟早会有一份落后。
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
  '.xml': 'application/xml; charset=utf-8',
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
  // three.js 这类作品会加载模型文件。给错类型有些加载器直接拒绝
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.hdr': 'image/vnd.radiance',
};

/**
 * 沙箱头。
 *
 * iframe 的 sandbox 属性只在被嵌入时生效——把地址复制到新标签页直接打开，
 * 那个属性就不存在了，页面于是跑在平台 origin 上，document.cookie 拿得到
 * 会话。CSP 的 sandbox 指令是响应头，顶层导航照样生效。
 *
 * 取值与前端 iframe 的 sandbox 属性一致（两者取交集，不一致只会让人以为
 * 某个能力还在）。
 */
export const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups';

/**
 * 伺服响应上固定的那几个头。
 *
 * `referrer-policy: no-referrer` 这条是**随「凭据放进路径」一起来的**：
 * 地址里带着一次性令牌，而页面里只要有一条外链，默认的 Referer 就会把
 * 整条地址（连同令牌）送到对方站点去。这一行把那条泄漏路径堵死。
 */
export function sandboxHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('content-security-policy', SANDBOX_CSP)
    /*
      ⚠️ 没有这一行，Vite / VitePress 这类构建产物在框里是空屏或裸 HTML。

      上面那条 CSP sandbox 让页面成为 opaque origin（Origin: null）。而构建
      产物的入口是 `<script type="module" crossorigin>`、`<link rel=stylesheet
      crossorigin>`——模块脚本和带 crossorigin 的样式**一律按 CORS 去取**，
      从 null 源取同一台服务器的文件就是跨源，响应里没有 ACAO，浏览器直接
      丢掉：React 应用空屏，样式全无。线上 zongkelong/voice-clone、
      ximengkai/life 就是这个样子。

      给 * 不放宽任何东西：这两条路上凭据在路径里（令牌 / previewId），
      拿到地址的人本来就能不带 cookie 直接取；* 也不允许带凭据。
    */
    .header('access-control-allow-origin', '*');
}

/**
 * 去掉指回这个页面正式地址的 <base href>。
 *
 * 有的产物在 <head> 里写死了 `<base href="https://域名/用户/页面/">`
 * （dongfei/deepseek-harness-learn 就是）。直接打开正式地址时没问题；但在
 * 试玩地址下，它把所有相对路径——样式、脚本、字体——都改指回正式地址，
 * 而那边要登录，沙箱框里带不上 cookie，于是只剩一页没样式的字。
 *
 * 只摘指回**它自己**的那一条（绝对或根相对都算），指向别处的 base 原样留着。
 */
export function dropSelfBase(html: string, owner: string, slug: string): string {
  const self = new RegExp(
    `<base\\s+href=["'](?:https?://[^/"']+)?/${owner}/${slug}/?["'][^>]*>`,
    'gi',
  );
  return html.replace(self, '');
}

/** p 是否在 base 之下（或就是 base）。 */
function within(base: string, p: string): boolean {
  return p === base || p.startsWith(base + sep);
}

/**
 * 把 URL 里的相对路径解析成 root 内的绝对路径。
 *
 * 两道，缺一不可：
 *   1. resolve 之后必须仍在 root 之下 —— 挡 `../`、绝对路径。与
 *      packages/agent/src/tools.ts 的 safePath 同一条判据。
 *   2. realpath 之后再判一次 —— 挡符号链接。第 1 道对软链无效。
 *
 * ⚠️ 第 2 道必须拿 **root 的 realpath** 去比，不能拿 root 原样比。两处 root
 * 都可能落在软链后面：macOS 上 /var → /private/var；而已发布站点的
 * /srv/sites/{user}/{slug} **本身就是指向 releases 的软链**（发布时切的）。
 * 拿原样 root 比，每一个正常请求都会 403，报错还写着"指到工作区外面了"
 * ——一句把人带去完全错误方向的话。实测踩过。
 */
export async function safeResolve(root: string, rel: string): Promise<string> {
  const abs = resolve(root, rel);
  if (!within(root, abs)) {
    throw new IspaceError(ERROR_CODES.FORBIDDEN, '路径越界：只能看这个站点里的文件。');
  }
  const realRoot = await realpath(root).catch(() => root);
  const real = await realpath(abs).catch(() => null);
  if (real !== null && !within(realRoot, real)) {
    throw new IspaceError(ERROR_CODES.FORBIDDEN, '路径越界：这个链接指到站点外面了。');
  }
  return abs;
}

export interface ServeResult {
  /** 找到并已写进 reply。 */
  ok: boolean;
  /** 没找到时，请求的是不是根文档——两种情况的提示语不一样。 */
  wantedIndex: boolean;
}

/**
 * 伺服 root 下的 rel。HTML 会过一遍 transformHtml（注 shim、摘 chrome）。
 *
 * 找不到不自己出页面：两处的提示语不同（工作区是"还没写出来"，已发布站点是
 * "这个文件不在"），交给调用方写。
 */
export async function serveFile(
  reply: FastifyReply,
  opts: { root: string; rel: string; transformHtml?: (html: string) => string },
): Promise<ServeResult> {
  const wantedIndex = opts.rel === '' || opts.rel.endsWith('/');
  let abs = await safeResolve(opts.root, opts.rel);

  let st = await stat(abs).catch(() => null);
  // 目录（含站点根）→ 找里面的 index.html
  if (st?.isDirectory()) {
    abs = join(abs, 'index.html');
    st = await stat(abs).catch(() => null);
  }
  if (!st?.isFile()) return { ok: false, wantedIndex };

  const type = TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  sandboxHeaders(reply).type(type);

  if (type.startsWith('text/html')) {
    // HTML 要改写，只能整份读进来。其余一律走流，免得一个几十 MB 的
    // 模型文件把内存顶上去。
    const html = await readFile(abs, 'utf8');
    await reply.send(opts.transformHtml ? opts.transformHtml(html) : html);
  } else {
    await reply.send(createReadStream(abs));
  }
  return { ok: true, wantedIndex };
}

/**
 * 拒绝页与缺文件页都返回 HTML。
 *
 * 这些响应会被渲染在一个 iframe 里给人看，不是给程序看的。一串 JSON 只会
 * 让他去问"这是什么意思"。
 */
export const noticePage = (body: string): string => `<!doctype html><meta charset="utf-8">
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

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}
