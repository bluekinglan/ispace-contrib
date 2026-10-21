import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { appSlugSchema } from '@ispace/contracts';
import { siteLink, stripShellScript, type StorageConfig } from '@ispace/storage';
import { MAX_ATTACH_BYTES } from './attachments.js';
import { AUTO_COVER_FILE, scratchFilter } from './deploy.js';

/**
 * 从线上版本反推一份工作区（docs/specs/2026-10-21-agent-harness.md §1.3）。
 *
 * ┌─ 为什么要 ──────────────────────────────────────────────────────────┐
 * │ 「改我的 /zhoubao/」时，要是这个页面从没在新布局下从工作区发布过    │
 * │ （CLI、MCP 发的，或者改版前 Agent 发的），就没有工作区可找：要么落到 │
 * │ legacy——改版前所有页面叠在一起，index.html 是最后做的那个页面的，  │
 * │ 照着它改完再发，/zhoubao/ 就被换成了另一个页面；要么是空的，模型只  │
 * │ 好从头写一个，发出去整页替换。线上那份才是人眼里"我的页面"。       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 拷什么、不拷什么 ──────────────────────────────────────────────────┐
 * │ 发布链路往产物里加过两样东西，都要去掉，否则再发一次就叠一层：      │
 * │   · index.html 里注入的平台脚本 → stripShellScript 逐字摘回去       │
 * │   · 根目录的 __ispace_cover.png（没声明封面时平台截的）→ 不拷       │
 * │ 其余原样拷。只读线上版本，一个字节都不改它。                        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 拷不全就一个都不拷 ────────────────────────────────────────────────┐
 * │ 半份工作区是最糟的结果：预览看着差不多，再发布时没拷进来的文件就从  │
 * │ 线上消失了，而且没人报错。所以先把整棵树过一遍，有任何一样拷不了或  │
 * │ 发不回去，整个放弃，交给调用方按原来的规则兜底，并把原因告诉模型。  │
 * │ "发不回去"指的是 Agent 发布会丢掉的东西：下划线开头的顶层目录      │
 * │ （scratchFilter）——Next.js 导出的 _next/ 就是。                     │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface SeedLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export const SEED_LIMITS: SeedLimits = {
  /** 单个文件。与附件、copy_file、快照同一个数：附得进来的才拷得动。 */
  maxFileBytes: MAX_ATTACH_BYTES,
  /**
   * 整个页面。快照每一轮开工前都要把整个工作区过一遍（算 sha256），预览、
   * search_files 也都按整个目录走——几百 MB 的工作区每说一句话都要等。
   * 这个平台上的页面 50 MB 已经是极端情况。
   */
  maxTotalBytes: 50 * 1024 * 1024,
  maxFiles: 2000,
};

export type SeedOutcome =
  | { ok: true; files: number; bytes: number }
  | { ok: false; reason: string };

/**
 * 这个人这个页面的线上版本目录：/srv/sites/{username}/{slug} 这条软链指向的那个 release。
 *
 * 没有、或者不可信，都返回 null：
 *   · slug 不合法——它会拼进路径，"../别人/页面"必须在这里挡住
 *   · 不是软链——平台只建软链，真实目录是有人手工放的（switchSymlink 同样不认）
 *   · 软链指出了 /srv/releases/{username}/{slug}/——不管指向哪儿，都不是这个页面的版本
 *   · 版本里没有 index.html
 */
export async function liveRelease(storage: StorageConfig, username: string, slug: string): Promise<string | null> {
  if (!appSlugSchema.safeParse(slug).success) return null;
  const link = siteLink(storage, username, slug);
  const st = await lstat(link).catch(() => null);
  if (!st?.isSymbolicLink()) return null;

  const [real, home] = await Promise.all([
    realpath(link).catch(() => null),
    realpath(join(storage.releasesRoot, username, slug)).catch(() => null),
  ]);
  if (!real || !home || !real.startsWith(home + sep)) return null;
  const index = await lstat(join(real, 'index.html')).catch(() => null);
  return index?.isFile() ? real : null;
}

/**
 * 把线上版本拷进 dest（一个还不存在的目录）。拷不全就什么都不拷，返回原因。
 *
 * 只认普通文件和目录，符号链接一律不跟：版本目录是从 zip 解出来、或从工作区
 * 拷出来的，正常不会有链接；真有的话它可能指向任何地方，包括别人的目录。
 */
export async function copyRelease(src: string, dest: string, limits: SeedLimits = SEED_LIMITS): Promise<SeedOutcome> {
  const plan = await planCopy(src, limits);
  if ('reason' in plan) return { ok: false, reason: plan.reason };

  await mkdir(dest, { recursive: true });
  for (const d of plan.dirs) await mkdir(join(dest, d), { recursive: true });
  for (const f of plan.files) {
    // 注入只动根目录的 index.html（injectShellScript），子目录里的同名文件原样拷
    if (f === 'index.html') {
      await writeFile(join(dest, f), stripShellScript(await readFile(join(src, f), 'utf8')), 'utf8');
    } else {
      await copyFile(join(src, f), join(dest, f));
    }
  }
  return { ok: true, files: plan.files.length, bytes: plan.bytes };
}

async function planCopy(
  src: string,
  limits: SeedLimits,
): Promise<{ dirs: string[]; files: string[]; bytes: number } | { reason: string }> {
  const publishes = scratchFilter(src);
  const dirs: string[] = [];
  const files: string[] = [];
  let bytes = 0;
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

  const walk = async (dir: string, rel: string): Promise<string | null> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (!rel && e.name === AUTO_COVER_FILE) continue;
      if (!publishes(abs)) {
        return `线上版本里有 ${e.name}——在 iSpace 里发布时下划线开头的顶层目录和文件不会发出去，拷进来改完再发，它就丢了`;
      }
      // Dirent 不跟链接：链接既不是 isDirectory 也不是 isFile，落到下面拒掉
      if (e.isDirectory()) {
        dirs.push(r);
        const why = await walk(abs, r);
        if (why) return why;
        continue;
      }
      if (!e.isFile()) return `线上版本里的 ${r} 不是普通文件`;
      const { size } = await lstat(abs);
      if (size > limits.maxFileBytes) return `${r} 有 ${mb(size)}，超过单个文件 ${mb(limits.maxFileBytes)} 的上限`;
      bytes += size;
      files.push(r);
      if (bytes > limits.maxTotalBytes) return `整个页面超过 ${mb(limits.maxTotalBytes)}`;
      if (files.length > limits.maxFiles) return `文件超过 ${limits.maxFiles} 个`;
    }
    return null;
  };

  const why = await walk(src, '');
  return why ? { reason: why } : { dirs, files, bytes };
}
