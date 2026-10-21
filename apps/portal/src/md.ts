/**
 * 对话流里的 Markdown（模型的回话、附件里的 .md）。
 *
 * ┌─ 为什么自己解析，而不是引 marked 再 innerHTML ──────────────────────┐
 * │ 模型的回话是不可信输入：它会复述用户贴进来的东西、网页里的片段，     │
 * │ 里面完全可能有 <img onerror=…>。marked 之类出的是 HTML 字符串，要    │
 * │ 安全就得再接一个消毒库，两个依赖、一个 innerHTML，还要永远记得别漏   │
 * │ 掉消毒那一步。                                                        │
 * │                                                                      │
 * │ 这里解析成一棵小树，渲染时一律走 React 元素——文字永远是文本节点，   │
 * │ 从结构上就没有"把一段字符串当 HTML 执行"这条路。链接只放行 http(s)、 │
 * │ mailto 与相对路径，javascript: 之类原样当文字显示。                  │
 * │                                                                      │
 * │ 支持的是对话里真会出现的那些：标题、段落、粗斜体、行内代码、代码块、 │
 * │ 列表（一层嵌套）、引用、表格、分隔线、链接。流式输出时代码块还没收尾 │
 * │ 也能画——没闭合的 ``` 当作代码块一直到结尾。                         │
 * └──────────────────────────────────────────────────────────────────────┘
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: ('left' | 'center' | 'right' | null)[] }
  | { t: 'hr' };

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function parseMarkdown(src: string): Block[] {
  return blocks(src.replace(/\r\n?/g, '\n').split('\n'));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', c: inlineLines(para) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i += 1; // 跳过收尾的 ```（没有也无妨）
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); i += 1; continue; }

    const h = HEADING.exec(line);
    if (h) { flush(); out.push({ t: 'h', level: h[1]!.length, c: inline(h[2]!) }); i += 1; continue; }

    if (HR.test(line)) { flush(); out.push({ t: 'hr' }); i += 1; continue; }

    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push({ t: 'quote', c: blocks(body) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => {
        const s = c.trim();
        return s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!).map(inline));
      out.push({ t: 'table', head: head.map(inline), rows, align });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      flush();
      const baseIndent = item[1]!.length;
      const ordered = item[3] !== undefined;
      const items: Block[][] = [];
      let cur: string[] | null = null;
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ITEM.exec(l);
        if (m && m[1]!.length <= baseIndent + 1 && (m[3] !== undefined) === ordered) {
          if (cur) items.push(blocks(cur));
          cur = [m[4]!];
        } else if (l.trim() && (/^\s/.test(l) || (cur && !ITEM.exec(l) && !FENCE.test(l) && !HEADING.test(l)))) {
          // 缩进的续行或子列表，交给递归去认
          cur?.push(l.replace(new RegExp(`^\\s{0,${baseIndent + 4}}`), ''));
        } else if (!l.trim() && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
          cur?.push('');
        } else break;
        i += 1;
      }
      if (cur) items.push(blocks(cur));
      out.push({ t: 'list', ordered, start: ordered ? Number(item[3]) : 1, items });
      continue;
    }

    para.push(line);
    i += 1;
  }
  flush();
  return out;
}

function cells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** 段落里的换行保留成换行——对话里人和模型都习惯一句一行。 */
function inlineLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((l, k) => {
    if (k) out.push({ t: 'br' });
    out.push(...inline(l.trim()));
  });
  return out;
}

/** 只放行这几种链接。其余（javascript:、data: 等）原样当文字。 */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  return h.startsWith('//') ? null : h; // 相对路径、锚点
}

export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const text = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;
    const rest = src.slice(i);

    if (c === '\\' && i + 1 < src.length && /[\\`*_~[\]()#|>-]/.test(src[i + 1]!)) {
      buf += src[i + 1]; i += 2; continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) { text(); out.push({ t: 'code', v: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) { text(); out.push({ t: 'strong', c: inline(strong[2]!) }); i += strong[0].length; continue; }
    const del = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (del) { text(); out.push({ t: 'del', c: inline(del[1]!) }); i += del[0].length; continue; }
    const em = /^([*_])(?=\S)([\s\S]*?\S)\1(?![*_\w])/.exec(rest);
    if (em && !(c === '_' && /\w/.test(src[i - 1] ?? ''))) {
      text(); out.push({ t: 'em', c: inline(em[2]!) }); i += em[0].length; continue;
    }
    const link = /^!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]!);
      text();
      if (href) out.push({ t: 'link', href, c: inline(link[1] || link[2]!) });
      else out.push({ t: 'text', v: link[0] });
      i += link[0].length; continue;
    }
    const auto = /^https?:\/\/[^\s<>()（）"'，。；]+[^\s<>()（）"'，。；.,;:!?]/.exec(rest);
    if (auto && !/\w/.test(src[i - 1] ?? '')) {
      text(); out.push({ t: 'link', href: auto[0], c: [{ t: 'text', v: auto[0] }] }); i += auto[0].length; continue;
    }
    buf += c;
    i += 1;
  }
  text();
  return out;
}
