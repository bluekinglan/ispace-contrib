import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * 按页面分的工作区（docs/specs/2026-10-21-agent-harness.md §1）。
 *
 *   /srv/workspaces/{username}/{key}/       一个工作区 = 一次「创建」
 *   /srv/workspaces/{username}/legacy/      改版前那个"每人一个"的工作区，原样搬进来
 *   /srv/workspaces/{username}/.ispace/     平台自己的东西：布局标记、快照
 *
 * ┌─ 为什么要分 ────────────────────────────────────────────────────────┐
 * │ 原来一个人只有一个工作区。做第二个页面时，第一个的文件还在里面：模 │
 * │ 型 list_files 看见一堆不相干的东西，常常就地改起来；发布时整个目录 │
 * │ 一起发出去，第二个页面的产物里带着第一个页面的全部文件。           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 为什么键是会话 id，而不是页面 slug ────────────────────────────────┐
 * │ 开工时还不知道 slug——它要等模型 request_deploy 才定下来，而工作区   │
 * │ 在那之前就得存在（预览、扇出都要往里写）。拿 slug 当目录名就得在发布 │
 * │ 那一刻改名，而改名时预览、会话、前端手里的地址全都指着旧名字。      │
 * │                                                                    │
 * │ 所以目录名定下就不变，slug → 工作区的对应关系记在会话表里           │
 * │ （agent_sessions.slug，发布成功才写）。「改 /zhoubao/」时按它找回。 │
 * └────────────────────────────────────────────────────────────────────┘
 */

/** 改版前的工作区搬进来之后叫这个名字。不是 uuid，不会和会话 id 撞。 */
export const LEGACY_KEY = 'legacy';

/** 工作区键：会话 id（uuid）或 legacy。小写字母数字和连字符，不以点开头——.ispace 永远不是工作区。 */
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 平台目录与搬家中转目录。都以点开头，list_files 与「代码」页天然看不见。 */
const META = '.ispace';
const MOVING = '.migrating';
const MARKER = 'layout.json';

export class Workspaces {
  /** 每个人只搬一次家。同一进程里并发进来的请求等同一个 Promise。 */
  private readonly ready = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  userDir(username: string): string {
    return join(this.root, username);
  }

  /** 这个工作区的快照放哪儿。在工作区外面：快照不能跟着发布出去，也不该出现在文件树里。 */
  snapshotDir(username: string, key: string): string {
    this.assertKey(key);
    return join(this.userDir(username), META, 'snapshots', key);
  }

  /** 工作区的绝对路径。不建目录、不搬家——只读场景（文件树、预览）用它。 */
  dir(username: string, key: string): string {
    this.assertKey(key);
    return join(this.userDir(username), key);
  }

  /** 确保布局已就绪、目录存在，返回绝对路径。要往里写之前调它。 */
  async open(username: string, key: string): Promise<string> {
    await this.ensureLayout(username);
    const d = this.dir(username, key);
    await mkdir(d, { recursive: true });
    return d;
  }

  /** 这个人有没有改版前留下的工作区。 */
  async hasLegacy(username: string): Promise<boolean> {
    await this.ensureLayout(username);
    return existsSync(this.dir(username, LEGACY_KEY));
  }

  isKey(key: string): boolean {
    return KEY_RE.test(key);
  }

  /**
   * 把改版前的布局搬成新布局。幂等，每人一次。
   *
   * ┌─ 存量怎么处理：搬，不删，也不猜 ──────────────────────────────────┐
   * │ 改版前工作区根目录里直接就是文件（index.html、assets/、_fanout/…）。│
   * │ 新布局下根目录里只该有工作区目录，于是把原有的**全部**东西原样搬进 │
   * │ legacy/。一个字节都不删：                                           │
   * │                                                                    │
   * │   · 不能就地留着——新工作区和旧文件混在同一层，旧文件里恰好有个叫  │
   * │     assets 的目录，就分不清它是文件夹还是工作区                      │
   * │   · 不能按 slug 拆——单工作区时代所有页面的文件都叠在一起，拆不开  │
   * │                                                                    │
   * │ 搬完之后人的东西不会"看起来消失"，靠的是两条兜底（routes/agent.ts）：│
   * │   · 刷新前开着的工作台带着旧会话 id 回来，会话表里查不到它——那就   │
   * │     是改版前的会话，接回 legacy                                     │
   * │   · 改一个从没在新布局下发布过的页面，同样落到 legacy——和改版前    │
   * │     的行为一致                                                       │
   * └────────────────────────────────────────────────────────────────────┘
   *
   * 中途崩溃也能接着搬：先把东西挪进 .migrating/，写标记，再把 .migrating
   * 改名成 legacy。哪一步断了，下次进来都认得出来、接着做完，不会把 legacy
   * 当成旧文件再搬一层。
   */
  ensureLayout(username: string): Promise<void> {
    let p = this.ready.get(username);
    if (!p) {
      p = this.migrate(username).catch((e) => {
        this.ready.delete(username); // 失败了下次再试，别把失败缓存住
        throw e;
      });
      this.ready.set(username, p);
    }
    return p;
  }

  private async migrate(username: string): Promise<void> {
    const home = this.userDir(username);
    const meta = join(home, META);
    const marker = join(meta, MARKER);
    const moving = join(home, MOVING);
    const legacy = join(home, LEGACY_KEY);

    if (existsSync(marker)) {
      // 上次写了标记、还没来得及改名就断了
      if (existsSync(moving) && !existsSync(legacy)) await rename(moving, legacy);
      return;
    }

    await mkdir(home, { recursive: true });
    const olds = (await readdir(home)).filter((n) => n !== META && n !== MOVING);
    const hadMoving = existsSync(moving);
    if (olds.length || hadMoving) {
      await mkdir(moving, { recursive: true });
      for (const n of olds) await rename(join(home, n), join(moving, n));
    }

    await mkdir(meta, { recursive: true });
    await writeFile(marker, JSON.stringify({
      version: 2,
      migratedAt: new Date().toISOString(),
      /* 留个底：搬了哪些东西。出了问题时人工对账用 */
      moved: olds,
    }, null, 2));

    if (olds.length || hadMoving) await rename(moving, legacy);
  }

  private assertKey(key: string): void {
    if (!KEY_RE.test(key)) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, `工作区标识不合法：${key}`);
    }
  }
}
