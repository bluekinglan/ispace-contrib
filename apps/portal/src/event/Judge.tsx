import { useCallback, useEffect, useState } from 'react';
import {
  CURRENT_EVENT_SLUG, EVENT_PATH, judgeOnScoring, phaseAtLeast,
  type EventCriterion, type EventJudgeItem, type EventJudgeResponse,
} from '@ispace/contracts';
import { Badge, Button, GlobalKeyframes, Toast, ToneProvider } from '@ispace/ui';
import { api } from '../api';
import { EIcon, EventKeyframes, Mark } from './visual';
import { EventOrange } from './styles';
import { Screening } from './Screening';

/**
 * 评委打分页（/1024/judge）。
 *
 * ┌─ 一条贯穿全页的规则：评委之间互相看不到分数 ──────────────────────┐
 * │ 这不是界面措辞，是赛制。所以接口只返回**自己**的分，加一个「其他     │
 * │ 评委几人已提交」的计数——计数不泄露任何一个人的判断，但能让评委知道  │
 * │ 自己是不是拖后腿的那个。                                           │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 电脑和手机是同一个地址：会议室里评委多半拿手机打分，但也有人带电脑。
 * 宽屏是「左边列表 + 右边详情」，窄屏是「顶部编号 chip + 下方详情」，
 * 靠一个 CSS 媒体查询切，不做两套路由。
 *
 * 打完的分去哪儿：服务端按已提交分数的平均值给项目排名次
 * （routes/events.ts 的 computeRanking），一、二、三等奖照它定。
 * 评委自己看不到名次——看得到就会互相对齐，平均分就没意义了。
 */

const WIDE = 900;

/** 初筛投票页也用同一个断点——两页是同一块屏上的同一件事，不该各有各的。 */
export function useWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(`(min-width:${WIDE}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width:${WIDE}px)`);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** 本地草稿：拖滑块时不每动一下就打一次接口，点「提交打分」才落库。 */
type Draft = { dims: (number | null)[]; note: string };

export function Judge() {
  const [data, setData] = useState<EventJudgeResponse | null>(null);
  const [err, setErr] = useState<{ msg: string; needLogin: boolean } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [toast, setToast] = useState<{ msg: string; tone: 'info' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  const wide = useWide();

  const load = useCallback(async () => {
    try {
      const r = await api.judgeBoard(CURRENT_EVENT_SLUG);
      setData(r);
      setSel((s) => s ?? r.items[0]?.ideaId ?? null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setErr({
        msg: e instanceof Error ? e.message : '打不开打分页',
        needLogin: code === 'UNAUTHENTICATED',
      });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /*
    初筛期这一页是「投票」，不是「打分」。

    两件事都只有评委能做、都在同一个地址，但对象不同：初筛投的是**创意**
    （还没有作品），打分打的是**入围作品**。按阶段分流而不是加个标签页：
    任一时刻只有一件事是该做的，摆两个入口只会让人点错。

    放在 err 之后：「不是本届评委」那层拦截两种形态共用，不必写两遍。

    分界线是初筛封票（judgeOnScoring），不是阶段切换：封票之后阶段还会是
    screening 半小时（等公布），但那半小时里投票页已经投不动了，入围名单
    也自动定了——直接给打分页，提交按钮在路演前置灰。
  */
  if (data && !judgeOnScoring(data.event)) {
    return (
      <ToneProvider tone="business">
        <GlobalKeyframes />
        <EventKeyframes />
        <EventOrange />
        <Screening />
      </ToneProvider>
    );
  }

  if (err) {
    return (
      <ToneProvider tone="business">
        <div style={{
          minHeight: '100vh', display: 'grid', placeItems: 'center',
          background: 'var(--surface-canvas)', padding: 24, textAlign: 'center',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <Mark size={36} />
            <p style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary)' }}>{err.msg}</p>
            {err.needLogin ? (
              <Button
                variant="primary"
                onClick={() => {
                  location.href = `/?redirect=${encodeURIComponent(location.pathname)}`;
                }}
              >登录</Button>
            ) : (
              <a href={EVENT_PATH} style={{ fontSize: 13, color: 'var(--link)' }}>回活动页</a>
            )}
          </div>
        </div>
      </ToneProvider>
    );
  }
  if (!data) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-canvas)' }}>
        <EventKeyframes />
        <EventOrange />
        <div style={{
          width: 28, height: 28, borderRadius: 100,
          border: '2px solid var(--border)', borderTopColor: 'var(--tabby-orange)',
          animation: 'spin .8s linear infinite',
        }} />
      </div>
    );
  }

  const { items, criteria, locked, lockReason, otherJudges } = data;
  /* 锁着的两种情形按钮要说不同的话：路演还没到 / 已经锁定 */
  const notYet = locked && !phaseAtLeast(data.event.phase, 'demo');
  const current = items.find((i) => i.ideaId === sel) ?? items[0] ?? null;
  const doneN = items.filter((i) => i.mine?.submitted).length;

  /** 当前这件作品的分数：优先本地草稿，其次库里的，再其次全空。 */
  const readDraft = (it: EventJudgeItem): Draft =>
    drafts[it.ideaId] ?? {
      dims: it.mine?.dims ?? criteria.map(() => null),
      note: it.mine?.note ?? '',
    };

  const setDraft = (id: string, patch: Partial<Draft>) => {
    setDrafts((d) => ({
      ...d,
      [id]: { ...(d[id] ?? { dims: criteria.map(() => null), note: '' }), ...patch },
    }));
  };

  const save = async (it: EventJudgeItem, submit: boolean) => {
    const dr = readDraft(it);
    if (submit && dr.dims.some((x) => x == null)) {
      setToast({ msg: `${criteria.length} 项都打完才能提交`, tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      const r = await api.putScore(CURRENT_EVENT_SLUG, it.ideaId, {
        dims: dr.dims.map((x) => x ?? 0),
        note: dr.note || undefined,
        submit,
      });
      setToast({
        msg: submit ? `NO.${it.no} 已提交 · ${r.total} 分` : '草稿已存',
        tone: 'info',
      });
      /* 落库成功后丢掉本地草稿，让下一次渲染读服务端那份，避免两份真相 */
      setDrafts((d) => { const n = { ...d }; delete n[it.ideaId]; return n; });
      await load();
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : '没保存成功', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <header style={{
      position: 'sticky', top: 0, zIndex: 10,
      display: 'flex', alignItems: 'center', gap: 10,
      height: 56, padding: '0 16px',
      background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      <a href={EVENT_PATH} aria-label="回活动页" style={{
        display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'inherit',
      }}>
        <Mark size={24} />
        <strong style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-heading)' }}>
          1024 评委打分
        </strong>
      </a>
      <span style={{ flex: 1 }} />
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 12, color: 'var(--text-secondary)',
      }}>
        <EIcon name="lock" size={12} />
        只有你能看到自己的打分
      </span>
      <span className="mono" style={{
        fontSize: 13, fontWeight: 700, color: 'var(--text-heading)',
        background: 'var(--surface-2)', borderRadius: 100, padding: '3px 10px',
      }}>{doneN} / {items.length}</span>
    </header>
  );

  const lockBanner = locked && (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, margin: '0 16px',
      padding: '10px 14px', borderRadius: 12,
      background: 'var(--warning-subtle)', border: '1px solid rgba(237,195,55,.4)',
    }}>
      <EIcon name="lock" size={14} />
      {/*
        原因由服务端给：不能打分有两种情形（路演还没开始 / 已经锁了），
        前端自己编一句话就一定会在某一种下说错。
      */}
      <span style={{ fontSize: 12, color: 'var(--text-heading)' }}>
        {lockReason ?? '现在不能打分。'}
      </span>
    </div>
  );

  if (items.length === 0) {
    return (
      <ToneProvider tone="business">
        <GlobalKeyframes />
        {header}
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
          入围名单还没公布，暂时没有可打分的作品。
        </div>
      </ToneProvider>
    );
  }

  return (
    <ToneProvider tone="business">
      <GlobalKeyframes />
      <EventKeyframes />
      <EventOrange />
      <div style={{ minHeight: '100vh', background: 'var(--surface-canvas)' }}>
        {header}
        <div style={{ paddingTop: locked ? 14 : 0 }}>{lockBanner}</div>

        {wide ? (
          <div style={{
            display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20,
            maxWidth: 1180, margin: '0 auto', padding: 20, alignItems: 'start',
          }}>
            <aside style={{
              background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
              borderRadius: 16, padding: 8, position: 'sticky', top: 76,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 10px 10px',
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)' }}>路演顺序</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>已提交 {doneN}</span>
              </div>
              {items.map((it) => (
                <JudgeRow
                  key={it.ideaId}
                  it={it}
                  active={it.ideaId === current?.ideaId}
                  draft={drafts[it.ideaId]}
                  onPick={() => setSel(it.ideaId)}
                />
              ))}
              <p style={{
                margin: 0, padding: '10px', fontSize: 11, lineHeight: 1.6,
                color: 'var(--text-tertiary)',
              }}>
                {doneN === items.length
                  ? '都打完了，锁定前还能改。'
                  : '其他评委看不到你的打分，你也看不到别人的。'}
              </p>
            </aside>

            {current && (
              <Detail
                it={current}
                criteria={criteria}
                draft={readDraft(current)}
                locked={locked}
                notYet={notYet}
                busy={busy}
                otherJudges={otherJudges}
                onChange={(p) => setDraft(current.ideaId, p)}
                onSave={(submit) => void save(current, submit)}
              />
            )}
          </div>
        ) : (
          <div style={{ maxWidth: 560, margin: '0 auto', padding: '14px 16px 32px' }}>
            <div style={{
              display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 12,
              scrollbarWidth: 'none',
            }}>
              {items.map((it) => {
                const on = it.ideaId === current?.ideaId;
                const st = it.mine?.submitted ? 'done' : drafts[it.ideaId] || it.mine ? 'draft' : 'none';
                return (
                  <button
                    key={it.ideaId}
                    type="button"
                    onClick={() => setSel(it.ideaId)}
                    style={{
                      flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
                      height: 36, padding: '0 12px', borderRadius: 10, cursor: 'pointer',
                      background: on ? 'var(--dark-bg)' : 'var(--surface-1)',
                      color: on ? '#fff' : 'var(--text-heading)',
                      border: `1px solid ${on ? 'var(--dark-bg)' : 'var(--border-subtle)'}`,
                      font: '700 13px/1 var(--font-mono)',
                    }}
                  >
                    <span style={{
                      width: 6, height: 6, borderRadius: 100,
                      background: st === 'done' ? 'var(--success)'
                        : st === 'draft' ? 'var(--tabby-orange)' : 'var(--border-hover)',
                    }} />
                    {it.no}
                  </button>
                );
              })}
            </div>
            {current && (
              <Detail
                it={current}
                criteria={criteria}
                draft={readDraft(current)}
                locked={locked}
                notYet={notYet}
                busy={busy}
                otherJudges={otherJudges}
                onChange={(p) => setDraft(current.ideaId, p)}
                onSave={(submit) => void save(current, submit)}
              />
            )}
          </div>
        )}
      </div>

      {toast && <Toast message={toast.msg} tone={toast.tone} onClose={() => setToast(null)} />}
    </ToneProvider>
  );
}

function JudgeRow({
  it, active, draft, onPick,
}: {
  it: EventJudgeItem; active: boolean; draft?: Draft; onPick: () => void;
}) {
  const submitted = it.mine?.submitted;
  const total = draft
    ? draft.dims.reduce<number>((n, x) => n + (x ?? 0), 0)
    : it.mine?.total ?? 0;
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
        padding: '10px 10px', borderRadius: 10, border: 'none', cursor: 'pointer',
        background: active ? 'var(--surface-2)' : 'transparent',
        font: 'inherit', color: 'inherit',
      }}
    >
      <span className="mono" style={{
        flex: 'none', fontSize: 12, fontWeight: 700, color: 'var(--text-tertiary)',
      }}>{it.no}</span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{
          fontSize: 13, fontWeight: 600, color: 'var(--text-heading)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{it.name}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{it.who}</span>
      </span>
      {/*
        三种状态照稿写明，不靠颜色区分：已提交给分数 + 「已提交」，
        打了没交只写「未提交」，没动过写「未打分」。光靠绿/橙两种颜色
        分辨「交没交」，色弱的人看不出来，而这一步不可逆。
      */}
      {submitted ? (
        <span style={{
          flex: 'none', display: 'flex', flexDirection: 'column',
          alignItems: 'flex-end', gap: 1,
        }}>
          <span className="mono" style={{
            fontSize: 13, fontWeight: 700, color: 'var(--success)',
          }}>{total}</span>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>已提交</span>
        </span>
      ) : draft || it.mine ? (
        <span style={{
          flex: 'none', fontSize: 11, color: 'var(--tabby-orange-hover)', fontWeight: 600,
        }}>未提交</span>
      ) : (
        <span style={{ flex: 'none', fontSize: 11, color: 'var(--text-tertiary)' }}>未打分</span>
      )}
    </button>
  );
}

function Detail({
  it, criteria, draft, locked, notYet, busy, otherJudges, onChange, onSave,
}: {
  it: EventJudgeItem;
  criteria: EventCriterion[];
  draft: Draft;
  locked: boolean;
  notYet: boolean;
  busy: boolean;
  otherJudges: number;
  onChange: (p: Partial<Draft>) => void;
  onSave: (submit: boolean) => void;
}) {
  const total = draft.dims.reduce<number>((n, x) => n + (x ?? 0), 0);
  const any = draft.dims.some((x) => x != null);
  const submitted = !!it.mine?.submitted;
  const maxTotal = criteria.reduce((n, c) => n + c.max, 0);

  return (
    <div style={{
      background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="mono" style={{
            fontSize: 12, fontWeight: 700, color: 'var(--tabby-orange-hover)',
          }}>NO.{it.no}</span>
          {it.kind && (
            <Badge tone="neutral">{it.kind === 'page' ? 'iSpace 页面' : '硬件'}</Badge>
          )}
          <span style={{ flex: 1 }} />
          {it.url && (
            <a
              href={it.url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 12, color: 'var(--link)', textDecoration: 'none',
              }}
            >
              打开作品<EIcon name="ext" size={13} />
            </a>
          )}
        </div>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: 'var(--text-heading)' }}>
          {it.name}
        </h2>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.who}</span>
        <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          {it.desc}
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {criteria.map((c, i) => {
          const v = draft.dims[i];
          return (
            <div key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>{c.key}</span>
                <span style={{ flex: 1, fontSize: 11, color: 'var(--text-tertiary)' }}>{c.desc}</span>
                <span className="mono" style={{
                  fontSize: 15, fontWeight: 700,
                  color: v == null ? 'var(--text-tertiary)' : 'var(--text-heading)',
                }}>{v == null ? '—' : v}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>/ {c.max}</span>
              </div>
              <input
                type="range"
                min={0}
                max={c.max}
                step={1}
                value={v ?? 0}
                disabled={locked}
                aria-label={`${c.key}，满分 ${c.max}`}
                onChange={(e) => {
                  const dims = draft.dims.slice();
                  dims[i] = Number(e.target.value);
                  onChange({ dims });
                }}
                style={{ width: '100%', accentColor: 'var(--tabby-orange)' }}
              />
            </div>
          );
        })}
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>
          评语<span style={{ fontWeight: 400, color: 'var(--text-tertiary)' }}>（选填，可能展示在获奖名单上）</span>
        </span>
        <textarea
          value={draft.note}
          disabled={locked}
          maxLength={300}
          onChange={(e) => onChange({ note: e.target.value })}
          placeholder="一句话说说它好在哪儿，或者哪儿还差点"
          style={{
            width: '100%', minHeight: 64, padding: '10px 12px', resize: 'vertical',
            background: locked ? 'var(--surface-2)' : 'var(--surface-1)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-8)',
            color: 'var(--text-primary)', boxSizing: 'border-box',
            font: 'var(--weight-regular) var(--text-base)/1.6 var(--font-sans)',
          }}
        />
      </label>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        paddingTop: 12, borderTop: '1px solid var(--border-subtle)',
      }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginRight: 4 }}>总分</span>
          <span className="mono" style={{
            fontSize: 28, fontWeight: 700, lineHeight: 1,
            color: any ? 'var(--text-heading)' : 'var(--text-tertiary)',
          }}>{any ? total : '—'}</span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>/ {maxTotal}</span>
        </span>
        <span style={{ flex: 1 }} />
        {!locked && (
          <Button variant="secondary" onClick={() => onSave(false)} disabled={busy || !any}>
            存草稿
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => onSave(true)}
          disabled={locked || busy}
        >
          {locked
            ? (notYet ? '路演时开放' : '已锁定')
            : submitted ? '更新打分' : '提交打分'}
        </Button>
      </div>

      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
        其他评委 {it.othersSubmitted} / {otherJudges} 已提交，你看不到他们的分数{locked ? '。' : '。锁定前可以改。'}
      </p>
    </div>
  );
}
