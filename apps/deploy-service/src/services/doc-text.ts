import { inflateRawSync } from 'node:zlib';

/**
 * 从对话里附上的文档抽出文字，交给模型读。
 *
 * ┌─ 为什么自己读 zip，而不是引一个 office 解析库 ──────────────────────┐
 * │ docx / xlsx / pptx 都是 zip 包着几份 XML，要的只是里面的字：Word 的  │
 * │ 段落、Excel 的单元格、PPT 每页的文本框。为这个引一个动辄几 MB、带着 │
 * │ 宏/公式/样式解析的库，攻击面和体积都不划算——用户附件是不可信输入。  │
 * │ 这里只读中央目录、只解压认识的那几个条目，每个条目解压上限 8 MB      │
 * │ （防 zip 炸弹），读不懂就说读不懂。                                  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * PDF 没有做：它的文字藏在压缩的内容流和字体映射里，不引库读不准。模型那边
 * 会被明确告知"这是个 PDF、文字读不出来"，而不是收到一段乱码。
 */

export type DocKind = 'text' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'image' | 'other';

/** 交给模型的文字最多这么长。再长就截断并注明——一份几十页的文档全塞进去，上下文就没了。 */
export const MAX_DOC_CHARS = 20_000;
/** zip 里单个条目解压后的上限。 */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** Excel 每张表最多读这么多行。 */
const MAX_ROWS = 300;

export function docKind(name: string, mime: string): DocKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'html', 'htm', 'css', 'js', 'ts', 'xml', 'yaml', 'yml'].includes(ext)) return 'text';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  return 'other';
}

/**
 * 抽文字。读不出来返回 null（调用方据此告诉模型"这个文件读不出文字"）。
 * 永不抛：坏文件、不认识的格式都只是 null。
 */
export function extractText(buf: Buffer, kind: DocKind): string | null {
  try {
    switch (kind) {
      case 'text': return clip(buf.toString('utf8'));
      case 'docx': return clip(docxText(unzip(buf, (n) => n === 'word/document.xml')));
      case 'xlsx': return clip(xlsxText(unzip(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === 'xl/workbook.xml')));
      case 'pptx': return clip(pptxText(unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))));
      default: return null;
    }
  } catch {
    return null;
  }
}

function clip(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  return t.length > MAX_DOC_CHARS
    ? `${t.slice(0, MAX_DOC_CHARS)}\n……（后面还有 ${t.length - MAX_DOC_CHARS} 字，太长没有放进来）`
    : t;
}

// ── zip ──────────────────────────────────────────────────────────────

/** 读中央目录，只解压 want 认的条目。返回 条目名 → 文本。 */
export function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, string> {
  /* 中央目录结束记录在末尾 22~65557 字节内，倒着找签名 */
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();

  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;

    if (!want(name) || usize > MAX_ENTRY_BYTES) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }) : null;
    if (data) out.set(name, data.toString('utf8'));
  }
  return out;
}

// ── OOXML ────────────────────────────────────────────────────────────

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return ENT[e.toLowerCase()] ?? '';
  });
}

/** 一段 XML 里某个标签的全部文字，按出现顺序拼起来。 */
function texts(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  for (let m = re.exec(xml); m; m = re.exec(xml)) out += unescapeXml(m[1]!);
  return out;
}

/** 按段落（Word 的 w:p、PPT 的 a:p）切开，每段一行。 */
function paragraphs(xml: string, p: string, t: string): string[] {
  const re = new RegExp(`<${p}[\\s>][\\s\\S]*?</${p}>`, 'g');
  return (xml.match(re) ?? []).map((para) => texts(para, t)).filter((l) => l.trim());
}

function docxText(files: Map<string, string>): string {
  const xml = files.get('word/document.xml');
  return xml ? paragraphs(xml, 'w:p', 'w:t').join('\n') : '';
}

function pptxText(files: Map<string, string>): string {
  const num = (n: string) => Number(/slide(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  return [...files.keys()].sort((a, b) => num(a) - num(b)).map((n) => {
    const lines = paragraphs(files.get(n)!, 'a:p', 'a:t');
    return `【第 ${num(n)} 页】\n${lines.join('\n')}`;
  }).join('\n\n');
}

function xlsxText(files: Map<string, string>): string {
  const shared = (files.get('xl/sharedStrings.xml')?.match(/<si[\s>][\s\S]*?<\/si>/g) ?? [])
    .map((si) => texts(si, 't'));
  /* 表名在 workbook.xml 里，按 sheetN 的顺序对上 */
  const names = [...(files.get('xl/workbook.xml') ?? '').matchAll(/<sheet\s[^>]*name="([^"]*)"/g)]
    .map((m) => unescapeXml(m[1]!));
  const num = (n: string) => Number(/sheet(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const sheets = [...files.keys()].filter((n) => n.includes('worksheets/')).sort((a, b) => num(a) - num(b));

  return sheets.map((n) => {
    const rows = files.get(n)!.match(/<row[\s>][\s\S]*?<\/row>/g) ?? [];
    const lines = rows.slice(0, MAX_ROWS).map((row) =>
      (row.match(/<c\s[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []).map((c) => {
        const type = /\st="([^"]+)"/.exec(c)?.[1];
        if (type === 'inlineStr') return texts(c, 't');
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1] ?? '';
        return type === 's' ? (shared[Number(v)] ?? '') : unescapeXml(v);
      }).join('\t'));
    const more = rows.length > MAX_ROWS ? `\n……（共 ${rows.length} 行，只读了前 ${MAX_ROWS} 行）` : '';
    return `【表：${names[num(n) - 1] ?? `Sheet${num(n)}`}】\n${lines.join('\n')}${more}`;
  }).join('\n\n');
}
