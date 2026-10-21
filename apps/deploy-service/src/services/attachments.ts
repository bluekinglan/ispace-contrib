import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';
import { docKind, extractText, type DocKind } from './doc-text.js';

/**
 * 对话里附上的文件（图片、md、Word、Excel、PPT、PDF……）。
 *
 * ┌─ 存到 _uploads/，不进页面产物 ──────────────────────────────────────┐
 * │ 人附一份 Excel 往往是"照这个数据做个看板"，不是"把这个文件发出去"。│
 * │ 存进工作区根下就会跟着发布，一份内部数据表就挂到了公司域名上。     │
 * │                                                                    │
 * │ 下划线开头的顶层目录是平台草稿：发布链路排除（deploy.ts 的         │
 * │ scratchFilter）、快照不管、search_files 默认不搜。真要放进页面（比  │
 * │ 如"用这张照片当头图"），模型用 copy_file 把它拷到 assets/ 下——那   │
 * │ 是一个看得见的、显式的动作。                                        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 存下来还有一个用处：刷新之后对话里的附件卡片还点得开（/agent/workspace/raw）。
 */

export const UPLOAD_DIR = '_uploads';
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;

export interface IncomingFile { name: string; mimeType: string; dataBase64: string }

export interface SavedFile {
  name: string;
  /** 相对工作区。 */
  path: string;
  mimeType: string;
  size: number;
  kind: DocKind;
}

/**
 * 存附件，并写出给模型看的那段说明。
 *
 * 返回的 images 是要随消息一起发给模型的图（它们走多模态，不走文字）。
 */
export async function saveAttachments(wsDir: string, files: IncomingFile[]): Promise<{
  saved: SavedFile[];
  images: { mimeType: string; dataBase64: string }[];
  note: string;
}> {
  if (files.length > MAX_ATTACHMENTS) {
    throw new IspaceError(ERROR_CODES.INVALID_INPUT, `一次最多附 ${MAX_ATTACHMENTS} 个文件。`);
  }
  const dir = join(wsDir, UPLOAD_DIR);
  const saved: SavedFile[] = [];
  const images: { mimeType: string; dataBase64: string }[] = [];
  const lines: string[] = [];

  for (const f of files) {
    const buf = Buffer.from(f.dataBase64, 'base64');
    if (buf.byteLength > MAX_ATTACH_BYTES) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, `${f.name} 超过 ${MAX_ATTACH_BYTES / 1048576} MB，传不了。`);
    }
    await mkdir(dir, { recursive: true });
    const name = uniqueName(dir, safeName(f.name));
    await writeFile(join(dir, name), buf);
    const kind = docKind(name, f.mimeType);
    const rel = `${UPLOAD_DIR}/${name}`;
    saved.push({ name, path: rel, mimeType: f.mimeType, size: buf.byteLength, kind });

    if (kind === 'image') {
      images.push({ mimeType: f.mimeType, dataBase64: f.dataBase64 });
      lines.push(`- ${name}：图片，随这条消息附上了（存在 ${rel}）。要放进页面就用 copy_file 拷到 assets/ 下再引用。`);
      continue;
    }
    const text = extractText(buf, kind);
    if (text) {
      lines.push(`- ${name}（存在 ${rel}）的文字内容：\n<<<\n${text}\n>>>`);
    } else if (kind === 'pdf') {
      lines.push(`- ${name}（存在 ${rel}）：PDF，平台读不出它的文字。需要里面的内容就请用户把要点贴进来。`);
    } else {
      lines.push(`- ${name}（存在 ${rel}）：读不出文字的文件。`);
    }
  }

  const note = lines.length
    ? `\n\n【我附了 ${lines.length} 个文件。它们存在 ${UPLOAD_DIR}/ 下，不会跟着页面发布】\n${lines.join('\n')}`
    : '';
  return { saved, images, note };
}

/** 去掉路径、控制字符与奇怪的符号，保留中文名。 */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(-80);
  return clean || 'file';
}

function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const n = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
}
