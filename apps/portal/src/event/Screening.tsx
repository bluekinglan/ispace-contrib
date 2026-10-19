import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CURRENT_EVENT_SLUG,
  type EventScreeningItem, type EventScreeningRankRow, type EventScreeningResponse,
} from '@ispace/contracts';
import { Badge, Button, Toast } from '@ispace/ui';
import { api } from '../api';
import { EIcon } from './visual';
import { useWide } from './Judge';

/**
 * 初筛投票（评委页在 signup / screening 阶段的形态）。
 *
 * ┌─ 和打分页同一条规则：评委之间互相看不到 ──────────────────────────┐
 * │ 投票期间接口只返回**我自己**投了谁，不返回任何人的票数。看得到彼此 │
 * │ 的选择，先投的人就会影响后投的人——而初筛要的恰恰是八个独立判断。  │
 * │ 票数要到名单公布（20:30）之后才随 ranking 一起下发。               │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 票是实时写库的，不是攒在本地：评委在工位用电脑、去会议室用手机是常态，
 * 草稿放本地就意味着换个设备看不到自己投到哪了。两端看到的是同一份，按
 * 时间先后覆盖。
 *
 * 「交卷」是另一回事——投满 8 票点一下才算数，交了之后票锁住。为什么必须
 * 投满见服务端那条接口上的注释。
 */
export function Screening() {
  const [data, setData] = useState<EventScreeningResponse | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'mine'>('all');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'info' | 'error' } | null>(null);
  const wide = useWide();
  const detail = useRef<HTMLDivElement>(null);

  /*
    窄屏上详情排在整张清单下面，点一条不滚过去的话，屏幕上什么都没变——
    看着就是"点了没反应"。宽屏不滚：详情本来就在右边，滚动只会把顶栏
    和刚点的那一行一起推出视野。
  */
  const pick = (id: string) => {
    setSel(id);
    if (!wide) {
      requestAnimationFrame(() => {
        detail.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  };

  const load = useCallback(async () => {
    const r = await api.screeningBoard(CURRENT_EVENT_SLUG);
    setData(r);
    setSel((s) => s ?? r.items[0]?.ideaId ?? null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!data) return null;

  const {
    items, limit, slots, used, open, closedReason,
    submitted, submittedCount, judgeCount, resultsOpen, ranking,
  } = data;
  const left = limit - used;
  const shown = tab === 'mine' ? items.filter((i) => i.voted) : items;
  const cur = items.find((i) => i.ideaId === sel) ?? shown[0] ?? items[0] ?? null;
  /** 交卷之后票锁住，撤回交卷才能改。 */
  const canVote = open && !submitted;

  const say = (msg: string, tone: 'info' | 'error' = 'info') => setToast({ msg, tone });

  const toggle = async (it: EventScreeningItem) => {
    setBusy(true);
    try {
      const r = await api.screeningVote(CURRENT_EVENT_SLUG, it.ideaId);
      say(r.voted ? `已投「${it.name}」，还有 ${r.remaining} 票` : `已撤回，还有 ${r.remaining} 票`);
      await load();
    } catch (e) {
      say(e instanceof Error ? e.message : '投票没成功', 'error');
    } finally { setBusy(false); }
  };

  const flipSubmit = async () => {
    setBusy(true);
    try {
      if (submitted) {
        await api.unsubmitScreening(CURRENT_EVENT_SLUG);
        say('可以改了，改完记得再提交一次');
      } else {
        await api.submitScreening(CURRENT_EVENT_SLUG);
        say('已提交。名单公布后这一页会显示得票。');
      }
      await load();
    } catch (e) {
      say(e instanceof Error ? e.message : '操作没成功', 'error');
    } finally { setBusy(false); }
  };

  /* 八个格子，投一票亮一个。比「还剩 3 票」更快看出投到哪了 */
  const dots = (
    <div style={{ display: 'flex', gap: 4, flex: 'none' }} aria-hidden="true">
      {Array.from({ length: limit }, (_, i) => (
        <span key={i} style={{
          width: 12, height: 12, borderRadius: 4,
          background: i < used ? 'var(--tabby-orange)' : 'var(--surface-3)',
        }} />
      ))}
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-canvas)' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '12px 16px', background: 'var(--glass-bg)',
        backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <span className="mono" style={{ fontSize: 15, fontWeight: 800 }}>1024</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-heading)' }}>创意初筛</span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {items.length} 个创意 · 每人 {limit} 票 · 取前 {slots}
        </span>
        <span style={{ flex: 1 }} />
        {/* 窄屏把进度和交卷收到底部固定栏，顶栏只留状态 */}
        {wide && open && dots}
        {open ? (
          <Badge tone={submitted ? 'success' : left > 0 ? 'brand' : 'brand'} dot>
            {submitted ? `已提交 ${used} 票` : left > 0 ? `还剩 ${left} 票` : `${limit} 票已投完`}
          </Badge>
        ) : (
          <Badge tone="neutral">{resultsOpen ? '初筛已结束' : '暂不能投'}</Badge>
        )}
        {wide && open && (
          <Button
            variant={submitted ? 'secondary' : 'primary'}
            disabled={busy || (!submitted && left > 0)}
            onClick={() => void flipSubmit()}
          >
            {submitted ? '修改投票' : '提交'}
          </Button>
        )}
      </header>

      {/* 窗口没开时把原因说清楚——评委点进来看见一堆投不了的按钮会以为坏了 */}
      {!open && closedReason && (
        <p style={{
          margin: 0, padding: '10px 16px', background: 'var(--surface-2)',
          fontSize: 13, color: 'var(--text-secondary)',
        }}>{closedReason}</p>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 16px', background: 'var(--surface-2)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {([['all', `全部 ${items.length}`], ['mine', `已投 ${used}`]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              style={{
                border: 'none', borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
                font: 'inherit', fontSize: 12, fontWeight: 600,
                background: tab === k ? 'var(--text-heading)' : 'transparent',
                color: tab === k ? '#fff' : 'var(--text-secondary)',
              }}
            >{label}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {/*
          保密这件事常驻在界面上，不只写在代码注释里：评委会想「我投的别人
          看得到吗」，而这个疑问不解决，有人就会投得保守。
        */}
        <span style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, color: 'var(--text-tertiary)',
        }}>
          <EIcon name="lock" size={12} />
          {resultsOpen
            ? `${judgeCount} 位评委的票已公布`
            : `其他评委投了谁，公布前都看不到${judgeCount > 0 ? ` · 已交卷 ${submittedCount}/${judgeCount}` : ''}`}
        </span>
      </div>

      {resultsOpen && ranking && <Ranking rows={ranking} slots={slots} />}

      <div style={{
        display: wide ? 'grid' : 'block',
        gridTemplateColumns: wide ? '320px 1fr' : undefined,
        alignItems: 'start',
        /* 窄屏底部有固定栏，给内容留出避让空间 */
        paddingBottom: !wide && open ? 76 : 0,
      }}>
        {/* 左：创意清单 */}
        <div style={{
          borderRight: wide ? '1px solid var(--border-subtle)' : 'none',
          borderBottom: wide ? 'none' : '1px solid var(--border-subtle)',
          padding: 12, display: 'flex', flexDirection: 'column', gap: 4,
          ...(wide ? { position: 'sticky', top: 57, maxHeight: 'calc(100vh - 57px)', overflowY: 'auto' } : {}),
        }}>
          {shown.length === 0 && (
            <p style={{ margin: 0, padding: 12, fontSize: 13, color: 'var(--text-tertiary)' }}>
              还没投过。切回「全部」挑一个。
            </p>
          )}
          {shown.map((it) => (
            <button
              key={it.ideaId}
              type="button"
              onClick={() => pick(it.ideaId)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                textAlign: 'left', padding: 10, borderRadius: 10, cursor: 'pointer',
                font: 'inherit', color: 'inherit',
                background: it.voted ? 'var(--tabby-orange-subtle)' : 'transparent',
                border: `1.5px solid ${
                  it.ideaId === cur?.ideaId ? 'var(--text-heading)'
                    : it.voted ? 'var(--tabby-orange)' : 'transparent'
                }`,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{
                  fontSize: 13, fontWeight: 600, color: 'var(--text-heading)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{it.name}</span>
                <span style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{it.who} · {it.form}</span>
              </span>
              {/* 投过的标出来，不然八票投到后面自己也记不清投了谁 */}
              <span style={{
                width: 22, height: 22, flex: 'none', borderRadius: 7, boxSizing: 'border-box',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                background: it.voted ? 'var(--tabby-orange)' : 'transparent',
                border: `1.5px solid ${it.voted ? 'var(--tabby-orange)' : 'var(--border-hover)'}`,
              }}>
                {it.voted && <EIcon name="check" size={14} />}
              </span>
            </button>
          ))}
        </div>

        {/* 右：详情 + 投票。详情是判断的依据，列表里那两行摘要不够定夺。 */}
        {cur && (
          <div ref={detail} style={{
            padding: 16, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720,
            /* 滚过来时别贴着顶栏 */
            scrollMarginTop: 57,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-heading)' }}>
                {cur.name}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {cur.who} · {cur.form}
              </span>
            </div>

            <Section title="想解决什么问题">{cur.problem}</Section>
            <Section title="打算怎么做">{cur.plan}</Section>

            {cur.files.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)' }}>附件</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {cur.files.map((f) => (
                    <a key={f.url} href={f.url} target="_blank" rel="noreferrer" style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      border: '1px solid var(--border-subtle)', borderRadius: 8,
                      padding: '6px 10px', fontSize: 12, textDecoration: 'none',
                      color: 'var(--text-primary)',
                    }}>
                      <EIcon name="ext" size={13} />{f.name}
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4, flexWrap: 'wrap' }}>
              <Button
                variant={cur.voted ? 'secondary' : 'primary'}
                disabled={busy || !canVote || (!cur.voted && left <= 0)}
                onClick={() => void toggle(cur)}
              >
                {cur.voted ? '撤回这一票' : '投它入围'}
              </Button>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {submitted
                  ? '已提交。要改先点上面的「修改投票」。'
                  : !open
                    ? (closedReason ?? '现在不能投')
                    : cur.voted
                      ? '再点一次就撤回'
                      : left > 0
                        ? `还有 ${left} 票`
                        : '票投完了，想换就先撤回一票'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/*
        窄屏的底部固定栏。手机上顶栏已经被标题和状态占满，而进度和交卷是
        全程都要够得着的两样东西——放回顶栏就得横向挤，放在流里又会被滚走。
      */}
      {!wide && open && (
        <div style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 20,
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
          background: 'var(--surface-1)', borderTop: '1px solid var(--border-subtle)',
        }}>
          {dots}
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', whiteSpace: 'nowrap' }}>
            {submitted ? '已提交' : left > 0 ? `还剩 ${left} 票` : '投完了'}
          </span>
          <span style={{ flex: 1 }} />
          <Button
            variant={submitted ? 'secondary' : 'primary'}
            disabled={busy || (!submitted && left > 0)}
            onClick={() => void flipSubmit()}
          >
            {submitted ? '修改投票' : '提交'}
          </Button>
        </div>
      )}

      {toast && <Toast message={toast.msg} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}

/**
 * 得票榜。只在名单公布之后出现。
 *
 * 第 8 名同票时同票的全部入围、名额扩到 9 个；扩到 9 个还装不下才标「并列
 * 待定」，由组织者在控制台定。规则写在服务端 rankScreening 上。
 */
function Ranking({ rows, slots }: { rows: EventScreeningRankRow[]; slots: number }) {
  const max = Math.max(1, ...rows.map((r) => r.votes));
  const tie = rows.some((r) => r.status === 'tie');
  /* 入围的比名额多，说明第 8 名同票、扩了名额 */
  const extra = rows.filter((r) => r.status === 'in').length - slots;
  return (
    <div style={{
      margin: 16, padding: '16px 20px', borderRadius: 16,
      background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-heading)' }}>初筛结果</span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          得票前 {slots} 入围
          {tie ? ` · 第 ${slots} 名同票，扩名额也装不下，由组织者定`
            : extra > 0 ? ` · 第 ${slots} 名同票，增设 ${extra} 个名额`
            : ''}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => {
          const tone = r.status === 'in' ? 'var(--tabby-orange)'
            : r.status === 'tie' ? 'var(--warning)' : 'var(--surface-3)';
          return (
            <div key={r.ideaId} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 32 }}>
              <span className="mono" style={{
                width: 22, flex: 'none', fontSize: 12, fontWeight: 700,
                color: r.status === 'out' ? 'var(--text-tertiary)' : 'var(--text-heading)',
              }}>{r.rank}</span>
              <span style={{
                width: 150, flex: 'none', fontSize: 13, fontWeight: 600, color: 'var(--text-heading)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={`${r.name} · ${r.who}`}>{r.name}</span>
              <div style={{
                flex: 1, minWidth: 40, height: 8, borderRadius: 100,
                background: 'var(--surface-2)', overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: 100, background: tone,
                  width: `${Math.round((r.votes / max) * 100)}%`,
                }} />
              </div>
              <span className="mono" style={{
                width: 32, flex: 'none', textAlign: 'right',
                fontSize: 12, fontWeight: 700, color: 'var(--text-heading)',
              }}>{r.votes}</span>
              <span style={{
                width: 56, flex: 'none', fontSize: 11, fontWeight: 700,
                color: r.status === 'in' ? 'var(--tabby-orange-hover)'
                  : r.status === 'tie' ? 'var(--warning)' : 'var(--text-tertiary)',
              }}>
                {r.status === 'in' ? '入围' : r.status === 'tie' ? '并列待定' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)' }}>{title}</span>
      <p style={{
        margin: 0, fontSize: 14, lineHeight: 1.7, color: 'var(--text-primary)',
        whiteSpace: 'pre-wrap',
      }}>{children}</p>
    </div>
  );
}
