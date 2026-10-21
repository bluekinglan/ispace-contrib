import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_KEY, Workspaces } from '../services/workspaces.js';

/**
 * 按页面分工作区，以及改版前那个"每人一个"的工作区怎么搬。
 *
 * 要钉住的是两件事：搬家一个字节都不丢；搬家中途断了，下次能接着搬完，
 * 而不是把已经搬好的 legacy 当成旧文件再套一层。
 */

const root = () => mkdtempSync(join(tmpdir(), 'ispace-wsroot-'));

/** 造一个改版前的工作区：文件直接在 {username}/ 下面。 */
const legacyLayout = (r: string, user = 'lixiao') => {
  const home = join(r, user);
  mkdirSync(join(home, 'assets'), { recursive: true });
  mkdirSync(join(home, '_fanout', 'ab12', 'mono'), { recursive: true });
  writeFileSync(join(home, 'index.html'), '<h1>旧页面</h1>');
  writeFileSync(join(home, 'assets', 'a.css'), 'body{}');
  writeFileSync(join(home, '.env'), 'X=1');
  writeFileSync(join(home, '_fanout', 'ab12', 'mono', 'index.html'), '草案');
  return home;
};

describe('工作区布局', () => {
  it('新用户：建好目录与标记，没有 legacy', async () => {
    const w = new Workspaces(root());
    const dir = await w.open('newbie', 'a1b2c3d4-0000-4000-8000-000000000001');
    expect(existsSync(dir)).toBe(true);
    expect(await w.hasLegacy('newbie')).toBe(false);
    expect(existsSync(join(w.userDir('newbie'), '.ispace', 'layout.json'))).toBe(true);
  });

  it('改版前的文件原样搬进 legacy/，一个都不少，包括点文件与扇出草稿', async () => {
    const r = root();
    legacyLayout(r);
    const w = new Workspaces(r);
    await w.ensureLayout('lixiao');

    const legacy = w.dir('lixiao', LEGACY_KEY);
    expect(readFileSync(join(legacy, 'index.html'), 'utf8')).toBe('<h1>旧页面</h1>');
    expect(readFileSync(join(legacy, 'assets', 'a.css'), 'utf8')).toBe('body{}');
    expect(readFileSync(join(legacy, '.env'), 'utf8')).toBe('X=1');
    expect(existsSync(join(legacy, '_fanout', 'ab12', 'mono', 'index.html'))).toBe(true);
    /* 根目录里只剩 legacy 与平台目录 */
    expect(readdirSync(w.userDir('lixiao')).sort()).toEqual(['.ispace', 'legacy']);
    const marker = JSON.parse(readFileSync(join(w.userDir('lixiao'), '.ispace', 'layout.json'), 'utf8'));
    expect(marker.moved.sort()).toEqual(['.env', '_fanout', 'assets', 'index.html']);
  });

  it('幂等：再进来一次不会把 legacy 再套一层', async () => {
    const r = root();
    legacyLayout(r);
    await new Workspaces(r).ensureLayout('lixiao');
    const w2 = new Workspaces(r); // 模拟重启后的新进程
    await w2.ensureLayout('lixiao');
    expect(existsSync(join(w2.dir('lixiao', LEGACY_KEY), 'index.html'))).toBe(true);
    expect(existsSync(join(w2.dir('lixiao', LEGACY_KEY), 'legacy'))).toBe(false);
  });

  it('旧根目录里恰好有个叫 legacy 的文件夹，也只是当普通旧文件搬进去', async () => {
    const r = root();
    const home = legacyLayout(r);
    mkdirSync(join(home, 'legacy'));
    writeFileSync(join(home, 'legacy', 'note.txt'), '我自己的');
    const w = new Workspaces(r);
    await w.ensureLayout('lixiao');
    expect(readFileSync(join(w.dir('lixiao', LEGACY_KEY), 'legacy', 'note.txt'), 'utf8')).toBe('我自己的');
    expect(existsSync(join(w.dir('lixiao', LEGACY_KEY), 'index.html'))).toBe(true);
  });

  it('搬到一半断了（一部分已进中转目录、标记还没写），下次接着搬完', async () => {
    const r = root();
    const home = legacyLayout(r);
    mkdirSync(join(home, '.migrating'));
    renameSync(join(home, 'index.html'), join(home, '.migrating', 'index.html'));
    const w = new Workspaces(r);
    await w.ensureLayout('lixiao');
    const legacy = w.dir('lixiao', LEGACY_KEY);
    expect(existsSync(join(legacy, 'index.html'))).toBe(true);
    expect(existsSync(join(legacy, 'assets', 'a.css'))).toBe(true);
    expect(existsSync(join(home, '.migrating'))).toBe(false);
  });

  it('标记写了、改名还没做就断了，下次只补改名', async () => {
    const r = root();
    const home = join(r, 'lixiao');
    mkdirSync(join(home, '.migrating'), { recursive: true });
    writeFileSync(join(home, '.migrating', 'index.html'), '旧');
    mkdirSync(join(home, '.ispace'));
    writeFileSync(join(home, '.ispace', 'layout.json'), '{"version":2}');
    const w = new Workspaces(r);
    await w.ensureLayout('lixiao');
    expect(readFileSync(join(home, 'legacy', 'index.html'), 'utf8')).toBe('旧');
  });

  it('同一进程里并发进来的请求只搬一次', async () => {
    const r = root();
    legacyLayout(r);
    const w = new Workspaces(r);
    await Promise.all([w.ensureLayout('lixiao'), w.ensureLayout('lixiao'), w.open('lixiao', 'abc')]);
    expect(readdirSync(w.userDir('lixiao')).sort()).toEqual(['.ispace', 'abc', 'legacy']);
  });

  it('工作区键只认小写字母数字与连字符，点开头、带斜杠的一律拒绝', () => {
    const w = new Workspaces(root());
    expect(() => w.dir('lixiao', '.ispace')).toThrow(/不合法/);
    expect(() => w.dir('lixiao', '../other')).toThrow(/不合法/);
    expect(() => w.dir('lixiao', 'a/b')).toThrow(/不合法/);
    expect(() => w.dir('lixiao', 'A1')).toThrow(/不合法/);
    expect(w.dir('lixiao', 'a1b2c3d4-0000-4000-8000-000000000001')).toContain('lixiao');
  });

  it('快照目录在工作区外面——快照不能跟着发布出去', () => {
    const w = new Workspaces(root());
    const ws = w.dir('lixiao', 'abc');
    expect(w.snapshotDir('lixiao', 'abc').startsWith(ws)).toBe(false);
  });
});
