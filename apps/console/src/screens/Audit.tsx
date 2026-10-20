import { useEffect, useState } from 'react';
import { fmtDate, useCopy } from '@ispace/ui';
import { api, type AuditEntry } from '../api';

/**
 * 控制台 · 发布记录（改版稿 §控制台 · 发布记录）。
 *
 * 改版前是一张六列的表格；新稿去掉了边框和表头底色，只留一行列名和一条条
 * 分隔线，并把「被阻断」单独做成一个筛选——这一屏的价值就在那几条上，
 * 其余的成功记录是背景。
 *
 * 被阻断的那一行可以展开，里面写清楚是哪一条规则、以及下一步该怎么办。
 * 稿上那段带行号的代码片段这里**不画**：审计表里存的是规则名和位置
 * （metadata.findings），不存命中的那几行源码——把用户的代码抄进审计表，
 * 等于把密钥又存了一份。
 */
export function AuditScreen() {
  const c = useCopy();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [blocked, setBlocked] = useState(0);
  const [only, setOnly] = useState<'all' | 'blocked'>('all');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void api.audit(100).then((r) => { setLogs(r.logs); setBlocked(r.blockedCount); });
  }, []);

  const rows = logs.filter((l) => only === 'all' || l.result === 'blocked');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1 style={{
            margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 40,
            lineHeight: 1.15, color: 'var(--text-heading)',
          }}>
            发布记录
          </h1>
          <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)' }}>
            谁、何时、从哪个入口、结果。「被阻断」是密钥扫描拦下来的。{c('audit.retention')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 12, background: 'var(--seg-bg)' }}>
          {([['all', '全部'], ['blocked', `被阻断 ${blocked}`]] as const).map(([k, label]) => {
            const on = only === k;
            return (
              <button
                key={k}
                onClick={() => setOnly(k)}
                style={{
                  height: 32, padding: '0 14px', border: 0, borderRadius: 9,
                  background: on ? 'var(--surface-1)' : 'transparent',
                  boxShadow: on ? '0 1px 2px rgba(24,23,21,.08)' : 'none',
                  color: on ? 'var(--text-heading)' : 'var(--text-tertiary)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--border-tabby)' }}>
        <div style={{ ...GRID, padding: '0 4px 10px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          <span>时间</span><span>对象</span><span>动作</span><span>入口</span><span>结果</span>
        </div>
        {rows.length === 0 ? (
          <span style={{ padding: '24px 4px', borderTop: '1px solid var(--border-tabby)', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            {only === 'blocked' ? '没有被阻断的发布。' : '还没有记录。'}
          </span>
        ) : rows.map((l) => {
          const why = blockedReason(l);
          const expandable = l.result === 'blocked' && !!why;
          const isOpen = open === l.id;
          return (
            <div key={l.id} style={{ borderTop: '1px solid var(--border-tabby)' }}>
              <div
                onClick={() => expandable && setOpen(isOpen ? null : l.id)}
                style={{
                  ...GRID, alignItems: 'center', padding: '14px 4px',
                  fontSize: 'var(--text-base)', cursor: expandable ? 'pointer' : 'default',
                }}
              >
                <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
                  {fmtDate(l.createdAt as unknown as string)}
                </span>
                <span style={{ color: 'var(--text-heading)', fontWeight: 'var(--weight-semibold)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {targetOf(l)}
                </span>
                <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
                  {l.action}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{c(`source.${l.source}` as 'source.mcp')}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-heading)' }}>
                  <span
                    style={{
                      width: 6, height: 6, borderRadius: 'var(--radius-pill)',
                      background: l.result === 'blocked' ? 'var(--danger)'
                        : l.result === 'failed' ? 'var(--warning)' : 'var(--success)',
                    }}
                  />
                  {l.result === 'blocked' ? '被阻断' : l.result === 'failed' ? '失败' : '成功'}
                </span>
              </div>
              {isOpen && why && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 4px 20px' }}>
                  <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
                    {why}，这次发布没有上线。
                  </span>
                  <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                    把这把密钥登记成外部接口，页面里改成请求{' '}
                    <span className="mono">/deploy/api/connect/…</span>，密钥就不会出现在代码里。
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '150px minmax(0,1.4fr) minmax(0,1fr) 110px 110px',
  gap: 14,
};

/** 这条记录动的是哪个东西。页面看 slug，用户看 username，都没有就只能说类型。 */
function targetOf(l: AuditEntry): string {
  const m = l.metadata as { slug?: string; username?: string; app?: string } | null;
  return m?.app ?? m?.slug ?? m?.username ?? l.targetType;
}

/**
 * 被阻断的原因。
 *
 * 发布链路写进 metadata.findings 的是规则名 + 文件 + 行号（见
 * services/deploy.ts），这里把第一条摊成一句人话。超过一条时说明还有几条
 * ——人只要知道"不止一处"，具体清单在 CLI 的输出里。
 */
function blockedReason(l: AuditEntry): string | null {
  if (l.result !== 'blocked') return null;
  const f = (l.metadata as { findings?: { rule?: string; file?: string; line?: number }[] } | null)?.findings;
  if (!f?.length) return '发布前检查没通过';
  const first = f[0]!;
  const where = first.file ? `${first.file}${first.line ? `:${first.line}` : ''}` : '产物里';
  const more = f.length > 1 ? `，另外还有 ${f.length - 1} 处` : '';
  return `${where} 命中了「${first.rule ?? '密钥扫描'}」${more}`;
}
