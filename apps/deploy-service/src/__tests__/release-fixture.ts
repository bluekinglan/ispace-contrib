import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { injectShellScript, makeStamp, releaseDir, siteLink, switchSymlink, type StorageConfig } from '@ispace/storage';
import { AUTO_COVER_FILE, scratchFilter } from '../services/deploy.js';

/**
 * 线上版本的测试替身：照发布链路（services/deploy.ts）落盘的样子造一个版本——
 * 进 releases/{user}/{slug}/{ts}/、index.html 注入平台脚本、根目录放一张平台截的
 * 封面、切软链。去掉的只有库、扫描和 base path 校验，它们不改磁盘上的样子。
 */

export const tempStorage = (): StorageConfig => {
  const srv = mkdtempSync(join(tmpdir(), 'ispace-srv-'));
  return { sitesRoot: join(srv, 'sites'), releasesRoot: join(srv, 'releases') };
};

export const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type Fill = (dest: string) => void | Promise<void>;

export const withFiles = (files: Record<string, string | Buffer>): Fill => (dest) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    writeFileSync(join(dest, rel), body);
  }
};

/** Agent 发布那条路：从工作区拷，下划线开头的顶层目录不发（和 deploy.ts 同一个 scratchFilter）。 */
export const fromWorkspace = (dir: string): Fill => (dest) =>
  cp(dir, dest, { recursive: true, filter: scratchFilter(dir) });

export async function publish(
  storage: StorageConfig, username: string, slug: string, version: number, fill: Fill,
): Promise<string> {
  const dest = releaseDir(storage, username, slug, makeStamp(new Date(), version));
  mkdirSync(dest, { recursive: true });
  await fill(dest);
  await injectShellScript(join(dest, 'index.html'));
  writeFileSync(join(dest, AUTO_COVER_FILE), FAKE_PNG);
  await switchSymlink(siteLink(storage, username, slug), dest);
  return dest;
}
