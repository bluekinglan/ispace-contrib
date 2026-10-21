/**
 * 沙箱框里的 localStorage / sessionStorage / document.cookie 兜底。
 *
 * ┌─ 为什么需要 ───────────────────────────────────────────────────────┐
 * │ 试玩与预览的响应带 CSP sandbox 且不给 allow-same-origin，页面因此是 │
 * │ opaque origin。浏览器对这种页面**一碰存储就抛 SecurityError**：     │
 * │ 读 localStorage 这个属性本身就抛，不是等到 getItem。               │
 * │                                                                    │
 * │ 模型写的页面很爱在开头读一下存储（收藏、打卡、主题、上次的输入）， │
 * │ 而那一行一抛，后面整段脚本都不跑了。线上 zongkelong/shandong-       │
 * │ travel-guide 就是：app.js 第 90 行读收藏，抛了，于是关开场画面、    │
 * │ 绑滚动、"滑到才显示"这几样全没挂上——框里能滚，但一直停在开场那个  │
 * │ 「鲁」字上，往下什么都不出来。                                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 做法：只在**真的会抛**时，换成一份内存里的同形对象。看的这一会儿里读写
 * 都正常，刷新就清空——这是预览，不需要也不该替人把数据存下来。直接打开
 * 正式地址时不经过这里，页面用的是浏览器真正的存储。
 */
export const STORAGE_SHIM_JS = `(function () {
  function memory() {
    var d = Object.create(null);
    return {
      get length() { return Object.keys(d).length; },
      key: function (i) { var k = Object.keys(d); return i >= 0 && i < k.length ? k[i] : null; },
      getItem: function (k) { k = String(k); return k in d ? d[k] : null; },
      setItem: function (k, v) { d[String(k)] = String(v); },
      removeItem: function (k) { delete d[String(k)]; },
      clear: function () { d = Object.create(null); }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void window[name]; return; } catch (e) { /* 会抛：换成内存版 */ }
    try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (e) {}
  });
  try { void document.cookie; } catch (e) {
    var jar = Object.create(null);
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () {
          return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; ');
        },
        set: function (v) {
          var pair = String(v).split(';')[0];
          var at = pair.indexOf('=');
          if (at > 0) jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
        }
      });
    } catch (e2) {}
  }
})();`;

const TAG = `<script data-ispace-storage>${STORAGE_SHIM_JS}</script>`;

/**
 * 插在页面自己的脚本之前。落点和预览 shim 同一套顺序：head → html → doctype
 * → 最前面——插到 <!doctype> 前面会把浏览器推进怪异模式，版式当场走样。
 */
export function injectStorageShim(html: string): string {
  for (const re of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + TAG + html.slice(at);
    }
  }
  return TAG + html;
}
