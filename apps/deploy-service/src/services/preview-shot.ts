import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';
import { coverShotAvailable } from './cover-shot.js';

/**
 * 给 Agent 的 screenshot_preview 截工作区里的页面。
 *
 * 截图器是现成的——发布时自动补封面的那个无头 chromium（cover-shot.ts）。
 * 这里只是换了目标（工作区而不是发布产物）和尺寸（手机竖屏 / 电脑），开关
 * 也是同一个：coverShotAvailable() 为假时整个工具不挂（见 routes/agent.ts）。
 *
 * 和封面截图的差别只有一处要紧：**失败要说出来**。封面是锦上添花，失败
 * 静默回落字母块就行；这里是模型在等一张图来判断页面对不对，静默失败等于
 * 让它对着空气下结论。
 */

/** 与 cover-shot.ts 是同一个变量、同一个默认值。 */
const CHROMIUM = process.env.ISPACE_CHROMIUM_PATH ?? '/usr/bin/chromium-browser';

const VIEWPORT = {
  phone: { w: 390, h: 844 },
  pc: { w: 1280, h: 800 },
} as const;

/** 同时最多几个。模型一轮里只会截一两张，这个上限防的是好几个人同时截。 */
const MAX_CONCURRENT = 2;
let running = 0;

export function previewShotAvailable(): boolean {
  return coverShotAvailable();
}

const FLAGS = [
  '--headless',
  '--no-sandbox', // 容器内非 root、无 user namespace，sandbox 起不来
  '--disable-gpu',
  '--disable-dev-shm-usage', // 容器 /dev/shm 很小
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  /*
    file:// 下每个文件是各自的 opaque origin，不加这一条的话
    `<script type="module" src="./main.js">` 会被当跨源挡掉，截出来是裸 HTML
    ——模型会以为自己的样式全写错了。
  */
  '--allow-file-access-from-files',
];

/** 截 htmlPath（绝对路径）。成功返回 PNG 字节，失败抛出带原因的错误。 */
export async function screenshotWorkspace(htmlPath: string, device: 'phone' | 'pc'): Promise<Buffer> {
  if (!previewShotAvailable()) {
    throw new IspaceError(ERROR_CODES.ORCHESTRATOR_UNAVAILABLE, '这台机器上没有无头浏览器，截不了图。');
  }
  if (running >= MAX_CONCURRENT) {
    throw new IspaceError(ERROR_CODES.ORCHESTRATOR_UNAVAILABLE, '截图器正忙（别人也在截），等一会儿再截，或者先接着改。');
  }
  running += 1;
  const dir = await mkdtemp(join(tmpdir(), 'ispace-pshot-'));
  const out = join(dir, 'shot.png');
  const { w, h } = VIEWPORT[device];
  try {
    /*
      先给 2.5 秒虚拟时间让脚本、字体落定；带 requestAnimationFrame 动画的页面
      会让虚拟时间永远走不完（chromium 挂住），那就退一步不等直接截。
      与 cover-shot.ts 的"先讲究、不行再将就"是同一个道理。
    */
    const viewport = `--window-size=${w},${h}`;
    if (!await run([...FLAGS, viewport, '--virtual-time-budget=2500'], htmlPath, out, 20_000)
      && !await run([...FLAGS, viewport], htmlPath, out, 20_000)) {
      throw new IspaceError(
        ERROR_CODES.INTERNAL,
        '截图失败：浏览器在 40 秒内没能把页面画出来。页面里可能有死循环或一直不结束的加载。',
      );
    }
    return await readFile(out);
  } finally {
    running -= 1;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(flags: string[], htmlPath: string, out: string, timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = execFile(
      CHROMIUM,
      [...flags, `--screenshot=${out}`, `file://${htmlPath}`],
      { timeout, killSignal: 'SIGKILL' },
      () => resolve(existsSync(out)),
    );
    child.on('error', () => resolve(false));
  });
}
