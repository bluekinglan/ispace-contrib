import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { injectStorageShim, STORAGE_SHIM_JS } from '../services/sandbox-storage-shim.js';

/**
 * 沙箱框里的存储兜底。
 *
 * 线上 zongkelong/shandong-travel-guide：app.js 开头读 localStorage，在沙箱
 * （opaque origin）里一读就抛 SecurityError，后面关开场、绑滚动全没跑。
 * 真 Chrome 里前后各跑过一遍；这里钉住两件事：会抛时换成能用的，不抛时不动。
 */

/** 造一个"像沙箱里那样一碰就抛"的 window / document。 */
function sandboxed() {
  const deny = () => { throw new Error('SecurityError: The document is sandboxed'); };
  const window: Record<string, unknown> = {};
  const document: Record<string, unknown> = {};
  for (const n of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, n, { get: deny, configurable: true });
  }
  Object.defineProperty(document, 'cookie', { get: deny, set: deny, configurable: true });
  return { window, document };
}

describe('沙箱框里的存储兜底', () => {
  it('存储一碰就抛时，换成内存版：读写正常', () => {
    const ctx = sandboxed();
    runInNewContext(STORAGE_SHIM_JS, ctx);
    const ls = ctx.window.localStorage as Storage;
    expect(ls.getItem('fav')).toBeNull();
    ls.setItem('fav', '["taishan"]');
    expect(ls.getItem('fav')).toBe('["taishan"]');
    expect(ls.length).toBe(1);
    expect(ls.key(0)).toBe('fav');
    ls.removeItem('fav');
    expect(ls.length).toBe(0);
    (ctx.window.sessionStorage as Storage).setItem('s', '1');
    expect((ctx.window.sessionStorage as Storage).getItem('s')).toBe('1');

    ctx.document.cookie = 'seen=1; path=/';
    ctx.document.cookie = 'theme=dark';
    expect(ctx.document.cookie).toBe('seen=1; theme=dark');
  });

  it('存储本来就能用时不动它（直接打开正式地址、或者以后放开了同源）', () => {
    const real = { getItem: () => 'real' };
    const ctx = { window: { localStorage: real, sessionStorage: real }, document: { cookie: 'a=1' } };
    runInNewContext(STORAGE_SHIM_JS, ctx);
    expect(ctx.window.localStorage).toBe(real);
    expect(ctx.document.cookie).toBe('a=1');
  });

  it('插在页面自己的脚本前面，且不插到 doctype 前面', () => {
    const out = injectStorageShim('<!doctype html><html><head><title>t</title></head><script>localStorage</script>');
    expect(out.startsWith('<!doctype html><html><head><script data-ispace-storage>')).toBe(true);
    expect(out.indexOf('data-ispace-storage')).toBeLessThan(out.indexOf('<script>localStorage'));

    /* 没有 head 的裸页面：落在 doctype 之后 */
    const bare = injectStorageShim('<!doctype html><h1>x</h1>');
    expect(bare.startsWith('<!doctype html><script data-ispace-storage>')).toBe(true);
  });
});
