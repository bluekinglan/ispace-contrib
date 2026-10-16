import { useCallback, useEffect, useState } from 'react';
import { CURRENT_EVENT_SLUG, type EventScreeningItem, type EventScreeningResponse } from '@ispace/contracts';
import { Badge, Button, Toast } from '@ispace/ui';
import { api } from '../api';
import { EIcon } from './visual';
import { useWide } from './Judge';

/**
 * 初筛投票（评委页在 signup / screening 阶段的形态）。
 *
 * ┌─ 和打分页同一条规则：评委之间互相看不到 ──────────────────────────┐
 * │ 接口只返回**我自己**投了谁，不返回任何人的票数。看得到彼此的选择， │
 * │ 先投的人就会影响后投的人——而初筛要的恰恰是八个独立判断。得票汇总   │
 * │ 只在控制台给管理员看，用来定最终名单。                            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 票是开关：投过再点就是撤回。和人气奖那颗按钮一致，省得评委为了换一票
 * 先去找「取消」在哪。
 */
export function Screening() {
  const [data, setData] = useState<EventScreeningResponse | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'info' | 'error' } | null>(null);
  const wide = useWide();

  const load = useCallback(async () => {
    const r = await api.screeningBoard(CURRENT_EVENT_SLUG);
    setData(r);
    setSel((s) => s ?? r.items[0]?.ideaId ?? null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!data) return null;

  const { items, limit, used, open, closedReason } = data;
  const left = limit - used;
  const cur = items.find((i) => i.ideaId === sel) ?? items[0] ?? null;

  const toggle = async (it: EventScreeningItem) => {
    setBusy(true);
    try {
      const r = await api.screeningVote(CURRENT_EVENT_SLUG, it.ideaId);
      setToast({
        msg: r.voted ? `已投「${it.name}」，还有 ${r.remaining} 票` : `已撤回，还有 ${r.remaining} 票`,
        tone: 'info',
      });
      await load();
    } catch (e) {
      setToast({ msg: e instanceof Error ? e.message : '投票没成功', tone: 'error' });
    } finally { setBusy(false); }
  };

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
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-heading)' }}>初筛投票</span>
        <span style={{ flex: 1 }} />
        {open ? (
          <Badge tone={left > 0 ? 'brand' : 'success'} dot>
            {left > 0 ? `还有 ${left} 票` : `${limit} 票已投完`}
          </Badge>
        ) : (
          <Badge tone="neutral">暂不能投</Badge>
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
        display: wide ? 'grid' : 'block',
        gridTemplateColumns: wide ? '300px 1fr' : undefined,
        gap: wide ? 0 : undefined,
        alignItems: 'start',
      }}>
        {/* 左：创意清单 */}
        <div style={{
          borderRight: wide ? '1px solid var(--border-subtle)' : 'none',
          padding: 12, display: 'flex', flexDirection: 'column', gap: 4,
          ...(wide ? { position: 'sticky', top: 57, maxHeight: 'calc(100vh - 57px)', overflowY: 'auto' } : {}),
        }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            padding: '4px 8px 8px',
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)' }}>
              全部创意
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {items.length}
            </span>
          </div>
          {items.map((it) => (
            <button
              key={it.ideaId}
              type="button"
              onClick={() => setSel(it.ideaId)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                textAlign: 'left', padding: 10, borderRadius: 10, border: 'none',
                cursor: 'pointer', font: 'inherit', color: 'inherit',
                background: it.ideaId === cur?.ideaId ? 'var(--surface-2)' : 'transparent',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{
                  fontSize: 13, fontWeight: 600, color: 'var(--text-heading)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{it.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{it.who}</span>
              </span>
              {/* 投过的标出来，不然八票投到后面自己也记不清投了谁 */}
              {it.voted && (
                <span style={{ flex: 'none', display: 'flex', color: 'var(--success)' }}>
                  <EIcon name="check" size={15} />
                </span>
              )}
            </button>
          ))}
        </div>

        {/* 右：详情 + 投票 */}
        {cur && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
              <Button
                variant={cur.voted ? 'secondary' : 'primary'}
                disabled={busy || !open || cur.mine || (!cur.voted && left <= 0)}
                onClick={() => void toggle(cur)}
              >
                {cur.voted ? '撤回这一票' : '投它入围'}
              </Button>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {cur.mine
                  ? '这是你自己交的创意，不能投'
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

      {toast && <Toast message={toast.msg} tone={toast.tone} onClose={() => setToast(null)} />}
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
