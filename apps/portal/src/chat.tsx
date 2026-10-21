import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '@ispace/ui';
import { parseMarkdown, type Block, type Inline } from './md';

/**
 * 创建屏左栏的对话流：谁说的一眼分得开，说的东西按格式画出来。
 *
 * ┌─ 为什么要分气泡 ────────────────────────────────────────────────────┐
 * │ 原来用户的话是右侧气泡，模型的话是一段不带任何边框的正文，夹在进度 │
 * │ 卡片、选项卡片中间。来回几轮之后，人往回翻时分不清哪句是自己说的、 │
 * │ 哪句是它答的——尤其模型的回话里常常复述用户的要求。                 │
 * │                                                                    │
 * │ 现在两边各有形状：用户在右、实底气泡；模型在左、带头像，正文按     │
 * │ Markdown 排版（标题、列表、代码块、表格），而不是一整段 pre-wrap。   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 附件按类型画：图片直接出缩略图；md 点开按 Markdown 排；PDF 点开用浏览器
 * 自带的阅读器；Word / Excel / PPT 浏览器里打不开，给下载——它们的文字已经
 * 由服务端抽出来交给模型了（services/doc-text.ts）。
 */

/** 对话里的一个附件。 */
export interface ChatFile {
  name: string;
  mimeType: string;
  size: number;
  /** 存进工作区后的路径（_uploads/…）。有它才能在刷新之后再打开。 */
  path?: string;
  /** 刚选的本地文件的 object URL。发送前后立即可看；刷新后没有。 */
  localUrl?: string;
}

/** 工作区里一个文件的原始字节（附件预览、生成的图）。同源、带登录态。 */
export const rawUrl = (sessionId: string, path: string) =>
  `/deploy/api/agent/workspace/raw?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;

const srcOf = (f: ChatFile, sessionId: string | null) =>
  f.localUrl ?? (f.path && sessionId ? rawUrl(sessionId, f.path) : null);

type FileType = 'image' | 'md' | 'text' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'other';

export function fileType(f: { name: string; mimeType: string }): FileType {
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  if (f.mimeType.startsWith('image/')) return 'image';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (['txt', 'csv', 'tsv', 'json', 'html', 'css', 'js', 'xml', 'yaml', 'yml'].includes(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'xls' || ext === 'xlsx') return 'xls';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  return 'other';
}

/** 文件类型角标。颜色沿用各家办公软件的习惯色，人一眼就认得出是什么。 */
const BADGE: Record<FileType, { label: string; bg: string }> = {
  image: { label: 'IMG', bg: '#7c5cff' },
  md: { label: 'MD', bg: '#292724' },
  text: { label: 'TXT', bg: '#72706a' },
  pdf: { label: 'PDF', bg: '#d93025' },
  doc: { label: 'DOC', bg: '#2b579a' },
  xls: { label: 'XLS', bg: '#217346' },
  ppt: { label: 'PPT', bg: '#c43e1c' },
  other: { label: 'FILE', bg: '#a2a09b' },
};

/** 对话里收哪些文件。浏览器的选择框按这个过滤。 */
export const ACCEPT = 'image/*,.md,.markdown,.txt,.csv,.tsv,.json,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
export const MAX_FILE_MB = 10;

export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** 读一个本地文件成 base64（不带 data: 前缀）。 */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('读文件失败'));
    r.readAsDataURL(file);
  });
}

// ── 气泡 ─────────────────────────────────────────────────────────────

export function UserBubble({ text, files = [], sessionId }: {
  text: string; files?: ChatFile[]; sessionId: string | null;
}) {
  const imgs = files.filter((f) => fileType(f) === 'image');
  const docs = files.filter((f) => fileType(f) !== 'image');
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '88%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      {imgs.length > 0 && <Thumbs files={imgs} sessionId={sessionId} />}
      {docs.map((f, i) => <FileCard key={i} file={f} sessionId={sessionId} />)}
      {text && (
        <div
          style={{
            padding: '12px 15px', borderRadius: '18px 18px 6px 18px',
            background: 'var(--accent)', color: 'var(--accent-fg)',
            fontSize: 'var(--text-md)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

export function AiBubble({ text, files = [], sessionId }: {
  text: string; files?: ChatFile[]; sessionId: string | null;
}) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', maxWidth: '100%' }}>
      <span
        aria-hidden
        style={{
          flex: 'none', width: 26, height: 26, borderRadius: 13, marginTop: 1,
          display: 'grid', placeItems: 'center', background: 'var(--brand-wash)', color: 'var(--brand-ink)',
        }}
      >
        <Icon name="sparkles" size={14} />
      </span>
      <div
        style={{
          minWidth: 0, flex: 1, padding: '10px 14px', borderRadius: '6px 18px 18px 18px',
          background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
          fontSize: 'var(--text-md)', lineHeight: 1.75, color: 'var(--text-primary)', wordBreak: 'break-word',
        }}
      >
        <Markdown text={text} />
        {files.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: text ? 8 : 0 }}>
            {files.map((f, i) => (fileType(f) === 'image'
              ? <Thumbs key={i} files={[f]} sessionId={sessionId} />
              : <FileCard key={i} file={f} sessionId={sessionId} />))}
          </div>
        )}
      </div>
    </div>
  );
}

function Thumbs({ files, sessionId }: { files: ChatFile[]; sessionId: string | null }) {
  const [open, setOpen] = useState<ChatFile | null>(null);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
      {files.map((f, i) => {
        const src = srcOf(f, sessionId);
        return (
          <button
            key={i} type="button" onClick={() => setOpen(f)} title={f.name}
            style={{ padding: 0, border: '1px solid var(--border-subtle)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface-2)', cursor: 'zoom-in' }}
          >
            {src
              ? <img src={src} alt={f.name} style={{ display: 'block', width: 120, height: 90, objectFit: 'cover' }} />
              : <span style={{ display: 'grid', placeItems: 'center', width: 120, height: 90, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{f.name}</span>}
          </button>
        );
      })}
      {open && <Preview file={open} sessionId={sessionId} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function FileCard({ file, sessionId, onRemove }: {
  file: ChatFile; sessionId: string | null; onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const t = fileType(file);
  const b = BADGE[t];
  return (
    <>
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10, maxWidth: 280, padding: '8px 10px 8px 8px',
          borderRadius: 12, background: 'var(--surface-1)', border: '1px solid var(--border)', textAlign: 'left',
        }}
      >
        <button
          type="button" onClick={() => setOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0, padding: 0, border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }}
        >
          <span style={{
            flex: 'none', width: 34, height: 34, borderRadius: 8, background: b.bg, color: '#fff',
            display: 'grid', placeItems: 'center', fontSize: 'var(--text-2xs)', fontWeight: 700, letterSpacing: 0.3,
          }}
          >
            {b.label}
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--text-base)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.name}
            </span>
            <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{fmtSize(file.size)}</span>
          </span>
        </button>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`去掉 ${file.name}`} style={{ flex: 'none', padding: 2, border: 0, background: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
            <Icon name="close" size={14} />
          </button>
        )}
      </span>
      {open && <Preview file={file} sessionId={sessionId} onClose={() => setOpen(false)} />}
    </>
  );
}

// ── 预览 ─────────────────────────────────────────────────────────────

function Preview({ file, sessionId, onClose }: { file: ChatFile; sessionId: string | null; onClose: () => void }) {
  const src = srcOf(file, sessionId);
  const t = fileType(file);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if ((t !== 'md' && t !== 'text') || !src) return;
    let alive = true;
    void fetch(src, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((s) => { if (alive) setText(s); })
      .catch(() => { if (alive) setText('（读不到这个文件的内容，可能已经被删掉了。）'); });
    return () => { alive = false; };
  }, [src, t]);

  let body: ReactNode;
  if (!src) body = <Hint>这个附件只在发送它的那个页面里有本地副本，刷新之后打不开了。</Hint>;
  else if (t === 'image') body = <img src={src} alt={file.name} style={{ display: 'block', maxWidth: '100%', maxHeight: '75vh', margin: '0 auto', borderRadius: 8 }} />;
  else if (t === 'pdf') body = <iframe title={file.name} src={src} style={{ width: '100%', height: '75vh', border: 0, borderRadius: 8, background: '#fff' }} />;
  else if (t === 'md') body = text === null ? <Hint>读取中…</Hint> : <Markdown text={text} />;
  else if (t === 'text') body = text === null ? <Hint>读取中…</Hint> : <pre style={PRE}>{text}</pre>;
  else body = <Hint>浏览器里打不开这种文件，下载下来用本地软件看。它里面的文字已经交给模型读过了。</Hint>;

  return (
    <div
      role="dialog" aria-label={file.name} onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(24,23,21,0.45)', display: 'grid', placeItems: 'center', padding: 24 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(860px, 100%)', maxHeight: '90vh', overflow: 'auto', background: 'var(--surface-canvas)',
          borderRadius: 16, padding: '14px 18px 18px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}
          </span>
          {src && (
            <a href={src} download={file.name} style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>下载</a>
          )}
          <button type="button" onClick={onClose} aria-label="关闭" style={{ padding: 4, border: 0, background: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => (
  <p style={{ margin: '24px 0', textAlign: 'center', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{children}</p>
);

// ── Markdown ─────────────────────────────────────────────────────────

const PRE: CSSProperties = {
  margin: '8px 0', padding: '10px 12px', borderRadius: 10, overflow: 'auto',
  background: 'var(--surface-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', lineHeight: 1.6,
  whiteSpace: 'pre', color: 'var(--text-primary)',
};

/** 按 md.ts 解析出的树画。全程 React 元素，没有一处 innerHTML。 */
export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map((b, i) => <MdBlock key={i} b={b} />)}</>;
}

function MdBlock({ b }: { b: Block }) {
  switch (b.t) {
    case 'p': return <p style={{ margin: '4px 0' }}><MdInline xs={b.c} /></p>;
    case 'h': {
      const size = b.level <= 1 ? 'var(--text-lg)' : b.level === 2 ? 'var(--text-card-title)' : 'var(--text-md)';
      return <div role="heading" aria-level={b.level} style={{ margin: '10px 0 4px', fontSize: size, fontWeight: 650, color: 'var(--text-heading)' }}><MdInline xs={b.c} /></div>;
    }
    case 'code': return <pre style={PRE}><code>{b.v}</code></pre>;
    case 'quote':
      return (
        <blockquote style={{ margin: '6px 0', padding: '2px 12px', borderLeft: '3px solid var(--border-hover)', color: 'var(--text-secondary)' }}>
          {b.c.map((x, i) => <MdBlock key={i} b={x} />)}
        </blockquote>
      );
    case 'list': {
      const items = b.items.map((it, i) => <li key={i} style={{ margin: '2px 0' }}>{it.map((x, k) => <MdBlock key={k} b={x} />)}</li>);
      const st: CSSProperties = { margin: '4px 0', paddingLeft: 22 };
      return b.ordered ? <ol start={b.start} style={st}>{items}</ol> : <ul style={st}>{items}</ul>;
    }
    case 'table':
      return (
        <div style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr>{b.head.map((c, i) => <th key={i} style={{ ...CELL, textAlign: b.align[i] ?? 'left', background: 'var(--surface-2)' }}><MdInline xs={c} /></th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>{r.map((c, k) => <td key={k} style={{ ...CELL, textAlign: b.align[k] ?? 'left' }}><MdInline xs={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr': return <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '10px 0' }} />;
  }
}

const CELL: CSSProperties = { padding: '5px 10px', border: '1px solid var(--border)', verticalAlign: 'top' };

function MdInline({ xs }: { xs: Inline[] }) {
  return (
    <>
      {xs.map((x, i) => {
        switch (x.t) {
          case 'text': return x.v;
          case 'br': return <br key={i} />;
          case 'code': return <code key={i} style={{ padding: '1px 5px', borderRadius: 5, background: 'var(--surface-2)', fontFamily: 'var(--font-mono)', fontSize: '0.92em' }}>{x.v}</code>;
          case 'strong': return <strong key={i} style={{ fontWeight: 650 }}><MdInline xs={x.c} /></strong>;
          case 'em': return <em key={i}><MdInline xs={x.c} /></em>;
          case 'del': return <del key={i}><MdInline xs={x.c} /></del>;
          case 'link': return <a key={i} href={x.href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-ink)' }}><MdInline xs={x.c} /></a>;
        }
      })}
    </>
  );
}
