import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';

/**
 * 没声明封面时，给页面自动截一张当封面（方案 B，A 的兜底）。
 *
 * ┌─ 为什么用 chromium 的 --screenshot 命令行，而不是 puppeteer ──────────┐
 * │ 只要一张首屏截图，不需要点选、滚动、等 network idle 这些编排能力，    │
 * │ 那 puppeteer 那套 CDP 协议库与版本耦合就是纯负担。chromium 自带的     │
 * │ --headless --screenshot 直接把窗口截成 PNG，零 npm 依赖，镜像里        │
 * │ apk add chromium 就够。                                               │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 为什么截 file:// 而不是访问线上地址 ────────────────────────────────┐
 * │ 页面默认私有，走网关要带会话；而产物就在本容器挂着的 /srv/releases    │
 * │ 里，直接截 file:// 既不碰鉴权也不走网络。代价是根绝对路径的资源       │
 * │ （/platform/shell.js 之类）加载不到——但那只是平台 chrome，封面截的是  │
 * │ 页面首屏，相对路径的图和内联样式都在，够用。声明式封面才是精修那条路。│
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 全程 best-effort：截图是锦上添花，任何失败都只返回 false，绝不冒泡到发布。
 */

/** chromium 可执行文件。镜像里装在这个位置；本机 dev 没有就整个跳过。 */
const CHROMIUM = process.env.ISPACE_CHROMIUM_PATH ?? '/usr/bin/chromium-browser';

/** 16:9，与卡片 banner 同比例。给的是 CSS 像素，scale=1 出图即 1200×675。 */
const SHOT_W = 1200;
const SHOT_H = 675;

/** 同时最多两个 chromium。发版不频繁，这个上限只防"一串发布挤爆内存"。 */
const MAX_CONCURRENT = 2;
let running = 0;

/** 这台机器能不能自动截图。二进制不在（本机 dev）或被显式关掉就是不能。 */
export function coverShotAvailable(): boolean {
  if (process.env.ISPACE_COVER_AUTOSHOT === '0') return false;
  return existsSync(CHROMIUM);
}

/**
 * 截 indexHtmlPath 的首屏到 outPngPath。成功返回 true。
 *
 * outPngPath 会被 chmod 0644——Caddy 以别的 uid 提供静态文件，
 * 不放开权限它读不到，表现为封面 403/404。
 */
export async function screenshotCover(
  indexHtmlPath: string,
  outPngPath: string,
): Promise<boolean> {
  if (!coverShotAvailable()) return false;
  if (running >= MAX_CONCURRENT) return false;
  running += 1;
  try {
    /*
      先带「等一会儿再截」跑一次，失败了再不等直接截。

      --virtual-time-budget 是让 JS、字体、动画落定之后再截，绝大多数页面
      靠它才不会截到半成品。但它要求虚拟时间**能走到**那个预算，而一个
      requestAnimationFrame 的动画会一直排新帧，虚拟时间于是永远走不完
      ——chromium 挂死，30 秒后被我们杀掉，那张封面就此没有。线上四个页面
      （粒子动画、地图、看板）一直补不上封面，就是卡在这里。

      去掉预算之后那四个 12 秒就截出来了，但也不能干脆不要它：没有它的话
      异步渲染的页面会被截成一片空白。所以是"先讲究，不行再将就"。
    */
    if (await runChromium([...SHOT_FLAGS, '--virtual-time-budget=2500'], indexHtmlPath, outPngPath)) {
      await chmod(outPngPath, 0o644);
      return true;
    }
    if (await runChromium(SHOT_FLAGS, indexHtmlPath, outPngPath)) {
      await chmod(outPngPath, 0o644);
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    running -= 1;
  }
}

/** 两次尝试共用的那串 flag。差别只在要不要 --virtual-time-budget。 */
const SHOT_FLAGS = [
  '--headless',
  '--no-sandbox', // 容器内非 root、无 user namespace，sandbox 起不来
  '--disable-gpu',
  '--disable-dev-shm-usage', // 容器 /dev/shm 很小，不加会因共享内存不足崩
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${SHOT_W},${SHOT_H}`,
  /*
    ⚠️ 这一行是封面好不好看的分水岭。

    file:// 下每个文件都是**各自独立的 opaque origin**，于是
    `<script type="module" src="./assets/index.js">` 会被当成跨源请求挡掉
    ——Vite / VitePress 这类构建产物的脚本一个都不跑，样式也多半是脚本注
    进去的，截出来就是一页裸 HTML：蓝色下划线链接、左上角堆着导航文字。
    线上好几个作品的封面就是这个样子，一直没人看出来那是封面而不是页面。

    加上它之后同一个产物截出来就是真实页面（实测 ximengkai/life：
    340 KB 的裸 HTML → 377 KB 的完整首屏）。

    安全上这一下只放开"这个一次性无头进程能读本地文件"，而它截的本来就是
    平台自己刚写进磁盘的产物；进程截完即退，不碰网络。
  */
  '--allow-file-access-from-files',
];

/** 跑一次 chromium。出了文件才算成功——它偶尔会静默地什么都不写。 */
function runChromium(flags: string[], indexHtmlPath: string, outPngPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = execFile(
      CHROMIUM,
      [...flags, `--screenshot=${outPngPath}`, `file://${indexHtmlPath}`],
      // 硬超时兜底：某些页面会让 chromium 挂住，30s 后连进程一起杀
      { timeout: 30_000, killSignal: 'SIGKILL' },
      () => resolve(existsSync(outPngPath)),
    );
    child.on('error', () => resolve(false));
  });
}
/**
 * 截一个 URL 的首屏，返回 PNG 字节；失败返回 null。
 *
 * 与 screenshotCover（截 file://）同源，只是目标是 http URL——给露出的后端
 * 截封面：chromium 在 deploy-service 容器里，能按容器名直连后端。
 */
export async function screenshotUrlToBuffer(url: string): Promise<Buffer | null> {
  if (!coverShotAvailable()) return null;
  if (running >= MAX_CONCURRENT) return null;
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  running += 1;
  const dir = await mkdtemp(join(tmpdir(), 'ispace-shot-'));
  const out = join(dir, 'shot.png');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(CHROMIUM, [
        '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--hide-scrollbars', '--force-device-scale-factor=1',
        `--window-size=${SHOT_W},${SHOT_H}`, '--virtual-time-budget=3000',
        `--screenshot=${out}`, url,
      ], { timeout: 30_000, killSignal: 'SIGKILL' }, (err) => (err ? reject(err) : resolve()));
      child.on('error', reject);
    });
    if (!existsSync(out)) return null;
    return await readFile(out);
  } catch {
    return null;
  } finally {
    running -= 1;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
