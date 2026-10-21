import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { saveAttachments, safeName } from '../services/attachments.js';
import { docKind, extractText, MAX_DOC_CHARS } from '../services/doc-text.js';

/**
 * 对话里附的文件：存到哪、模型读到什么。
 *
 * Office 文件在这里现场拼一个最小的 zip（只含要读的那几份 XML），不往仓库里
 * 放二进制样本——样本一多就没人知道哪个是测什么的。
 */

/** 拼一个 deflate 压缩的 zip。 */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('从文档里抽文字', () => {
  it('Word：按段落一行，实体解码', () => {
    const docx = zip({
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t xml:space="preserve"> 接着</w:t></w:r></w:p><w:p><w:r><w:t>A &amp; B &lt;3</w:t></w:r></w:p></w:body></w:document>',
      'word/styles.xml': '<不该读到这里/>',
    });
    expect(extractText(docx, 'docx')).toBe('第一段 接着\nA & B <3');
  });

  it('Excel：共享字符串与数字都对上，按表名分段、制表符分列', () => {
    const xlsx = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="销量" sheetId="1"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>城市</t></si><si><t>数量</t></si><si><t>杭州</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>'
        + '<row r="3"><c r="A3" t="inlineStr"><is><t>宁波</t></is></c><c r="B3"><v>7</v></c></row>'
        + '</sheetData></worksheet>',
    });
    expect(extractText(xlsx, 'xlsx')).toBe('【表：销量】\n城市\t数量\n杭州\t42\n宁波\t7');
  });

  it('PPT：按页码排序（slide10 在 slide2 后面），每页一段', () => {
    const pptx = zip({
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>结尾</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>目录</a:t></a:r></a:p><a:p><a:r><a:t>一、背景</a:t></a:r></a:p></p:sld>',
    });
    expect(extractText(pptx, 'pptx')).toBe('【第 2 页】\n目录\n一、背景\n\n【第 10 页】\n结尾');
  });

  it('坏文件、PDF、空文本都是 null，不抛', () => {
    expect(extractText(Buffer.from('not a zip'), 'docx')).toBeNull();
    expect(extractText(Buffer.from('%PDF-1.4'), 'pdf')).toBeNull();
    expect(extractText(Buffer.from('   '), 'text')).toBeNull();
  });

  it('太长的截断并注明', () => {
    const t = extractText(Buffer.from('字'.repeat(MAX_DOC_CHARS + 50)), 'text')!;
    expect(t).toContain('后面还有 50 字');
  });

  it('按扩展名与 MIME 认类型', () => {
    expect(docKind('a.MD', 'text/markdown')).toBe('text');
    expect(docKind('报告.docx', '')).toBe('docx');
    expect(docKind('x.bin', 'image/png')).toBe('image');
    expect(docKind('合同.pdf', '')).toBe('pdf');
    expect(docKind('a.exe', '')).toBe('other');
  });
});

describe('存附件', () => {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

  it('存到 _uploads/（不进页面产物），文字类内容写进给模型的说明，图片走多模态', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ispace-att-'));
    const r = await saveAttachments(ws, [
      { name: '需求.md', mimeType: 'text/markdown', dataBase64: b64('# 周报\n- 每周一更新') },
      { name: 'logo.png', mimeType: 'image/png', dataBase64: b64('PNGDATA') },
      { name: '合同.pdf', mimeType: 'application/pdf', dataBase64: b64('%PDF-1.4') },
    ]);
    expect(r.saved.map((f) => f.path)).toEqual(['_uploads/需求.md', '_uploads/logo.png', '_uploads/合同.pdf']);
    expect(readFileSync(join(ws, '_uploads', 'logo.png'), 'utf8')).toBe('PNGDATA');
    expect(r.images).toEqual([{ mimeType: 'image/png', dataBase64: b64('PNGDATA') }]);
    expect(r.note).toContain('不会跟着页面发布');
    expect(r.note).toContain('# 周报');
    expect(r.note).toContain('copy_file');
    expect(r.note).toContain('PDF，平台读不出它的文字');
  });

  it('重名不覆盖，名字里的路径与怪字符去掉', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ispace-att-'));
    await saveAttachments(ws, [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: b64('1') }]);
    const r = await saveAttachments(ws, [{ name: '../../a.txt', mimeType: 'text/plain', dataBase64: b64('2') }]);
    expect(r.saved[0]!.path).toBe('_uploads/a-2.txt');
    expect(existsSync(join(ws, '..', 'a.txt'))).toBe(false);
    expect(safeName('..\\..\\x?.md')).toBe('x_.md');
    expect(safeName('...')).toBe('file');
  });

  it('超过个数或大小上限就拒绝', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ispace-att-'));
    const one = { name: 'a.txt', mimeType: 'text/plain', dataBase64: b64('x') };
    await expect(saveAttachments(ws, Array(7).fill(one))).rejects.toThrow(/最多附 6 个/);
    await expect(saveAttachments(ws, [{ ...one, dataBase64: Buffer.alloc(11 * 1024 * 1024).toString('base64') }]))
      .rejects.toThrow(/超过 10 MB/);
  });
});
