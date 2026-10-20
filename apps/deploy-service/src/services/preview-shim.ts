/**
 * 注进预览页面的那一小段脚本（方案 §5.2、§5.3）。
 *
 * ┌─ 三条硬规矩 ────────────────────────────────────────────────────────┐
 * │ 1. **只注进响应，绝不落盘。** 工作区就是发布产物——shim 要是写进了   │
 * │    文件，它会跟着发布上线，那是一段带令牌握手的代码出现在正式站点上。│
 * │ 2. **令牌不印在页面源码里。** 页面向父窗口要，父窗口用 postMessage  │
 * │    递过来。印进 HTML 的话，用户截个图、把预览地址发给同事看一眼，   │
 * │    令牌就跟着出去了。                                                │
 * │ 3. **页面代码一个字都不用改。** 模型按系统提示写的是                 │
 * │    `fetch('/deploy/api/connect/xxx')`，shim 在 fetch 这一层把它改道  │
 * │    到预览取数端点。所以同一份代码在预览里和发布后都对——发布后没有   │
 * │    shim，走的是 cookie，路径原样命中正式端点。                       │
 * └──────────────────────────────────────────────────────────────────────┘
 */

/** 单页最多回流多少条错误。一个每帧抛异常的动画循环能在一秒里产出六十条。 */
const MAX_REPORTS = 50;

/**
 * 导出是为了能测它。
 *
 * 这段代码只在浏览器里跑，而它恰好管着两件最要紧的事：令牌只递给自己的
 * iframe、取数只走白名单那条路。单测把它放进一个假 window 里跑一遍，是这
 * 两件事唯一不靠人工点击的验证手段（见 preview-shim.test.ts）。
 */
export const PREVIEW_SHIM_JS = `(function(){
  if (window.__ispacePreview) return;
  window.__ispacePreview = true;

  var up = window.parent !== window ? window.parent : null;
  var token = null, waiting = [], sent = 0, MAX = ${MAX_REPORTS};
  function post(m){ if (up) up.postMessage(m, '*'); }

  // ── 1. 向父窗口要令牌 ───────────────────────────────────────────
  window.addEventListener('message', function(e){
    if (e.source !== up) return;
    var d = e.data;
    if (!d || d.type !== 'ispace:preview-token') return;
    token = d.token;
    var w = waiting; waiting = [];
    for (var i = 0; i < w.length; i++) w[i]();
  });
  post({ type: 'ispace:preview-ready' });

  function withToken(){
    if (token || !up) return Promise.resolve();
    return new Promise(function(res){
      waiting.push(res);
      // 父窗口没应答也要让请求走下去——让它去撞 401，这样错误能回流、
      // 人看得见"预览取数令牌没拿到"，而不是页面永远转圈。
      setTimeout(res, 3000);
    });
  }

  // ── 2. 把 /deploy/api/connect/... 改道，并带上令牌 ──────────────
  var FROM = '/deploy/api/connect/', TO = '/deploy/api/preview-data/connect/';
  /** 命中就返回改道后的完整地址，没命中返回空——fetch 与 XHR 共用这一份判断。 */
  function reroute(href){
    var u;
    try { u = new URL(href, location.href); } catch (err) { return ''; }
    if (u.pathname.indexOf(FROM) !== 0) return '';
    u.pathname = TO + u.pathname.slice(FROM.length);
    return u.href;
  }

  var rawFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    var href = typeof input === 'string' ? input
      : (input && input.href) || (input && input.url) || '';
    var to = reroute(href);
    if (!to) return rawFetch(input, init);

    return withToken().then(function(){
      var opts = {};
      for (var k in (init || {})) opts[k] = init[k];
      // Request 对象只带过方法：预览取数端点只收 GET，body 丢了也不影响，
      // 真要带 body 的请求本来就不在白名单里。
      if (input && typeof input !== 'string' && input.method && !opts.method) {
        opts.method = input.method;
      }
      var h = new Headers((init && init.headers) || undefined);
      if (token) h.set('authorization', 'Bearer ' + token);
      opts.headers = h;
      // 沙箱里本来也带不上 cookie，显式写明意图：这条路只认 Bearer。
      opts.credentials = 'omit';
      return rawFetch(to, opts);
    });
  };

  /*
    XMLHttpRequest 也要接管。

    系统提示教模型写的是 fetch，但它并不总听——而漏掉 XHR 的后果不是"少一个
    特性"，是页面在预览里取数 401、人以为是平台坏了。

    send() 是同步 API，没法 await 令牌，所以做法是**把 send 推迟到令牌到手**：
    对象停在 OPENED 状态等一下，调用方只是觉得这个请求慢了点，状态机没被破坏。
    同步 XHR（open 的第三个参数为 false）推迟不了——那种情况下有令牌就带、
    没有就直接发，让它去撞 401 把错误回流出来，而不是把页面卡死。
  */
  var X = window.XMLHttpRequest;
  if (X && X.prototype && X.prototype.open) {
    var rawOpen = X.prototype.open, rawSend = X.prototype.send;
    X.prototype.open = function(method, url){
      var a = Array.prototype.slice.call(arguments);
      var to = reroute(String(url));
      this.__ispTo = to;
      // 第三个参数显式为 false 才是同步；省略即异步
      this.__ispSync = a.length > 2 && a[2] === false;
      if (to) a[1] = to;
      return rawOpen.apply(this, a);
    };
    X.prototype.send = function(){
      var self = this, a = arguments;
      if (!this.__ispTo) return rawSend.apply(this, a);
      var stamp = function(){
        if (!token) return;
        try { self.setRequestHeader('authorization', 'Bearer ' + token); } catch (e) {}
      };
      if (this.__ispSync) { stamp(); return rawSend.apply(this, a); }
      withToken().then(function(){ stamp(); rawSend.apply(self, a); });
    };
  }

  // ── 3. 报错回流 ────────────────────────────────────────────────
  function fmt(v){
    if (v instanceof Error) return v.stack || v.message;
    if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  function send(level, text){
    if (sent >= MAX) return;
    sent++;
    post({ type: 'ispace:preview-error', level: level,
           text: String(text).slice(0, 800), last: sent === MAX });
  }
  // capture 阶段才收得到 <script src> / <img src> 这类资源加载失败——
  // 它们不冒泡。写了根绝对路径的页面在预览里就是这一类错误。
  window.addEventListener('error', function(e){
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) { send('resource', '加载不到 ' + (t.src || t.href)); }
    else {
      send('error', (e.message || '脚本出错')
        + (e.filename ? ' @ ' + String(e.filename).split('/').pop() + ':' + e.lineno : ''));
    }
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason;
    send('error', 'Promise 没人接：' + ((r && (r.stack || r.message)) || fmt(r)));
  });
  var ce = console.error;
  console.error = function(){
    try { send('console', Array.prototype.slice.call(arguments).map(fmt).join(' ')); } catch (e) {}
    return ce.apply(console, arguments);
  };
})();`;

const TAG = `<script data-ispace-preview>${PREVIEW_SHIM_JS}</script>`;

/**
 * 把 shim 插进 HTML。
 *
 * 位置要紧挨 `<head>` 之后，不能放末尾：它要在页面自己的脚本跑起来之前
 * 换掉 `window.fetch`，晚一步就有请求漏过去。
 *
 * 没有 `<head>` 的页面很常见（模型经常只写 `<body>`，甚至一段裸 HTML）。
 * 但**不能无脑插在最前面**——插到 `<!doctype html>` 前面会把浏览器推进
 * 怪异模式，页面布局当场走样，而且这种错极难往"是预览改的"上想。
 * 所以按 head → html → doctype → 最前面的顺序找落点。
 */
export function injectPreviewShim(html: string): string {
  for (const re of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + TAG + html.slice(at);
    }
  }
  return TAG + html;
}

export { MAX_REPORTS };
