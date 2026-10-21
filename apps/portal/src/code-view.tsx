import { useMemo } from 'react';

/**
 * 工作台「代码」页的读码体验：文件类型角标、语法高亮、行号。
 *
 * ┌─ 为什么自己写一个小高亮器，而不是引 Prism / highlight.js ──────────────┐
 * │ 这里要读的只有模型写的那几种：HTML（里面嵌着 <style>/<script>）、CSS、  │
 * │ JS/TS、JSON、Markdown。引一个通用高亮库要么整包上百 KB，要么按语言拆包 │
 * │ 还得管加载；而且它们出的是 HTML 字符串，要 innerHTML 塞进去——代码是模 │
 * │ 型写的不可信内容，这条路得永远记着先转义。                              │
 * │                                                                        │
 * │ 这里扫一遍出一串 {种类, 文字}，按行切开，渲染全走 React 文本节点。高亮 │
 * │ 不追求编译器级的准确——认错一个关键字的颜色没有任何后果，读起来分得清   │
 * │ 标签、属性、字符串、注释就够了。                                         │
 * └────────────────────────────────────────────────────────────────────────┘
 */

export type Lang = 'html' | 'css' | 'js' | 'json' | 'md' | 'text';

/** 一段带种类的文字。k 为空是普通文字。 */
export interface Tok { k: TokKind | ''; v: string }
type TokKind = 'com' | 'str' | 'num' | 'kw' | 'lit' | 'tag' | 'attr' | 'punc' | 'prop' | 'sel' | 'fn' | 'at' | 'hd' | 'code' | 'em' | 'link';

export function langOf(path: string): Lang {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (['html', 'htm', 'svg', 'xml', 'vue'].includes(ext)) return 'html';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'js';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'text';
}

/** 整段文字 → 按行切好的 token。 */
export function highlightLines(text: string, lang: Lang): Tok[][] {
  const toks = lang === 'html' ? html(text)
    : lang === 'css' ? css(text)
      : lang === 'js' || lang === 'json' ? js(text)
        : lang === 'md' ? md(text)
          : [{ k: '' as const, v: text }];
  const lines: Tok[][] = [[]];
  for (const t of toks) {
    const parts = t.v.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1]!.push({ k: t.k, v: p });
    });
  }
  return lines;
}

// ── JS / TS / JSON ───────────────────────────────────────────────────

const JS_KW = new Set((
  'break case catch class const continue debugger default delete do else export extends finally for function '
  + 'if import in instanceof let new return super switch this throw try typeof var void while with yield async '
  + 'await of static get set from as interface type enum implements private public protected readonly declare'
).split(' '));
const JS_LIT = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

function js(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let plain = '';
  const push = (k: TokKind | '', v: string) => {
    if (!k) { plain += v; return; }
    if (plain) { out.push({ k: '', v: plain }); plain = ''; }
    out.push({ k, v });
  };
  while (i < src.length) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? src.length : end;
      push('com', src.slice(i, j)); i = j; continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? src.length : end + 2;
      push('com', src.slice(i, j)); i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, src.length);
      /* 后面紧跟冒号的字符串是对象的键（JSON 里尤其多），和值分开颜色 */
      const isKey = /^\s*:/.test(src.slice(j, j + 20)) && c !== '`';
      push(isKey ? 'prop' : 'str', src.slice(i, j)); i = j; continue;
    }
    const num = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?|\.\d+)/i.exec(src.slice(i, i + 40));
    if (num && !/[\w$]/.test(src[i - 1] ?? '')) { push('num', num[0]); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
    if (id) {
      const w = id[0];
      const next = src.slice(i + w.length).match(/^\s*(.)/)?.[1];
      const k: TokKind | '' = JS_KW.has(w) ? 'kw' : JS_LIT.has(w) ? 'lit' : next === '(' ? 'fn' : '';
      push(k, w); i += w.length; continue;
    }
    push('', c); i += 1;
  }
  if (plain) out.push({ k: '', v: plain });
  return out;
}

// ── CSS ──────────────────────────────────────────────────────────────

/**
 * 按 { } ; 切段：后面跟着 { 的是选择器或 @规则，含冒号的是「属性: 值」。
 * 这个判据对 @media 里套规则、伪类（a:hover {）都成立——看的是段落之后的
 * 分隔符，不是冒号本身。
 */
function css(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let seg = '';
  const flushSeg = (delim: string) => {
    if (seg) {
      if (delim === '{') out.push(...selector(seg));
      else out.push(...declaration(seg));
      seg = '';
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? src.length : end + 2;
      /* 注释前那一截段落先按"声明"出（注释多半在声明之间） */
      flushSeg(';');
      out.push({ k: 'com', v: src.slice(i, j) }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      seg += src.slice(i, Math.min(j + 1, src.length)); i = j + 1; continue;
    }
    if (c === '{' || c === '}' || c === ';') {
      flushSeg(c);
      out.push({ k: 'punc', v: c }); i += 1; continue;
    }
    seg += c; i += 1;
  }
  flushSeg(';');
  return out;
}

function selector(s: string): Tok[] {
  const lead = /^\s*/.exec(s)![0];
  const body = s.slice(lead.length);
  if (body.startsWith('@')) {
    const m = /^@[\w-]+/.exec(body)![0];
    return [{ k: '', v: lead }, { k: 'at', v: m }, ...value(body.slice(m.length))];
  }
  return [{ k: '', v: lead }, { k: 'sel', v: body }];
}

function declaration(s: string): Tok[] {
  const colon = s.indexOf(':');
  if (colon < 0) return [{ k: '', v: s }];
  const name = s.slice(0, colon);
  const lead = /^\s*/.exec(name)![0];
  return [{ k: '', v: lead }, { k: 'prop', v: name.slice(lead.length) }, { k: 'punc', v: ':' }, ...value(s.slice(colon + 1))];
}

function value(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /("[^"]*"|'[^']*')|(#[0-9a-f]{3,8}\b)|(-?\d*\.?\d+(?:px|rem|em|vh|vw|vmin|vmax|%|s|ms|deg|fr|ch|ex|pt)?)|(!important)|([\w-]+)(?=\()|([^"'#\d!\w-]+|[\w-]+|.)/gi;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const k: TokKind | '' = m[1] ? 'str' : m[2] || m[3] ? 'num' : m[4] ? 'kw' : m[5] ? 'fn' : '';
    out.push({ k, v: m[0] });
  }
  return out;
}

// ── HTML（含嵌入的 <style> / <script>） ──────────────────────────────

function html(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let text = '';
  const flush = () => { if (text) { out.push({ k: '', v: text }); text = ''; } };
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      flush();
      const end = src.indexOf('-->', i + 4);
      const j = end < 0 ? src.length : end + 3;
      out.push({ k: 'com', v: src.slice(i, j) }); i = j; continue;
    }
    const open = /^<(\/?)([A-Za-z][\w:-]*|!DOCTYPE|!doctype)/.exec(src.slice(i, i + 60));
    if (!open) { text += src[i]; i += 1; continue; }
    flush();
    const closing = open[1] === '/';
    const name = open[2]!;
    out.push({ k: 'punc', v: `<${open[1]}` }, { k: 'tag', v: name });
    i += open[0].length;
    /* 属性：名字、=、带引号或不带引号的值，直到 > 或 /> */
    while (i < src.length && src[i] !== '>' && !src.startsWith('/>', i)) {
      const ws = /^\s+/.exec(src.slice(i));
      if (ws) { out.push({ k: '', v: ws[0] }); i += ws[0].length; continue; }
      const attr = /^[^\s=>/"']+/.exec(src.slice(i));
      if (attr) { out.push({ k: 'attr', v: attr[0] }); i += attr[0].length; continue; }
      if (src[i] === '=') { out.push({ k: 'punc', v: '=' }); i += 1; continue; }
      const q = src[i];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, i + 1);
        const j = end < 0 ? src.length : end + 1;
        out.push({ k: 'str', v: src.slice(i, j) }); i = j; continue;
      }
      out.push({ k: '', v: src[i]! }); i += 1;
    }
    const selfClose = src.startsWith('/>', i);
    if (i < src.length) { out.push({ k: 'punc', v: selfClose ? '/>' : '>' }); i += selfClose ? 2 : 1; }

    /* <style> 与 <script> 的内容交给对应语言 */
    const lower = name.toLowerCase();
    if (!closing && !selfClose && (lower === 'style' || lower === 'script')) {
      const end = src.toLowerCase().indexOf(`</${lower}`, i);
      const j = end < 0 ? src.length : end;
      out.push(...(lower === 'style' ? css(src.slice(i, j)) : js(src.slice(i, j))));
      i = j;
    }
  }
  flush();
  return out;
}

// ── Markdown ─────────────────────────────────────────────────────────

function md(src: string): Tok[] {
  const out: Tok[] = [];
  let fence = false;
  src.split('\n').forEach((line, n) => {
    if (n) out.push({ k: '', v: '\n' });
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push({ k: 'code', v: line }); return; }
    if (fence) { out.push({ k: 'code', v: line }); return; }
    if (/^\s{0,3}#{1,6}\s/.test(line)) { out.push({ k: 'hd', v: line }); return; }
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]*\]\([^)]*\))|(^\s*(?:[-*+]|\d+\.)\s)|(^\s*>)|([^`*_[]+|.)/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const k: TokKind | '' = m[1] ? 'code' : m[2] ? 'em' : m[3] ? 'link' : m[4] || m[5] ? 'punc' : '';
      out.push({ k, v: m[0] });
    }
  });
  return out;
}

// ── 渲染 ─────────────────────────────────────────────────────────────

/**
 * 高亮配色。浅色按 GitHub 的那一套调暗了一档，夜间（html[data-theme="dark"]）另配。
 * 写成变量：组件里只认 class，换主题不用重渲染。
 */
const HL_CSS = `
.ispace-hl{--hl-com:#8a8f98;--hl-str:#0a7f3f;--hl-num:#b45309;--hl-kw:#c2185b;--hl-lit:#7c3aed;--hl-tag:#c2410c;--hl-attr:#7c3aed;--hl-punc:#8a8f98;--hl-prop:#1d5fbf;--hl-sel:#0f766e;--hl-fn:#6d28d9;--hl-at:#c2185b;--hl-hd:#1d5fbf;--hl-code:#b45309;--hl-em:#292724;--hl-link:#1d5fbf}
:root[data-theme="dark"] .ispace-hl{--hl-com:#7d8590;--hl-str:#7ee2a8;--hl-num:#f0b072;--hl-kw:#ff7aa8;--hl-lit:#c4a5ff;--hl-tag:#ff9b6a;--hl-attr:#c4a5ff;--hl-punc:#7d8590;--hl-prop:#79b8ff;--hl-sel:#5eead4;--hl-fn:#c4a5ff;--hl-at:#ff7aa8;--hl-hd:#79b8ff;--hl-code:#f0b072;--hl-em:#e8e6e3;--hl-link:#79b8ff}
.ispace-hl .k-com{color:var(--hl-com);font-style:italic}.ispace-hl .k-str{color:var(--hl-str)}.ispace-hl .k-num{color:var(--hl-num)}
.ispace-hl .k-kw{color:var(--hl-kw)}.ispace-hl .k-lit{color:var(--hl-lit)}.ispace-hl .k-tag{color:var(--hl-tag)}
.ispace-hl .k-attr{color:var(--hl-attr)}.ispace-hl .k-punc{color:var(--hl-punc)}.ispace-hl .k-prop{color:var(--hl-prop)}
.ispace-hl .k-sel{color:var(--hl-sel)}.ispace-hl .k-fn{color:var(--hl-fn)}.ispace-hl .k-at{color:var(--hl-at)}
.ispace-hl .k-hd{color:var(--hl-hd);font-weight:600}.ispace-hl .k-code{color:var(--hl-code)}.ispace-hl .k-em{color:var(--hl-em);font-weight:600}
.ispace-hl .k-link{color:var(--hl-link);text-decoration:underline}
.ispace-hl .ln:hover{background:var(--surface-2)}
`;

export function CodeView({ text, path, wrap }: { text: string; path: string; wrap: boolean }) {
  const lines = useMemo(() => highlightLines(text, langOf(path)), [text, path]);
  const gutter = `${String(lines.length).length + 1}ch`;
  return (
    <div className="ispace-hl mono" style={{ fontSize: 'var(--text-base)', lineHeight: 1.7, color: 'var(--text-primary)', minWidth: wrap ? 0 : 'max-content' }}>
      <style>{HL_CSS}</style>
      {lines.map((ln, i) => (
        <div key={i} className="ln" style={{ display: 'flex' }}>
          <span
            aria-hidden
            style={{
              flex: 'none', width: gutter, paddingRight: 16, textAlign: 'right', userSelect: 'none',
              color: 'var(--text-placeholder)', position: 'sticky', left: 0, background: 'var(--surface-canvas)',
            }}
          >
            {i + 1}
          </span>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: wrap ? 'pre-wrap' : 'pre', wordBreak: wrap ? 'break-all' : 'normal' }}>
            {ln.length ? ln.map((t, k) => (t.k ? <span key={k} className={`k-${t.k}`}>{t.v}</span> : t.v)) : '​'}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 文件类型角标 ─────────────────────────────────────────────────────

const BADGES: Record<string, { label: string; bg: string; fg?: string }> = {
  html: { label: 'HTML', bg: '#e44d26' },
  css: { label: 'CSS', bg: '#2965f1' },
  js: { label: 'JS', bg: '#f0db4f', fg: '#323330' },
  ts: { label: 'TS', bg: '#3178c6' },
  json: { label: '{ }', bg: '#6b7280' },
  md: { label: 'MD', bg: '#292724' },
  svg: { label: 'SVG', bg: '#ffb13b', fg: '#3a2a00' },
  img: { label: 'IMG', bg: '#7c5cff' },
  font: { label: 'Aa', bg: '#b07219' },
  doc: { label: 'DOC', bg: '#2b579a' },
  xls: { label: 'XLS', bg: '#217346' },
  ppt: { label: 'PPT', bg: '#c43e1c' },
  pdf: { label: 'PDF', bg: '#d93025' },
  txt: { label: 'TXT', bg: '#a2a09b' },
};

export function badgeOf(path: string): { label: string; bg: string; fg?: string } {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'htm') return BADGES.html!;
  if (['mjs', 'cjs', 'jsx'].includes(ext)) return BADGES.js!;
  if (ext === 'tsx') return BADGES.ts!;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico'].includes(ext)) return BADGES.img!;
  if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return BADGES.font!;
  if (ext === 'docx') return BADGES.doc!;
  if (ext === 'xlsx' || ext === 'csv') return BADGES.xls!;
  if (ext === 'pptx') return BADGES.ppt!;
  if (ext === 'markdown') return BADGES.md!;
  return BADGES[ext] ?? BADGES.txt!;
}

export function FileBadge({ path, size = 18 }: { path: string; size?: number }) {
  const b = badgeOf(path);
  return (
    <span
      aria-hidden
      style={{
        flex: 'none', minWidth: size, height: size, padding: '0 3px', boxSizing: 'border-box', borderRadius: 5,
        display: 'inline-grid', placeItems: 'center', background: b.bg, color: b.fg ?? '#fff',
        fontSize: b.label.length > 3 ? 7 : 8, fontWeight: 800, letterSpacing: 0.2, fontFamily: 'var(--font-mono)',
      }}
    >
      {b.label}
    </span>
  );
}

export const isImage = (path: string) => /\.(png|jpe?g|gif|webp|avif|ico|svg)$/i.test(path);
