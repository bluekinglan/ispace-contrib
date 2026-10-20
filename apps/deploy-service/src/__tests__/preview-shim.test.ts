import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PREVIEW_SHIM_JS } from '../services/preview-shim.js';

/**
 * 把真的 shim 放进一个假 window 里跑一遍。
 *
 * ┌─ 为什么要这么测 ────────────────────────────────────────────────────┐
 * │ shim 只在浏览器里跑，而它管着两件最要紧的事：                        │
 * │   1. 令牌**只**认自己父窗口递过来的（冒充者给的不作数）              │
 * │   2. 取数只改道到白名单那条路，其余请求一个字不动                     │
 * │                                                                      │
 * │ 这两条靠手工点是点不出来的——要点出第 1 条，得真去搭一个冒充父窗口的  │
 * │ 页面。放进 vm 跑则一行代码就能验，而且验的是会发布出去的那份源码本身，│
 * │ 不是它的复述。                                                        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 环境是手搭的而不是 jsdom：shim 只用到 window / location / Headers / URL
 * 这几样，为它引一个 DOM 实现是拿一个大依赖换四个桩。
 */

interface Call { url: string; init: { headers?: Headers; credentials?: string } }

/**
 * 够 shim 改写的那点 XHR。
 *
 * **每次 runShim 都要一个全新的类**：shim 是往 XMLHttpRequest.prototype 上
 * 打补丁的，共用一个类的话第二次运行会在第一层补丁外面再包一层，内层拿着
 * 已经改道过的地址再算一次，把 __ispTo 又抹成空——于是令牌不带了。真实页面
 * 里 shim 有 window.__ispacePreview 守着只跑一次，这个坑只会出现在测试里。
 */
function makeXHR() {
  const opened: { method: string; url: string }[] = [];
  const sent: { url: string; headers: Record<string, string> }[] = [];
  class FakeXHR {
    private url = '';
    private headers: Record<string, string> = {};
    open(method: string, url: string, _async?: boolean) {
      this.url = url;
      opened.push({ method, url });
    }
    setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
    send() { sent.push({ url: this.url, headers: { ...this.headers } }); }
  }
  return { FakeXHR, opened, sent };
}

function runShim() {
  const posted: unknown[] = [];
  const fetched: Call[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const { FakeXHR, opened, sent } = makeXHR();

  /** 父窗口。必须和 window 是不同的对象，shim 才认为自己被嵌着。 */
  const up = { postMessage: (m: unknown) => { posted.push(m); } };

  const window = {
    parent: up,
    addEventListener(type: string, fn: (e: unknown) => void) {
      const xs = listeners.get(type) ?? [];
      xs.push(fn);
      listeners.set(type, xs);
    },
    fetch: (url: unknown, init: unknown) => {
      fetched.push({ url: String(url), init: (init ?? {}) as Call['init'] });
      return Promise.resolve('ok');
    },
    XMLHttpRequest: FakeXHR,
  } as Record<string, unknown>;

  const ctx = createContext({
    window,
    location: { href: 'https://ispace.example.com/deploy/api/preview/PID/' },
    console: { error: (..._a: unknown[]) => {} },
    setTimeout,
    Headers,
    URL,
    Promise,
    Array,
    String,
  });
  runInContext(PREVIEW_SHIM_JS, ctx);

  const fire = (type: string, e: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(e);
  };
  return {
    posted, fetched, fire, up,
    fetch: (url: string, init?: unknown) =>
      (window.fetch as (u: string, i?: unknown) => Promise<unknown>)(url, init),
    xhr: (url: string) => {
      const x = new FakeXHR() as unknown as { open: (...a: unknown[]) => void; send: () => void };
      x.open('GET', url);
      x.send();
    },
    xhrOpened: () => opened,
    xhrSent: () => sent,
  };
}

describe('预览页里的 shim', () => {
  it('一加载就向父窗口报到，等着拿令牌', () => {
    const s = runShim();
    expect(s.posted).toEqual([{ type: 'ispace:preview-ready' }]);
  });

  it('父窗口递来的令牌作数：取数请求改道并带上 Bearer', async () => {
    const s = runShim();
    s.fire('message', { source: s.up, data: { type: 'ispace:preview-token', token: 'TK' } });

    await s.fetch('/deploy/api/connect/open-meteo/v1/forecast?x=1');
    const [call] = s.fetched;
    expect(call?.url).toBe(
      'https://ispace.example.com/deploy/api/preview-data/connect/open-meteo/v1/forecast?x=1',
    );
    expect(call?.init.headers?.get('authorization')).toBe('Bearer TK');
    // 这条路只认 Bearer，显式声明不带 cookie
    expect(call?.init.credentials).toBe('omit');
  });

  it('**冒充者递来的令牌不作数**——只认自己的父窗口', async () => {
    /*
      这是 shim 这一侧的安全支点。沙箱 iframe 的 origin 是 "null"，按
      event.origin 判等于谁都放进来；按 event.source 判的是对象同一性，
      骗不了。这里用一个别的对象当 source，令牌必须被丢掉。
    */
    const s = runShim();
    const impostor = { postMessage: () => {} };
    s.fire('message', { source: impostor, data: { type: 'ispace:preview-token', token: 'EVIL' } });

    const p = s.fetch('/deploy/api/connect/open-meteo/v1/forecast');
    // 没拿到令牌时 shim 会等父窗口（3 秒超时）后照样发出去，让它去撞 401
    await new Promise((r) => { setTimeout(r, 0); });
    expect(s.fetched).toHaveLength(0);     // 还在等，没有带着 EVIL 就发
    void p;
  });

  it('不是取数的请求一个字不动——页面自己的资源照常加载', async () => {
    const s = runShim();
    s.fire('message', { source: s.up, data: { type: 'ispace:preview-token', token: 'TK' } });

    await s.fetch('./data/list.json');
    const [call] = s.fetched;
    // 原样把入参交回去，不碰 URL、不加头
    expect(call?.url).toBe('./data/list.json');
    expect(call?.init.headers).toBeUndefined();
  });

  it('XHR 也接管：改道并带上 Bearer', async () => {
    /*
      系统提示教模型写 fetch，但它并不总听。漏掉 XHR 的后果不是"少一个特性"，
      是页面在预览里取数 401、人以为平台坏了。
    */
    const s = runShim();
    s.fire('message', { source: s.up, data: { type: 'ispace:preview-token', token: 'TK' } });

    s.xhr('/deploy/api/connect/open-meteo/v1/forecast');
    expect(s.xhrOpened()[0]?.url).toBe(
      'https://ispace.example.com/deploy/api/preview-data/connect/open-meteo/v1/forecast',
    );
    // send 被推迟到令牌到手，所以要等一个微任务
    await new Promise((r) => { setTimeout(r, 0); });
    expect(s.xhrSent()[0]?.headers.authorization).toBe('Bearer TK');
  });

  it('XHR 打别的地址一个字不动，也不等令牌', () => {
    const s = runShim();
    s.xhr('./data/list.json');
    expect(s.xhrOpened()[0]?.url).toBe('./data/list.json');
    // 没命中改道的请求必须**同步**发出去，不能被令牌握手拖住
    expect(s.xhrSent()).toHaveLength(1);
    expect(s.xhrSent()[0]?.headers.authorization).toBeUndefined();
  });

  it('脚本出错会回流给父窗口', () => {
    const s = runShim();
    s.posted.length = 0;
    s.fire('error', { target: undefined, message: 'x is not a function', filename: 'https://h/main.js', lineno: 12 });
    expect(s.posted).toHaveLength(1);
    const m = s.posted[0] as { type: string; level: string; text: string };
    expect(m.type).toBe('ispace:preview-error');
    expect(m.text).toContain('x is not a function');
    expect(m.text).toContain('main.js:12');
  });

  it('资源加载失败也回流——写了根绝对路径的页面就是这一类', () => {
    const s = runShim();
    s.posted.length = 0;
    /* capture 阶段才收得到：这类事件不冒泡 */
    s.fire('error', { target: { src: 'https://h/assets/three.js' } });
    const m = s.posted[0] as { level: string; text: string };
    expect(m.level).toBe('resource');
    expect(m.text).toContain('/assets/three.js');
  });

  it('回流有上限——每帧抛异常的动画循环不该把父窗口刷爆', () => {
    const s = runShim();
    s.posted.length = 0;
    for (let i = 0; i < 200; i += 1) {
      s.fire('error', { target: undefined, message: `第 ${i} 次` });
    }
    expect(s.posted).toHaveLength(50);
    expect((s.posted[49] as { last: boolean }).last).toBe(true);
  });
});
