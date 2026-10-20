import { useEffect, useState } from 'react';
import { Icon, copyText } from '@ispace/ui';
import { api } from './api';
import { Segment } from './detail';

/**
 * 创建 · 工作台（新稿 §创建 · 工作台）的零件。
 *
 * 新稿把「说一句就开做」改成了三段：**问 → 扇出 → 做**。这个文件装的是
 * 这三段各自的那块 UI，以及右栏那三页（预览 / 代码 / 设计）。编排在
 * create.tsx 里——那边握着会话、预览和发布。
 *
 * ┌─ 哪些是真的，哪些是脚本 ────────────────────────────────────────────┐
 * │ 开头那两道题（PLATFORM_ASKS）是**平台的固定脚本**，不是模型问的：   │
 * │ 「走不走扇出」「主要在哪儿看」决定的是这一屏接下来怎么走，而不是   │
 * │ 页面长什么样——这种分叉该由平台直接问，省掉一轮模型调用，也不会出  │
 * │ 现"模型忘了问"。代码里它们和模型问的那种（from: 'model'）是两类，   │
 * │ 不混为一谈。                                                        │
 * │                                                                      │
 * │ 模型自己要问的时候走 ask_user 工具（packages/agent/src/tools.ts），  │
 * │ 这里把它画成同一种卡片。两者的区别在数据上留着，在人眼里是一致的。  │
 * │                                                                      │
 * │ 扇出那六个 Agent 是**真的六个模型会话**（/agent/fanout），卡片里装   │
 * │ 的是它们各自写出来的那份 HTML，不是示意图。                          │
 * └──────────────────────────────────────────────────────────────────────┘
 */

// ── 问 ─────────────────────────────────────────────────────────────────
export interface AskOption {
  /** 平台那两道题用它来路由；模型问的那种没有。 */
  key?: string;
  label: string;
  hint?: string;
  recommended?: boolean;
}

export interface Ask {
  from: 'platform' | 'model';
  /** 问题前面那句话。 */
  lead?: string;
  question: string;
  options: AskOption[];
}

/**
 * 开头那两道固定题。
 *
 * 步进写成「1 / 1」和「2 / 2」而不是「1 / 2」「2 / 2」：第一问的时候还不
 * 知道要不要问第二问（选了「直接做一版」就没有第二问了）。写 1/2 是先许一
 * 个可能不兑现的诺。
 */
export const PLATFORM_ASKS: { ask: Ask; step: string }[] = [
  {
    step: '1 / 1',
    ask: {
      from: 'platform',
      lead: '收到。开始之前确认一件事：',
      question: '你想从哪种方式开始？',
      options: [
        { key: 'fan', label: '生成六版视觉设计', hint: '先并排看 6 个方向，挑一个再往下做', recommended: true },
        { key: 'direct', label: '直接做一版', hint: '跳过挑选，按 iSpace 默认风格生成' },
        { key: 'talk', label: '先把需求聊清楚', hint: '我再问你一两个问题，第一版会更准' },
      ],
    },
  },
  {
    step: '2 / 2',
    ask: {
      from: 'platform',
      lead: '好，先问清楚一点：',
      question: '主要在哪儿用？',
      options: [
        { key: 'phone', label: '手机为主', hint: '组里同事随手打开，竖屏优先', recommended: true },
        { key: 'pc', label: '电脑为主', hint: '在工位上用，信息可以排得更密' },
        { key: 'both', label: '两边都要', hint: '手机和电脑各出一套布局' },
      ],
    },
  },
];

export function AskCard({ ask, step, onPick, disabled }: {
  ask: Ask;
  step?: string;
  onPick: (o: AskOption, index: number) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {ask.lead && (
        <div style={{ fontSize: 'var(--text-md)', lineHeight: 1.75, color: 'var(--text-primary)' }}>
          {ask.lead}
        </div>
      )}
      <div
        style={{
          display: 'flex', flexDirection: 'column', gap: 10, padding: 16, borderRadius: 18,
          background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ flex: 1, fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
            {ask.question}
          </span>
          {step && (
            <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              {step}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ask.options.map((o, i) => (
            <button
              key={o.key ?? o.label}
              onClick={() => !disabled && onPick(o, i)}
              disabled={disabled}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                border: '1px solid var(--border-subtle)', borderRadius: 12,
                background: 'var(--surface-canvas)', cursor: disabled ? 'default' : 'pointer',
                textAlign: 'left', opacity: disabled ? 0.6 : 1,
              }}
            >
              <span
                className="mono"
                style={{
                  width: 22, height: 22, flex: 'none', borderRadius: 'var(--radius-pill)',
                  background: 'var(--surface-2)', color: 'var(--text-tertiary)',
                  fontSize: 'var(--text-sm)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
                    {o.label}
                  </span>
                  {o.recommended && (
                    <span
                      style={{
                        height: 20, padding: '0 7px', borderRadius: 'var(--radius-pill)',
                        background: 'var(--brand-wash)', color: 'var(--tabby-orange)',
                        fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)',
                        display: 'flex', alignItems: 'center',
                      }}
                    >
                      推荐
                    </span>
                  )}
                </span>
                {o.hint && (
                  <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
                    {o.hint}
                  </span>
                )}
              </span>
              <Icon name="chevRight" size={15} color="var(--text-tertiary)" />
            </button>
          ))}
        </div>

        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          都不合适？直接在下面输入你的想法
        </span>
      </div>
    </div>
  );
}

// ── 扇出 ───────────────────────────────────────────────────────────────
export interface FanDir {
  index: number;
  key: string;
  name: string;
  bg: string;
  dot: string;
  /** 相对工作区的路径。配上预览会话的地址就能直接看。 */
  path: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  turns?: number;
  ms?: number;
  message?: string;
}

/**
 * 跑一次设计扇出。
 *
 * 和 streamAsk 同一套读法（fetch + ReadableStream 读 SSE），但这条流不进对话
 * 历史——它是 N 个一次性任务的进度，不是一轮会话。
 */
export function useFanout() {
  const [dirs, setDirs] = useState<FanDir[]>([]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async (opts: {
    text: string;
    device: 'phone' | 'pc' | 'both';
    model: string;
    effort: string | null;
  }) => {
    setRunning(true);
    setErr(null);
    setDirs([]);
    try {
      const res = await fetch('/deploy/api/agent/fanout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: opts.text,
          device: opts.device,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => '');
        let msg = raw.slice(0, 200);
        try {
          const body = JSON.parse(raw) as { message?: string };
          if (body.message) msg = body.message;
        } catch { /* 不是 JSON 就用原文 */ }
        setErr(msg || `接口返回 ${res.status}`);
        return;
      }
      await readSse(res.body, (e) => {
        if (e.type === 'run') {
          setDirs((e.dirs as Omit<FanDir, 'state'>[]).map((d) => ({ ...d, state: 'queued' })));
        } else if (e.type === 'dir_start') {
          setDirs((xs) => xs.map((d) => (d.index === e.index ? { ...d, state: 'running' } : d)));
        } else if (e.type === 'dir_done') {
          setDirs((xs) => xs.map((d) => (
            d.index === e.index
              ? { ...d, state: 'done', turns: e.turns as number, ms: e.ms as number }
              : d
          )));
        } else if (e.type === 'dir_error') {
          setDirs((xs) => xs.map((d) => (
            d.index === e.index
              ? { ...d, state: 'failed', message: String(e.message ?? '') }
              : d
          )));
          if (e.index === -1) setErr(String(e.message ?? '扇出失败'));
        }
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '扇出失败');
    } finally {
      setRunning(false);
    }
  };

  return { dirs, running, err, start };
}

/** 逐条读 SSE。两条流（对话与扇出）共用。 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  on: (e: Record<string, unknown> & { type: string }) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        on(JSON.parse(line.slice(6)) as Record<string, unknown> & { type: string });
      } catch { /* 半条就丢掉，下一条照常 */ }
    }
  }
}

/**
 * 设计画廊（右栏「设计」页）。
 *
 * 每张卡片里是那一版**真的页面**，用预览地址装进 iframe。没有 iframe 就
 * 只能摆一块色块当示意——而人要挑的恰恰是"它到底长什么样"，色块挑不出来。
 *
 * iframe 一律 `pointer-events: none`：这是一张给人看的缩略图，不是能点的
 * 页面。真要点，挑中它、做出来再点。
 */
export function DesignGallery({ dirs, previewUrl, picked, onPick, onMore, busy }: {
  dirs: FanDir[];
  /** 预览会话的根地址（末尾带斜杠）。为空时卡片只画底色。 */
  previewUrl: string | null;
  picked: number | null;
  onPick: (d: FanDir) => void;
  onMore: () => void;
  busy: boolean;
}) {
  const done = dirs.filter((d) => d.state === 'done').length;

  if (!dirs.length) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 340, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
          <Icon name="sparkles" size={22} color="var(--text-tertiary)" />
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
            还没有设计方向
          </span>
          <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
            在左边选「生成六版视觉设计」，这里会并排出几个方向。
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 20px 20px' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 14px',
          borderRadius: 12, background: 'var(--surface-2)', marginBottom: 16,
        }}
      >
        <Icon name="sparkles" size={15} color="var(--tabby-orange)" />
        <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
          {done < dirs.length ? `${done} / ${dirs.length} 个方向好了` : `${dirs.length} 个方向`}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onMore}
          disabled={busy || picked === null}
          title={picked === null ? '先挑一个方向' : '照这一版再出几个相近的'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
            border: 0, borderRadius: 9, background: 'transparent',
            color: busy || picked === null ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
            cursor: busy || picked === null ? 'default' : 'pointer',
          }}
        >
          <Icon name="rotate" size={14} />更多类似
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 18 }}>
        {dirs.map((d) => {
          const on = picked === d.index;
          const ready = d.state === 'done';
          return (
            <div key={d.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                onClick={() => ready && onPick(d)}
                style={{
                  position: 'relative', aspectRatio: '3 / 4', borderRadius: 16, overflow: 'hidden',
                  background: d.bg, cursor: ready ? 'pointer' : 'default',
                  boxShadow: on
                    ? '0 0 0 3px var(--tabby-orange), 0 24px 48px -28px rgba(24,23,21,.45)'
                    : '0 18px 36px -24px rgba(24,23,21,.35), 0 0 0 1px var(--border-subtle)',
                }}
              >
                {ready && previewUrl && (
                  <iframe
                    src={`${previewUrl}${d.path}`}
                    title={d.name}
                    sandbox="allow-scripts"
                    style={{
                      position: 'absolute', top: 0, left: 0, width: '250%', height: '250%',
                      transform: 'scale(.4)', transformOrigin: 'top left',
                      border: 0, pointerEvents: 'none', background: d.bg,
                    }}
                  />
                )}
                {!ready && (
                  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                    <span
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                        borderRadius: 'var(--radius-pill)', background: 'rgba(255,255,255,.82)',
                        fontSize: 'var(--text-base)', color: '#181715',
                      }}
                    >
                      {d.state === 'failed'
                        ? <>没出来</>
                        : <><Icon name="rotate" size={13} />{d.state === 'running' ? '生成中…' : '排队'}</>}
                    </span>
                  </div>
                )}
                {on && (
                  <span
                    style={{
                      position: 'absolute', top: 10, left: 10, display: 'flex', alignItems: 'center',
                      gap: 5, height: 24, padding: '0 9px', borderRadius: 'var(--radius-pill)',
                      background: 'var(--tabby-orange)', color: '#fff',
                      fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)',
                    }}
                  >
                    <Icon name="check" size={12} />已选
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, flex: 'none', borderRadius: 'var(--radius-pill)', background: d.dot }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
                  {d.name}
                </span>
                {ready && (
                  <button
                    onClick={() => onPick(d)}
                    style={{
                      height: 26, padding: '0 10px', border: '1px solid var(--border-hover)',
                      borderRadius: 8, background: on ? 'var(--brand-wash)' : 'var(--surface-1)',
                      color: on ? 'var(--tabby-orange)' : 'var(--text-secondary)',
                      fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)',
                      cursor: 'pointer',
                    }}
                  >
                    {on ? '正在用' : '用这一版'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 「处理中… · 已完成 N 步」那一块。
 *
 * 新稿把工具调用摞进一个可收起的块里，默认展开。收起来之后只剩一行标题
 * ——这一步是对的：一次生成会调十几次工具，全摊开会把模型说的话挤没。
 */
export function ProcessBlock({ steps, agents, busy, skill }: {
  steps: { key: string; title: string; detail: string; done: boolean }[];
  /** 扇出那几个 Agent。没扇出就是空的，那一段整段不画。 */
  agents: FanDir[];
  busy: boolean;
  /** 用到的技能名。眼下只有扇出会用。 */
  skill: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const n = steps.filter((s) => s.done).length + (agents.filter((a) => a.state === 'done').length ? 1 : 0);
  if (!steps.length && !agents.length) return null;

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', padding: '12px 14px', borderRadius: 16,
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: 0, border: 0,
          background: 'transparent', color: 'var(--text-secondary)',
          fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
        }}
      >
        {busy && <Icon name="rotate" size={14} color="var(--tabby-orange)" />}
        <span style={{ flex: 1, textAlign: 'left' }}>
          {busy ? `处理中… · 已完成 ${n} 步` : `已完成 ${n} 步`}
        </span>
        <Icon name={open ? 'chevUp' : 'chevDown'} size={15} color="var(--text-tertiary)" />
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 10 }}>
          {skill && (
            <>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 'var(--text-base)', color: 'var(--text-heading)' }}>
                <Icon name="book" size={15} color="var(--text-tertiary)" />
                调用技能 {skill}
              </span>
              <button
                onClick={() => setAgentsOpen((v) => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', border: 0,
                  background: 'transparent', color: 'var(--text-secondary)',
                  fontSize: 'var(--text-base)', cursor: 'pointer',
                }}
              >
                <Icon
                  name={agents.every((a) => a.state === 'done' || a.state === 'failed') ? 'check' : 'rotate'}
                  size={14}
                  color={agents.every((a) => a.state === 'done' || a.state === 'failed')
                    ? 'var(--success)' : 'var(--tabby-orange)'}
                />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {agents.every((a) => a.state !== 'queued' && a.state !== 'running')
                    ? `运行了 ${agents.length} 个 Design Agent`
                    : `正在运行 ${agents.length} 个 Design Agent · ${agents.filter((a) => a.state === 'done').length}/${agents.length}`}
                </span>
                <Icon name={agentsOpen ? 'chevUp' : 'chevDown'} size={15} color="var(--text-tertiary)" />
              </button>
              {agentsOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6 }}>
                  {agents.map((a) => (
                    <div key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 30, paddingLeft: 24 }}>
                      <Icon
                        name={a.state === 'done' ? 'check' : a.state === 'running' ? 'rotate' : a.state === 'failed' ? 'close' : 'info'}
                        size={13}
                        color={a.state === 'done' ? 'var(--success)'
                          : a.state === 'running' ? 'var(--tabby-orange)'
                            : a.state === 'failed' ? 'var(--error)' : 'var(--text-tertiary)'}
                      />
                      <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
                        isp-design · {a.name}
                      </span>
                      <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                        {a.state === 'done' ? `${a.turns} 轮 · ${fmtMs(a.ms ?? 0)}`
                          : a.state === 'running' ? '运行中'
                            : a.state === 'failed' ? '没出来' : '排队'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {steps.map((s, i) => (
            <div key={`${s.key}-${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '5px 0' }}>
              <Icon
                name={s.done ? 'check' : 'rotate'}
                size={14}
                color={s.done ? 'var(--success)' : 'var(--tabby-orange)'}
                style={{ marginTop: 3 }}
              />
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-heading)' }}>{s.title}</span>
                {s.detail && (
                  <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>
                    {s.detail}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** 挑中一版之后那条微调条。每个按钮就是一句写好的追问。 */
export const REFINES: { key: string; label: string; icon: 'minus' | 'moon' | 'sparkles'; text: string }[] = [
  { key: 'simple', label: '简化', icon: 'minus', text: '这一版再简化一点：去掉次要的装饰和信息，留下最该看的那几样。' },
  { key: 'night', label: '夜间版', icon: 'moon', text: '按同样的结构做一个夜间配色的版本，对比别太生硬。' },
];

export function RefineBar({ pickName, onRefine, onFresh, busy }: {
  pickName: string;
  onRefine: (text: string) => void;
  onFresh: () => void;
  busy: boolean;
}) {
  const chip = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 11px',
    border: '1px solid var(--border-subtle)', borderRadius: 10,
    background: 'var(--surface-1)', color: on ? 'var(--text-heading)' : 'var(--text-tertiary)',
    fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
    cursor: on ? 'pointer' : 'default',
  });

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '12px 14px',
        borderRadius: 16, background: 'var(--surface-2)',
      }}
    >
      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
        对「{pickName}」
      </span>
      {REFINES.map((r) => (
        <button key={r.key} onClick={() => !busy && onRefine(r.text)} disabled={busy} style={chip(!busy)}>
          <Icon name={r.icon === 'minus' ? 'close' : r.icon === 'moon' ? 'bulb' : 'sparkles'} size={13} />
          {r.label}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button onClick={() => !busy && onFresh()} disabled={busy} style={chip(!busy)}>
        <Icon name="sparkles" size={13} />新设计
      </button>
    </div>
  );
}

// ── 右栏：代码页 ────────────────────────────────────────────────────────
/**
 * 文件浏览器。
 *
 * 只读。改文件是模型的事——摆一个能编辑的编辑器，等于让人和模型同时改同
 * 一份东西，而谁都不知道对方改了什么。想改哪里，在左边说一句。
 */
export function CodePane({ rev }: { rev: number }) {
  const [entries, setEntries] = useState<{ path: string; dir: boolean; size: number }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<{ text: string; binary?: boolean; tooBig?: boolean; size: number } | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    void api.workspaceTree()
      .then((r) => {
        setEntries(r.entries);
        setSel((s) => s ?? r.entries.find((e) => e.path === 'index.html')?.path
          ?? r.entries.find((e) => !e.dir)?.path ?? null);
      })
      .catch(() => setEntries([]));
  }, [rev]);

  useEffect(() => {
    if (!sel) { setFile(null); return; }
    let alive = true;
    void api.workspaceFile(sel)
      .then((r) => { if (alive) setFile(r); })
      .catch(() => { if (alive) setFile(null); });
    return () => { alive = false; };
  }, [sel, rev]);

  const files = entries.filter((e) => !e.dir && (!q.trim() || e.path.includes(q.trim())));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', borderTop: '1px solid var(--border-tabby)' }}>
      <div
        style={{
          width: 230, flex: 'none', display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border-tabby)', background: 'var(--surface-1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, padding: '0 12px' }}>
          <span style={{ flex: 1, fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
            文件
          </span>
          <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            {files.length}
          </span>
        </div>
        <div style={{ padding: '0 10px 8px' }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 9px',
              borderRadius: 9, background: 'var(--surface-2)',
            }}
          >
            <Icon name="search" size={13} color="var(--text-tertiary)" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="筛文件"
              style={{
                flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
                fontSize: 'var(--text-base)', color: 'var(--text-primary)', fontFamily: 'inherit',
              }}
            />
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 10px' }}>
          {files.length === 0 && (
            <span style={{ display: 'block', padding: '8px 10px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              工作区还是空的
            </span>
          )}
          {files.map((e) => {
            const on = e.path === sel;
            const depth = e.path.split('/').length - 1;
            return (
              <button
                key={e.path}
                onClick={() => setSel(e.path)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, width: '100%', height: 30,
                  padding: `0 8px 0 ${8 + depth * 12}px`, border: 0, borderRadius: 8,
                  background: on ? 'var(--surface-3)' : 'transparent',
                  color: on ? 'var(--text-heading)' : 'var(--text-secondary)',
                  fontSize: 'var(--text-base)', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <Icon name={kindIcon(e.path)} size={13} color="var(--text-tertiary)" />
                <span
                  title={e.path}
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {shortPath(e.path)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-canvas)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 14px', borderBottom: '1px solid var(--border-tabby)' }}>
          <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sel ?? '没有选中文件'}
          </span>
          {file && !file.binary && !file.tooBig && (
            <button
              onClick={() => void copyText(file.text)}
              style={{
                height: 26, padding: '0 9px', border: '1px solid var(--border-subtle)',
                borderRadius: 8, background: 'var(--surface-1)', color: 'var(--text-secondary)',
                fontSize: 'var(--text-sm)', cursor: 'pointer',
              }}
            >
              复制
            </button>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
          {!file && (
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              左边挑一个文件。
            </span>
          )}
          {file?.binary && (
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              这是个二进制文件（{Math.max(1, Math.round(file.size / 1024))} KB），在「预览」里看它的效果。
            </span>
          )}
          {file?.tooBig && (
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              文件太大（{Math.round(file.size / 1024)} KB），这里不展开。
            </span>
          )}
          {file && !file.binary && !file.tooBig && (
            <pre
              className="mono"
              style={{
                margin: 0, fontSize: 'var(--text-base)', lineHeight: 1.7,
                color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}
            >
              {file.text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 列表里显示成什么。
 *
 * 只取文件名不行：扇出那六版都叫 index.html，列出来是六行一模一样的东西。
 * 取最后两段（`paper/index.html`），既短又能分得开；完整路径在 title 里。
 */
function shortPath(path: string): string {
  const parts = path.split('/');
  return parts.length <= 1 ? path : parts.slice(-2).join('/');
}

function kindIcon(path: string): 'fileUp' | 'image' | 'shapes' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'].includes(ext)) return 'image';
  if (['html', 'css', 'js', 'mjs', 'ts', 'tsx', 'json'].includes(ext)) return 'shapes';
  return 'fileUp';
}

// ── 右栏：发布下拉 ──────────────────────────────────────────────────────
/**
 * 发布面板（新稿右上角那个下拉）。
 *
 * 和原来那条底栏是同一套动作，位置换了：底栏在"预览 / 代码 / 设计"三页之
 * 间来回切时会跟着内容挪，而发布是与当前看哪一页无关的事。
 */
export function PublishMenu({
  published, url, title, vis, setVis, canPublish, publishing, onPublish, onMine, onToast, onClose,
}: {
  published: boolean;
  url: string;
  title: string;
  vis: 'private' | 'shared' | 'public';
  setVis: (v: 'private' | 'shared' | 'public') => void;
  canPublish: boolean;
  publishing: boolean;
  onPublish: () => void;
  onMine: () => void;
  onToast: (t: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 31, width: 320,
        boxSizing: 'border-box', padding: '14px 16px 16px', borderRadius: 18,
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        boxShadow: '0 24px 48px -16px rgba(24,23,21,.22), 0 2px 6px rgba(24,23,21,.05)',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
          {published ? '已经上线了' : title}
        </span>
        <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>
          {url || '发布之后才有地址'}
        </span>
      </div>

      {published ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => void copyText(url).then((ok) => onToast(ok ? '地址已复制' : url))}
            style={{
              flex: 1, height: 38, border: '1px solid var(--border-hover)', borderRadius: 11,
              background: 'var(--surface-1)', color: 'var(--text-heading)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            复制地址
          </button>
          <button
            onClick={() => { onClose(); onMine(); }}
            style={{
              flex: 1, height: 38, border: 0, borderRadius: 11, background: 'var(--accent)',
              color: 'var(--accent-fg)', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            去我的作品
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>谁能看</span>
            <Segment
              options={[
                { k: 'private', label: '仅自己' },
                { k: 'shared', label: '指定同事' },
                { k: 'public', label: '全公司' },
              ]}
              value={vis}
              onPick={(k) => setVis(k as 'private')}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}
            />
          </div>
          <button
            onClick={onPublish}
            disabled={!canPublish || publishing}
            style={{
              height: 40, border: 0, borderRadius: 11,
              background: canPublish && !publishing ? 'var(--cta)' : 'var(--surface-3)',
              color: canPublish && !publishing ? 'var(--cta-fg)' : 'var(--text-tertiary)',
              fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)',
              cursor: canPublish && !publishing ? 'pointer' : 'default',
            }}
          >
            {publishing ? '正在发布…' : canPublish ? '发布到我的空间' : '还没准备好发布'}
          </button>
          <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
            发布前会自动扫一遍密钥和 XSS 规则。
          </span>
        </>
      )}
    </div>
  );
}

/** 右栏那三页。顺序照新稿：预览在前，代码其次，设计最后。 */
export const TABS: { k: 'preview' | 'code' | 'design'; label: string; icon: 'monitor' | 'shapes' | 'layers' }[] = [
  { k: 'preview', label: '预览', icon: 'monitor' },
  { k: 'code', label: '代码', icon: 'shapes' },
  { k: 'design', label: '设计', icon: 'layers' },
];

export function TabBar({ cur, onPick }: {
  cur: 'preview' | 'code' | 'design';
  onPick: (k: 'preview' | 'code' | 'design') => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 12, background: 'var(--seg-bg)' }}>
      {TABS.map((t) => {
        const on = t.k === cur;
        return (
          <button
            key={t.k}
            onClick={() => onPick(t.k)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px',
              border: 0, borderRadius: 9,
              background: on ? 'var(--surface-1)' : 'transparent',
              boxShadow: on ? '0 1px 2px rgba(24,23,21,.08), 0 0 0 1px var(--border-subtle)' : 'none',
              color: on ? 'var(--text-heading)' : 'var(--text-tertiary)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            <Icon name={t.icon} size={14} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
