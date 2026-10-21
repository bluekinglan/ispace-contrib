import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * 把一个目录打成 zip（创建屏「更多 → 导出代码」）。
 *
 * 自己写而不是引 archiver 之类：要的只是"一个工作区、几十个文件、一次性打
 * 完给浏览器"，zip 的格式就是本地头 + 压缩数据 + 中央目录 + 结尾记录，几十
 * 行的事。读写的那一半（解压）平台已经有 yauzl，测试里拿它来验这里打出来的
 * 包是不是标准格式。
 *
 * 整个包在内存里拼：上限 50 MB / 2000 个文件，超了就拒绝，而不是悄悄少打几个
 * ——缺文件的代码包比打不出来更糟，人拿回去跑不起来还不知道为什么。
 */

export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_FILES = 2000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 打包 dir。include 决定哪些相对路径（统一用 /）进包。
 * 返回 zip 的字节；目录不存在或一个文件都没有时返回 null。
 */
export async function zipDir(dir: string, include: (rel: string) => boolean): Promise<Buffer | null> {
  const files: { rel: string; abs: string }[] = [];
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(d, e.name);
      const rel = relative(dir, abs).split(sep).join('/');
      if (!include(rel)) continue;
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        total += (await stat(abs)).size;
        files.push({ rel, abs });
        if (files.length > MAX_ZIP_FILES || total > MAX_ZIP_BYTES) {
          throw new IspaceError(
            ERROR_CODES.INVALID_INPUT,
            `工作区太大（超过 ${MAX_ZIP_FILES} 个文件或 ${MAX_ZIP_BYTES / 1048576} MB），没法在这里打包。`,
          );
        }
      }
    }
  };
  await walk(dir);
  if (!files.length) return null;

  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = await readFile(f.abs);
    const packed = deflateRawSync(raw);
    /* 压不小的（图片、字体本来就压过）原样存，省得解压时白算一遍 */
    const deflate = packed.length < raw.length;
    const data = deflate ? packed : raw;
    const name = Buffer.from(f.rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 位 11：文件名是 UTF-8——中文文件名在 Windows 上才不是乱码
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }

  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
