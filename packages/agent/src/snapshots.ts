import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/**
 * 工作区快照：每一轮开工前拍一张，「撤回这一步」时退回去。
 *
 * ┌─ 为什么要它 ────────────────────────────────────────────────────────┐
 * │ 模型改坏东西是常态，不是意外：一句"把标题改大一点"，它顺手把整页的 │
 * │ 配色也重写了。原来唯一的退路是再说一句"改回去"——让同一个模型凭记  │
 * │ 忆把它刚弄坏的东西复原，十次里有几次复原得不对，而且要再等一轮、再  │
 * │ 花一轮的钱。                                                        │
 * │                                                                    │
 * │ 快照让"撤回"变成一个确定的动作：文件回到这一轮开始前的样子，对话也  │
 * │ 截回那一刻，模型不会记得一段已经不存在的改动。                       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 为什么按内容寻址，而不是每次整个拷一份 ────────────────────────────┐
 * │ 一轮通常只改一两个文件，而工作区里可能躺着几张 2 MB 的生成图。整拷  │
 * │ 的话十轮就是十份图。按 sha256 存 blob，没变的文件所有快照共用一份，  │
 * │ 一张快照只是一页"路径 → 哈希"的清单。                               │
 * │                                                                    │
 * │ 也不用硬链接省空间：write_file 是原地截断重写，硬链接会让快照跟着被 │
 * │ 改掉——那就不是快照了。                                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 不管的东西：node_modules、.git、顶层 `_` 开头的平台草稿（_fanout）。草稿不
 * 是页面的一部分；撤回时把扇出的六版设计也一并删掉，人会以为扇出坏了。
 */

export interface SnapshotMeta {
  seq: number;
  at: number;
  /** 哪条会话拍的。撤回只退自己会话拍的那张。 */
  sessionId: string;
  /** 拍照那一刻会话里有几条消息（不含 system）。撤回时对话截回这个长度。 */
  messageCount: number;
  /** 这一轮用户说的话，撤回后放回输入框、也用于提示"撤回了哪一步"。 */
  label: string;
}

interface Manifest extends SnapshotMeta {
  /** 相对路径 → sha256。 */
  files: Record<string, string>;
}

/** 留几张。够人连撤好几步，又不至于无限长。 */
const DEFAULT_KEEP = 30;
/** 单文件超过这个大小不进快照：多半是人上传的大附件，拷它的代价远大于撤回它的价值。 */
const MAX_SNAPSHOT_FILE = 10 * 1024 * 1024;

export class Snapshots {
  private readonly blobs: string;

  /**
   * @param dir   快照存放目录（工作区**外面**，见 deploy-service 的 Workspaces.snapshotDir）
   * @param root  工作区根目录
   */
  constructor(
    private readonly dir: string,
    private readonly root: string,
    private readonly keep = DEFAULT_KEEP,
  ) {
    this.blobs = join(dir, 'blobs');
  }

  /** 拍一张。返回它的元信息。 */
  async take(meta: Omit<SnapshotMeta, 'seq' | 'at'>): Promise<SnapshotMeta> {
    await mkdir(this.blobs, { recursive: true });
    const files: Record<string, string> = {};
    for (const [rel, abs] of await this.walk()) {
      const buf = await readFile(abs);
      const sha = createHash('sha256').update(buf).digest('hex');
      const blob = join(this.blobs, sha);
      if (!existsSync(blob)) await writeFile(blob, buf);
      files[rel] = sha;
    }
    const seq = ((await this.list()).at(-1)?.seq ?? 0) + 1;
    const m: Manifest = { ...meta, seq, at: Date.now(), files };
    await writeFile(this.manifestPath(seq), JSON.stringify(m));
    await this.prune();
    const { files: _f, ...out } = m;
    return out;
  }

  /** 全部快照，按拍摄顺序。 */
  async list(): Promise<SnapshotMeta[]> {
    if (!existsSync(this.dir)) return [];
    const names = (await readdir(this.dir)).filter((n) => /^\d+\.json$/.test(n));
    const metas: SnapshotMeta[] = [];
    for (const n of names) {
      const m = await this.read(Number(n.slice(0, -5)));
      if (m) {
        const { files: _f, ...meta } = m;
        metas.push(meta);
      }
    }
    return metas.sort((a, b) => a.seq - b.seq);
  }

  /** 这条会话最近拍的那张。撤回就退到它。 */
  async lastFor(sessionId: string): Promise<SnapshotMeta | null> {
    return (await this.list()).filter((m) => m.sessionId === sessionId).at(-1) ?? null;
  }

  /**
   * 把工作区退回第 seq 张的样子。
   *
   * 只动快照管得着的那些文件：快照里有的写回去（内容一样就不碰），快照里
   * 没有的删掉；草稿目录、node_modules、超大文件一概不碰。
   */
  async restore(seq: number): Promise<{ written: number; removed: number }> {
    const m = await this.read(seq);
    if (!m) throw new Error(`没有第 ${seq} 张快照`);
    const now = await this.walk();
    let written = 0;
    let removed = 0;

    for (const [rel, abs] of now) {
      if (!(rel in m.files)) {
        await rm(abs, { force: true });
        removed += 1;
        await this.pruneEmptyDirs(dirname(abs));
      }
    }
    for (const [rel, sha] of Object.entries(m.files)) {
      /* 清单是平台自己写的，但还是别让一条坏路径把文件写到工作区外面去 */
      if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue;
      const abs = join(this.root, ...rel.split('/'));
      const cur = now.get(rel);
      if (cur && createHash('sha256').update(await readFile(cur)).digest('hex') === sha) continue;
      const blob = join(this.blobs, sha);
      if (!existsSync(blob)) continue; // blob 丢了（人工清过）就跳过，别为一个文件让整个撤回失败
      await mkdir(dirname(abs), { recursive: true });
      await copyFile(blob, abs);
      written += 1;
    }
    return { written, removed };
  }

  /**
   * 删掉几张（撤回用过的那张就该删，下一次撤回才会再往前退一步；退回到更早
   * 的某一版时，它之后的那几张也一起作废）。
   */
  async drop(...seqs: number[]): Promise<void> {
    for (const seq of seqs) await rm(this.manifestPath(seq), { force: true });
    if (seqs.length) await this.gc();
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private manifestPath(seq: number): string {
    return join(this.dir, `${String(seq).padStart(6, '0')}.json`);
  }

  private async read(seq: number): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(this.manifestPath(seq), 'utf8')) as Manifest;
    } catch {
      return null;
    }
  }

  /** 快照管得着的文件：相对路径（统一用 /）→ 绝对路径。 */
  private async walk(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const visit = async (d: string): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        if (d === this.root && e.name.startsWith('_')) continue;
        const abs = join(d, e.name);
        if (e.isDirectory()) await visit(abs);
        else if (e.isFile()) {
          const st = await stat(abs).catch(() => null);
          if (st && st.size <= MAX_SNAPSHOT_FILE) out.set(relative(this.root, abs).split(sep).join('/'), abs);
        }
      }
    };
    await visit(this.root);
    return out;
  }

  /** 删完文件留下的空目录一并收掉，但不碰工作区根。 */
  private async pruneEmptyDirs(d: string): Promise<void> {
    while (d.startsWith(this.root + sep)) {
      const left = await readdir(d).catch(() => null);
      if (!left || left.length) return;
      await rmdir(d).catch(() => {});
      d = dirname(d);
    }
  }

  /** 只留最近 keep 张，然后清掉没人引用的 blob。 */
  private async prune(): Promise<void> {
    const all = await this.list();
    const extra = all.slice(0, Math.max(0, all.length - this.keep));
    for (const m of extra) await rm(this.manifestPath(m.seq), { force: true });
    if (extra.length) await this.gc();
  }

  private async gc(): Promise<void> {
    if (!existsSync(this.blobs)) return;
    const used = new Set<string>();
    for (const m of await this.list()) {
      const full = await this.read(m.seq);
      for (const sha of Object.values(full?.files ?? {})) used.add(sha);
    }
    for (const b of await readdir(this.blobs)) {
      if (!used.has(b)) await rm(join(this.blobs, b), { force: true });
    }
  }
}
