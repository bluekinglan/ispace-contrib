import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { IspaceError } from '@ispace/contracts';
import type { PublishCheck } from '@ispace/agent';
import { adviceFor, basePathFindings, scanFiles } from '@ispace/scanner';
import { collectFiles, resolveArtifactRoot } from '@ispace/storage';
import { scratchFilter } from './deploy.js';

/**
 * 发布前自检：在工作区上跑一遍发布链路同一套扫描，只报告、不发布。
 *
 * ┌─ "同一套"落到字面上 ────────────────────────────────────────────────┐
 * │ 起因：线上 zongkelong/tianqi 写了 `innerHTML = 变量`，到用户点发布   │
 * │ 才被拦下。模型本可以自己改掉——前提是它在那之前就看得见扫描结果。  │
 * │                                                                    │
 * │ 所以这里每一步都和 DeployService.deploy 用同一个函数：拷进暂存时用  │
 * │ 同一个 scratchFilter（_fanout 这类草稿不算产物），认产物根用同一个  │
 * │ resolveArtifactRoot，扫描用同一个 scanFiles，根绝对路径检查与       │
 * │ checkBasePath 同一条正则。自检说干净，发布就不会因为这几条被拦。   │
 * │                                                                    │
 * │ 唯一不跑的是 gitleaks：它要起子进程、可能十几秒，自检会被模型调好  │
 * │ 几次。它是发布链路的第二道，发布时照跑。                            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 路径换算回**相对工作区**：产物根可能是工作区里的 dist/，扫描器报的是相对
 * 产物根的路径。原样交给模型，它会去改一个不存在的 index.html。
 */
export async function preflight(workspaceDir: string): Promise<PublishCheck> {
  if (!existsSync(workspaceDir)) {
    return { findings: [], error: '工作区还是空的，先把页面写出来。' };
  }
  const staging = await mkdtemp(join(tmpdir(), 'ispace-preflight-'));
  try {
    await cp(workspaceDir, staging, { recursive: true, filter: scratchFilter(workspaceDir) });

    let root: string;
    try {
      root = await resolveArtifactRoot(staging);
    } catch (e) {
      if (e instanceof IspaceError) return { findings: [], error: e.message };
      throw e;
    }
    const prefix = relative(staging, root);
    const toWs = (f: string) => (prefix ? `${prefix}${sep}${f}` : f).split(sep).join('/');

    const scan = scanFiles(await collectFiles(root), root);
    const html = await readFile(join(root, 'index.html'), 'utf8');
    const all = [...scan.findings, ...basePathFindings(html)];

    return {
      findings: all.map((f) => ({
        file: toWs(f.file), line: f.line, rule: f.rule, advice: adviceFor(f.rule),
      })),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
