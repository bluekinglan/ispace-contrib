import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { User } from '@ispace/contracts';
import { siteLink } from '@ispace/storage';
import { MemoryAgentStore } from '../services/agent-store.js';
import { MAX_ATTACH_BYTES } from '../services/attachments.js';
import { AUTO_COVER_FILE } from '../services/deploy.js';
import { liveRelease } from '../services/release-seed.js';
import { SessionWorkspaces } from '../services/session-workspace.js';
import { LEGACY_KEY, Workspaces } from '../services/workspaces.js';
import { fromWorkspace, publish, tempStorage, withFiles } from './release-fixture.js';

/**
 * 「这条会话改的是哪个工作区」。每一条都对应一个"人的东西看起来消失了"
 * 或"两个页面混在一起"的真实场景。
 */

const me = { id: 'u-me', username: 'lixiao' } as User;
const other = { id: 'u-other', username: 'wangkai' } as User;
const OLD_ID = '11111111-1111-4111-8111-111111111111';

const setup = (withLegacy = false) => {
  const root = mkdtempSync(join(tmpdir(), 'ispace-sw-'));
  if (withLegacy) {
    mkdirSync(join(root, 'lixiao'), { recursive: true });
    writeFileSync(join(root, 'lixiao', 'index.html'), '<h1>改版前做的</h1>');
  }
  let t = 0;
  const store = new MemoryAgentStore(() => (t += 1000));
  const ws = new Workspaces(root);
  // 线上版本目录一直给着：下面那些没发布过东西的用例，顺带钉住"线上没有就照旧"
  const storage = tempStorage();
  return { root, store, ws, storage, sw: new SessionWorkspaces(store, ws, storage) };
};

/** 这个人有哪些工作区（不含 .ispace）。 */
const workspaces = (ws: Workspaces, username = 'lixiao') =>
  readdirSync(ws.userDir(username)).filter((n) => !n.startsWith('.')).sort();

describe('会话 → 工作区', () => {
  it('两次创建是两个工作区——第二个页面不再和第一个混在一起', async () => {
    const { sw, ws } = setup();
    const a = await sw.begin(me);
    const b = await sw.begin(me);
    expect(a.workspace).toBe(a.id);
    expect(b.workspace).not.toBe(a.workspace);
    expect(existsSync(ws.dir('lixiao', a.workspace))).toBe(true);
  });

  it('同一条会话的后续对话留在同一个工作区', async () => {
    const { sw } = setup();
    const a = await sw.begin(me);
    const r = await sw.forAsk(me, { sessionId: a.id });
    expect(r.record.workspace).toBe(a.workspace);
    expect(r.switched).toBe(false);
  });

  it('不是本人的会话拒绝——不管是对话还是只读', async () => {
    const { sw } = setup();
    const a = await sw.begin(me);
    await expect(sw.forAsk(other, { sessionId: a.id })).rejects.toThrow(/不属于你/);
    await expect(sw.keyFor(other, a.id)).rejects.toThrow(/不属于你/);
  });

  it('刷新前开着的工作台带着改版前的会话 id 回来：接回 legacy，东西还在', async () => {
    const { sw } = setup(true);
    const r = await sw.forAsk(me, { sessionId: OLD_ID });
    expect(r.record.id).toBe(OLD_ID);
    expect(r.record.workspace).toBe(LEGACY_KEY);
    expect(await sw.keyFor(me, OLD_ID)).toBe(LEGACY_KEY); // 预览指着同一个目录
  });

  it('会话记录被清掉、工作区还在时，认回它自己的工作区而不是 legacy', async () => {
    const { sw, ws } = setup(true);
    await ws.open('lixiao', OLD_ID);
    expect(await sw.keyFor(me, OLD_ID)).toBe(OLD_ID);
    expect((await sw.forAsk(me, { sessionId: OLD_ID })).record.workspace).toBe(OLD_ID);
  });

  it('没有 legacy 的人带着陌生 id 来，就用这个 id 开一个新的', async () => {
    const { sw } = setup(false);
    expect((await sw.forAsk(me, { sessionId: OLD_ID })).record.workspace).toBe(OLD_ID);
  });

  it('改一个发布过的页面：找回当初做它的那个工作区', async () => {
    const { sw, store } = setup(true);
    const made = await sw.begin(me);
    await store.save(made.id, { slug: 'zhoubao' }); // 发布成功时绑定
    const r = await sw.forAsk(me, { targetSlug: 'zhoubao' });
    expect(r.record.workspace).toBe(made.workspace);
    expect(r.record.id).not.toBe(made.id); // 新会话，旧工作区
  });

  it('改一个线上也没有的页面：落到 legacy（和改版前一样）', async () => {
    const { sw } = setup(true);
    const r = await sw.forAsk(me, { targetSlug: 'jiuye' });
    expect(r.record.workspace).toBe(LEGACY_KEY);
    expect(r.seed).toBeNull();
  });

  it('手机壳中途换了要改的页面：同一条会话切到那个页面的工作区，并告诉调用方换了', async () => {
    const { sw, store } = setup();
    const a = await sw.begin(me);
    await store.save(a.id, { slug: 'a-page' });
    const b = await sw.begin(me);
    await store.save(b.id, { slug: 'b-page' });

    const chat = await sw.forAsk(me, { targetSlug: 'a-page' });
    expect(chat.record.workspace).toBe(a.workspace);
    const again = await sw.forAsk(me, { sessionId: chat.record.id, targetSlug: 'a-page' });
    expect(again.switched).toBe(false);
    const moved = await sw.forAsk(me, { sessionId: chat.record.id, targetSlug: 'b-page' });
    expect(moved.switched).toBe(true);
    expect(moved.record.workspace).toBe(b.workspace);
    expect((await store.get(chat.record.id))!.workspace).toBe(b.workspace);
  });

  it('自己刚发布的页面再说一句：不切走', async () => {
    const { sw, store } = setup(true);
    const a = await sw.begin(me);
    await store.save(a.id, { slug: 'zhoubao' });
    const r = await sw.forAsk(me, { sessionId: a.id, targetSlug: 'zhoubao' });
    expect(r.switched).toBe(false);
    expect(r.record.workspace).toBe(a.workspace);
  });

  it('不带会话 id 的老客户端：最近在做的那个，没有就 legacy，再没有就开一个', async () => {
    const legacyOnly = setup(true);
    expect(await legacyOnly.sw.keyFor(me)).toBe(LEGACY_KEY);
    const a = await legacyOnly.sw.begin(me);
    expect(await legacyOnly.sw.keyFor(me)).toBe(a.workspace);

    const empty = setup(false);
    const k = await empty.sw.keyFor(me);
    expect(existsSync(empty.ws.dir('lixiao', k))).toBe(true);
  });

  it('陌生 id 不是合法的工作区键就拒绝，不拿它拼路径', async () => {
    const { sw } = setup();
    await expect(sw.keyFor(me, '../../etc')).rejects.toThrow(/不合法/);
  });
});

/*
  改一个没有工作区的页面（CLI/MCP 发的，或改版前 Agent 发的）。线上那份要
  原样回到工作区里——除了发布链路自己加的两样：注入的平台脚本、截的封面。
*/
const PAGE = '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>周报</title>\n</head>\n'
  + '<body>\n  <h1>本周</h1>\n  <script src="app.js"></script>\n</body>\n</html>\n';
const BIN = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const LIVE = {
  'index.html': PAGE,
  'app.js': 'console.log("周报")',
  'assets/logo.png': BIN,
  'about/index.html': '<p>关于</p>',
  '.well-known/x.txt': 'dot',
};
const markers = (s: string) => s.split('data-ispace-shell').length - 1;

describe('改一个没有工作区的页面：从线上版本拷一份', () => {
  it('没有工作区时从线上拷出一个新的，当场绑上 slug——即便有 legacy 也不用它', async () => {
    const { sw, ws, store, storage } = setup(true);
    await publish(storage, 'lixiao', 'zhoubao', 1, withFiles(LIVE));

    const r = await sw.forAsk(me, { targetSlug: 'zhoubao' });
    expect(r.seed).toEqual({ ok: true, files: 5, bytes: expect.any(Number) });
    expect(r.record.workspace).not.toBe(LEGACY_KEY);
    expect(r.record.slug).toBe('zhoubao');
    expect(await store.workspaceForSlug(me.id, 'zhoubao')).toBe(r.record.workspace);

    const dir = ws.dir('lixiao', r.record.workspace);
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe(LIVE['app.js']);
    expect(readFileSync(join(dir, 'assets/logo.png'))).toEqual(BIN);
    expect(readFileSync(join(dir, 'about/index.html'), 'utf8')).toBe(LIVE['about/index.html']);
    expect(readFileSync(join(dir, '.well-known/x.txt'), 'utf8')).toBe('dot');
    expect(readdirSync(join(ws.userDir('lixiao'), '.ispace', 'seeding'))).toEqual([]); // 暂存没留下东西
  });

  it('拷出来的 index.html 没有注入的平台脚本、根目录没有平台截的封面；线上那份一个字节没动', async () => {
    const { sw, ws, storage } = setup();
    const release = await publish(storage, 'lixiao', 'zhoubao', 1, withFiles(LIVE));
    const liveIndex = readFileSync(join(release, 'index.html'), 'utf8');
    expect(markers(liveIndex)).toBe(1);

    const dir = ws.dir('lixiao', (await sw.forAsk(me, { targetSlug: 'zhoubao' })).record.workspace);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(PAGE);
    expect(existsSync(join(dir, AUTO_COVER_FILE))).toBe(false);

    expect(readFileSync(join(release, 'index.html'), 'utf8')).toBe(liveIndex);
    expect(existsSync(join(release, AUTO_COVER_FILE))).toBe(true);
  });

  it('再说一句、或者再开一条会话：找回拷出来的那个，不再拷第二份，前面改的还在', async () => {
    const { sw, ws, storage } = setup(true);
    await publish(storage, 'lixiao', 'zhoubao', 1, withFiles(LIVE));
    const first = await sw.forAsk(me, { targetSlug: 'zhoubao' });
    writeFileSync(join(ws.dir('lixiao', first.record.workspace), 'app.js'), '改过了');

    const again = await sw.forAsk(me, { sessionId: first.record.id, targetSlug: 'zhoubao' });
    const next = await sw.forAsk(me, { targetSlug: 'zhoubao' });
    for (const r of [again, next]) {
      expect(r.seed).toBeNull();
      expect(r.record.workspace).toBe(first.record.workspace);
    }
    expect(readFileSync(join(ws.dir('lixiao', next.record.workspace), 'app.js'), 'utf8')).toBe('改过了');
    expect(workspaces(ws)).toEqual([LEGACY_KEY, first.record.workspace].sort());
  });

  it('改完重新发布，会话过了保留期再拷一次：脚本只有一份，不会越叠越多', async () => {
    const { ws, storage, root } = setup();
    await publish(storage, 'lixiao', 'zhoubao', 1, withFiles(LIVE));
    let index = PAGE;

    for (let round = 2; round <= 4; round++) {
      // 每一轮都是新的会话表：上一轮的绑定已经被清掉了，只能再从线上拷
      const sw = new SessionWorkspaces(new MemoryAgentStore(), new Workspaces(root), storage);
      const r = await sw.forAsk(me, { targetSlug: 'zhoubao' });
      expect(r.seed?.ok).toBe(true);
      const dir = ws.dir('lixiao', r.record.workspace);
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(index);
      expect(existsSync(join(dir, AUTO_COVER_FILE))).toBe(false);

      index = index.replace('</h1>', `·第${round}版</h1>`);
      writeFileSync(join(dir, 'index.html'), index);
      const release = await publish(storage, 'lixiao', 'zhoubao', round, fromWorkspace(dir));
      const live = readFileSync(join(release, 'index.html'), 'utf8');
      expect(markers(live)).toBe(1);
      expect(readdirSync(release).filter((n) => n === AUTO_COVER_FILE)).toHaveLength(1);
    }
  });

  it('手机壳中途换到一个没有工作区的页面：切过去、绑上，并告诉调用方换了', async () => {
    const { sw, store, storage } = setup();
    const a = await sw.begin(me);
    await store.save(a.id, { slug: 'a-page' });
    await publish(storage, 'lixiao', 'jiuye', 1, withFiles(LIVE));

    const moved = await sw.forAsk(me, { sessionId: a.id, targetSlug: 'jiuye' });
    expect(moved.switched).toBe(true);
    expect(moved.seed?.ok).toBe(true);
    expect(moved.record.workspace).not.toBe(a.workspace);
    expect(moved.record.slug).toBe('jiuye');
    expect(await store.get(a.id)).toMatchObject({ workspace: moved.record.workspace, slug: 'jiuye' });
  });

  it('拷不全就一个都不拷：线上有 _next/ 这种在这里发布会丢掉的东西，照旧落到 legacy，并说明原因', async () => {
    const { sw, ws, storage } = setup(true);
    await publish(storage, 'lixiao', 'docs', 1, withFiles({ ...LIVE, '_next/static/app.js': 'x' }));

    const r = await sw.forAsk(me, { targetSlug: 'docs' });
    expect(r.seed).toMatchObject({ ok: false, reason: expect.stringContaining('_next') });
    expect(r.record.workspace).toBe(LEGACY_KEY);
    expect(r.record.slug).toBeNull(); // 没拷成不绑：下一句还会再看一眼线上
    expect(workspaces(ws)).toEqual([LEGACY_KEY]);
    expect(readdirSync(join(ws.userDir('lixiao'), '.ispace', 'seeding'))).toEqual([]);
  });

  it('单个文件超过附件上限（10 MB）也整份不拷；没有 legacy 就落到会话自己的', async () => {
    const { sw, ws, storage } = setup();
    await publish(storage, 'lixiao', 'video', 1, (dest) => {
      withFiles(LIVE)(dest);
      writeFileSync(join(dest, 'intro.mp4'), '');
      truncateSync(join(dest, 'intro.mp4'), MAX_ATTACH_BYTES + 1);
    });

    const r = await sw.forAsk(me, { targetSlug: 'video' });
    expect(r.seed).toMatchObject({ ok: false, reason: expect.stringContaining('intro.mp4') });
    expect(r.record.workspace).toBe(r.record.id);
    expect(readdirSync(ws.dir('lixiao', r.record.workspace))).toEqual([]);
  });
});

describe('从线上拷，绝不越到别人的目录', () => {
  it('slug 里带 ../：拷不到别人的页面', async () => {
    const { sw, ws, storage } = setup();
    await publish(storage, 'wangkai', 'secret', 1, withFiles({ 'index.html': '<p>王凯的</p>' }));

    for (const slug of ['../wangkai/secret', '..', 'a/../../wangkai/secret', '/etc']) {
      expect(await liveRelease(storage, 'lixiao', slug)).toBeNull();
      const r = await sw.forAsk(me, { targetSlug: slug });
      expect(r.seed).toBeNull();
      expect(readdirSync(ws.dir('lixiao', r.record.workspace))).toEqual([]);
    }
  });

  it('别人有同名页面、我没有：不拿他的', async () => {
    const { sw, storage } = setup();
    await publish(storage, 'wangkai', 'zhoubao', 1, withFiles(LIVE));
    expect((await sw.forAsk(me, { targetSlug: 'zhoubao' })).seed).toBeNull();
  });

  it('我的软链被指到别人的版本目录：不认', async () => {
    const { sw, storage } = setup();
    const theirs = await publish(storage, 'wangkai', 'zhoubao', 1, withFiles(LIVE));
    mkdirSync(join(storage.sitesRoot, 'lixiao'), { recursive: true });
    symlinkSync(theirs, siteLink(storage, 'lixiao', 'zhoubao'));
    // 我自己也有这个页面的版本目录，链接却指出去了
    mkdirSync(join(storage.releasesRoot, 'lixiao', 'zhoubao'), { recursive: true });

    expect(await liveRelease(storage, 'lixiao', 'zhoubao')).toBeNull();
    expect((await sw.forAsk(me, { targetSlug: 'zhoubao' })).seed).toBeNull();
  });

  it('版本目录里有指向别人文件或目录的链接：不跟，整份不拷', async () => {
    const { sw, ws, storage } = setup();
    const theirs = await publish(storage, 'wangkai', 'secret', 1, withFiles({ 'index.html': '<p>王凯的</p>' }));

    for (const [slug, link] of [['leak-file', 'leak.html'], ['leak-dir', 'assets']] as const) {
      await publish(storage, 'lixiao', slug, 1, (dest) => {
        withFiles({ 'index.html': PAGE })(dest);
        symlinkSync(link === 'assets' ? theirs : join(theirs, 'index.html'), join(dest, link));
      });
      const r = await sw.forAsk(me, { targetSlug: slug });
      expect(r.seed).toMatchObject({ ok: false, reason: expect.stringContaining(link) });
      expect(readdirSync(ws.dir('lixiao', r.record.workspace))).toEqual([]);
    }
  });
});
