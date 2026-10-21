import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { User } from '@ispace/contracts';
import { MemoryAgentStore } from '../services/agent-store.js';
import { SessionWorkspaces } from '../services/session-workspace.js';
import { LEGACY_KEY, Workspaces } from '../services/workspaces.js';

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
  return { root, store, ws, sw: new SessionWorkspaces(store, ws) };
};

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

  it('改一个从没在新布局下发布过的页面：落到 legacy（和改版前一样）', async () => {
    const { sw } = setup(true);
    expect((await sw.forAsk(me, { targetSlug: 'jiuye' })).record.workspace).toBe(LEGACY_KEY);
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
