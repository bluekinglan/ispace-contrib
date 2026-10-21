import { useEffect, useState, type ReactNode } from 'react';
import { Icon, useConfirm } from '@ispace/ui';
import { api } from './api';
import { IconBtn } from './workbench';

/**
 * 工作台顶栏那几颗的下拉（左上角「历史版本」、右上角「版本记录」「更多」）。
 *
 * ┌─ 原来点了都只弹一句"还没接上"，现在为什么接得上了 ───────────────────┐
 * │ 它们背后要的东西原来都没有：会话在内存里，一次部署就没了，谈不上"历史"；│
 * │ 工作区每改一次就直接覆盖，没有"版本"；一个人只有一个工作区，"复制一份" │
 * │ 无处可放。                                                             │
 * │                                                                        │
 * │ 会话落库、每轮快照、按页面分工作区（docs/specs/2026-10-21-agent-harness.md）│
 * │ 之后，这三样都有了，下拉只是把它们摆出来。                             │
 * └────────────────────────────────────────────────────────────────────────┘
 */

const ago = (ms: number) => {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return d === 1 ? '昨天' : d < 30 ? `${d} 天前` : new Date(ms).toLocaleDateString('zh-CN');
};

/** 一颗按钮加一块弹出板。点板外任何地方都收起。 */
function Dropdown({ icon, title, align, width, disabled, children }: {
  icon: Parameters<typeof IconBtn>[0]['icon'];
  title: string;
  align: 'left' | 'right';
  width: number;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      {open && <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />}
      <IconBtn icon={icon} title={title} onClick={() => setOpen((v) => !v)} disabled={disabled} />
      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', [align]: 0, zIndex: 31, width,
            boxSizing: 'border-box', padding: 8, borderRadius: 16, maxHeight: 440, overflow: 'auto',
            background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
            boxShadow: '0 24px 48px -16px rgba(24,23,21,.22)', display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

const Label = ({ children }: { children: ReactNode }) => (
  <span style={{ padding: '6px 10px 4px', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{children}</span>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <span style={{ padding: '14px 10px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>{children}</span>
);

function Row({ onClick, active, disabled, children }: {
  onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', border: 0,
        borderRadius: 10, textAlign: 'left', cursor: disabled ? 'default' : 'pointer',
        background: active ? 'var(--surface-2)' : 'transparent', color: 'var(--text-primary)',
        fontSize: 'var(--text-base)', opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

/** 拉一次数据。每次打开下拉都重拉——会话和快照一直在变。 */
function useLoad<T>(load: () => Promise<T>): { data: T | null; err: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    load().then((d) => { if (alive) setData(d); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : '没拉到'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { data, err };
}

// ── 左上角：历史版本（我做过的页面） ─────────────────────────────────────

/**
 * 我最近的会话。点一条就切过去：对话、文件、预览都换成那一个，接着做。
 *
 * 正在做的时候不许切——这一轮的回复会写进一个已经不在眼前的会话里。
 */
export function SessionsMenu({ currentId, busy, onOpen }: {
  currentId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <Dropdown icon="history" title={busy ? '等这一轮做完再切' : '历史版本：我做过的页面'} align="left" width={300} disabled={busy}>
      {(close) => <SessionsList currentId={currentId} onPick={(id) => { close(); if (id !== currentId) onOpen(id); }} />}
    </Dropdown>
  );
}

function SessionsList({ currentId, onPick }: { currentId: string | null; onPick: (id: string) => void }) {
  const { data, err } = useLoad(() => api.agentSessions());
  if (err) return <Empty>没拉到：{err}</Empty>;
  if (!data) return <Empty>读取中…</Empty>;
  if (!data.items.length) return <Empty>还没有做过的页面。说一句话开始做，这里就会有了。</Empty>;
  return (
    <>
      <Label>我做过的页面（点一个接着做）</Label>
      {data.items.map((s) => (
        <Row key={s.id} onClick={() => onPick(s.id)} active={s.id === currentId}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: s.id === currentId ? 600 : 400 }}>
              {s.title}
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              {ago(s.updatedAt)}{s.slug ? ` · 已发布 /${s.slug}/` : ''}
            </span>
          </span>
          {s.id === currentId && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>当前</span>}
        </Row>
      ))}
    </>
  );
}

// ── 右上角：版本记录（这个页面的每一步） ─────────────────────────────────

/**
 * 这个页面的每一步：每一句话开工前拍的那张快照。
 *
 * 点「退回到这一步之前」= 文件回到那句话说出口之前的样子，对话也截回那一刻，
 * 之后的步骤作废。「撤回这一步」就是退最近那一步的特例。
 */
export function VersionsMenu({ sessionId, busy, onRestored, onToast }: {
  sessionId: string | null;
  busy: boolean;
  onRestored: (r: { label: string; left: number }) => void;
  onToast: (t: string) => void;
}) {
  return (
    <Dropdown icon="history" title={busy ? '等这一轮做完' : '版本记录：退回到某一步'} align="right" width={320} disabled={busy || !sessionId}>
      {(close) => (sessionId
        ? <VersionsList sessionId={sessionId} onRestored={(r) => { close(); onRestored(r); }} onToast={onToast} />
        : <Empty>还没有会话。</Empty>)}
    </Dropdown>
  );
}

function VersionsList({ sessionId, onRestored, onToast }: {
  sessionId: string;
  onRestored: (r: { label: string; left: number }) => void;
  onToast: (t: string) => void;
}) {
  const { data, err } = useLoad(() => api.agentVersions(sessionId));
  const [doing, setDoing] = useState<number | null>(null);
  /* 页面自己的确认框，不用浏览器原生 confirm()：后者长得像系统报错，也说不清后果 */
  const [confirmUI, ask] = useConfirm();
  if (err) return <Empty>没拉到：{err}</Empty>;
  if (!data) return <Empty>读取中…</Empty>;
  if (!data.items.length) return <Empty>还没有可以退回的步骤。每说一句话，这里多一步。</Empty>;

  const back = async (seq: number, label: string) => {
    const short = label.length > 16 ? `${label.slice(0, 16)}…` : label;
    if (!(await ask({
      title: `退回到「${short}」之前？`,
      description: '这一步和它之后的改动都会撤掉，文件和对话一起退。',
      confirmLabel: '退回',
      danger: true,
    }))) return;
    setDoing(seq);
    try {
      onRestored(await api.agentRestore(sessionId, seq));
    } catch (e) {
      onToast(e instanceof Error ? e.message : '退回失败');
    } finally { setDoing(null); }
  };

  return (
    <>
      {confirmUI}
      <Label>每一步开工前都存了一版，点哪步就退回到它之前</Label>
      {data.items.map((v, i) => (
        <Row key={v.seq} onClick={() => void back(v.seq, v.label)} disabled={doing !== null}>
          <span
            className="mono"
            style={{ flex: 'none', width: 26, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}
          >
            {data.items.length - i}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {v.label || '（没有文字）'}
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              {ago(v.at)}{i === 0 ? ' · 最近一步' : ''}
            </span>
          </span>
          <span style={{ flex: 'none', fontSize: 'var(--text-sm)', color: 'var(--brand-ink)' }}>
            {doing === v.seq ? '退回中…' : '退回到这之前'}
          </span>
        </Row>
      ))}
    </>
  );
}

// ── 右上角：更多 ────────────────────────────────────────────────────────

/**
 * 导出的会话日志。只放平台真有的东西——稿上那几项（permission / preset /
 * goal）是照 DeepSeek Harness 画的，这台平台没有那些概念，就不编。
 */
export interface SessionLog {
  app: 'iDo';
  exportedAt: string;
  title: string;
  /** 第一句话。 */
  prompt: string;
  model: string;
  effort: string | null;
  sessionId: string | null;
  /** 发布到了哪儿，没发布就是 null。 */
  publishedUrl: string | null;
  messages: { role: 'user' | 'assistant' | 'system'; text: string }[];
  /** 模型真调过的工具，按顺序。 */
  steps: { tool: string; detail: string }[];
}

export function MoreMenu({ sessionId, title, busy, onFork, onToast, log, onImported }: {
  sessionId: string | null;
  title: string;
  busy: boolean;
  onFork: (newId: string) => void;
  onToast: (t: string) => void;
  /** 这次会话的内容，导出 JSON 用。拿不到就不画那一项。 */
  log?: () => SessionLog;
  /** 导入完要让「代码」页和预览重新读一遍——文件变了。 */
  onImported: () => void;
}) {
  const [forking, setForking] = useState(false);
  const [importing, setImporting] = useState(false);
  return (
    <Dropdown icon="more" title="更多" align="right" width={248} disabled={!sessionId}>
      {(close) => (
        <>
          <Row
            onClick={() => {
              close();
              if (!sessionId) return;
              /* 同源、带登录态，交给浏览器直接下载；文件名用页面标题 */
              const a = document.createElement('a');
              a.href = api.workspaceZipUrl(sessionId, title);
              a.download = `${title}.zip`;
              a.click();
              onToast('开始下载代码包（不含设计草稿和附件）');
            }}
          >
            <Icon name="download" size={15} color="var(--text-secondary)" />
            <span style={{ flex: 1 }}>导出代码<span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>打包成 zip，就是会发布出去的那些文件</span></span>
          </Row>
          <Row
            disabled={busy || importing}
            onClick={() => {
              if (!sessionId) return;
              /* 不自己画文件选择框：系统的那个已经会按扩展名过滤、会记住上次的目录 */
              const el = document.createElement('input');
              el.type = 'file';
              el.accept = '.zip,application/zip';
              el.onchange = async () => {
                const f = el.files?.[0];
                if (!f) return;
                close();
                setImporting(true);
                try {
                  const r = await api.workspaceImport(sessionId, f);
                  onToast(`导进来 ${r.files} 个文件，接着说要改什么就行`);
                  onImported();
                } catch (e) {
                  onToast(e instanceof Error ? e.message : '导入失败');
                } finally { setImporting(false); }
              };
              el.click();
            }}
          >
            <Icon name="fileUp" size={15} color="var(--text-secondary)" />
            <span style={{ flex: 1 }}>导入代码包<span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>把已有的 zip 解进工作区，接着改</span></span>
          </Row>
          {log && (
            <Row
              onClick={() => {
                close();
                /*
                  稿上这一项导出的字段里有 harness: 'DeepSeek Harness'——那是
                  设计稿照着 dsh 画的。我们不是它，就不写那一行；也不写
                  permission / preset / goal 这些平台根本没有的概念。
                  导出的是这台平台真有的东西。
                */
                const data = log();
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${title || 'ido'}-会话.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                onToast('会话日志已下载');
              }}
            >
              <Icon name="scroll" size={15} color="var(--text-secondary)" />
              <span style={{ flex: 1 }}>下载日志<span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>把这次会话导出为 JSON 文件</span></span>
            </Row>
          )}
          <Row
            disabled={busy || forking}
            onClick={async () => {
              if (!sessionId) return;
              setForking(true);
              try {
                const r = await api.agentFork(sessionId);
                close();
                onFork(r.sessionId);
              } catch (e) {
                onToast(e instanceof Error ? e.message : '复制失败');
              } finally { setForking(false); }
            }}
          >
            <Icon name="copy" size={15} color="var(--text-secondary)" />
            <span style={{ flex: 1 }}>
              {forking ? '复制中…' : '复制为新页面'}
              <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                {busy ? '等这一轮做完再复制' : '文件拷一份，对话从头开始'}
              </span>
            </span>
          </Row>
        </>
      )}
    </Dropdown>
  );
}
