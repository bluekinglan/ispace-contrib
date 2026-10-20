import { useEffect, useState } from 'react';
import { copyText, fmtBytes, fmtDate, useCopy } from '@ispace/ui';
import type { Release } from '@ispace/contracts';
import { api, type Me } from '../api';

/**
 * 控制台 · 空间总览（改版稿 §控制台 · 空间总览）。
 *
 * 改版前这一屏是几张卡片摞起来；新稿把卡片全撤了：一个衬线大标题、一行
 * 地址、一排用横线分隔的数字、下面两栏。数据一个没变，变的是别再用边框
 * 把每样东西围起来——这一屏是读的，不是点的。
 *
 * 「配额与用量」那一屏并进了这排数字（稿上就这么画的），所以这里的 KPI
 * 比原来多两项：空间占用和数据行数都带进度条。
 */
export function SpaceOverview({ me }: { me: Me }) {
  const c = useCopy();
  const [apps, setApps] = useState(0);
  const [recent, setRecent] = useState<(Release & { appName: string })[]>([]);
  const [monthly, setMonthly] = useState<{ count: number; delta: number } | null>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const spacePath = `${location.host}/${me.user.username}`;

  useEffect(() => {
    void api.overview()
      .then((r) => setMonthly({ count: r.publishedThisMonth, delta: r.deltaVsLastMonth }))
      .catch(() => setMonthly(null));
  }, []);

  useEffect(() => {
    void (async () => {
      const a = await api.apps();
      setApps(a.apps.length);
      // 最近发布：取每个应用的最新版本再按时间排。应用数不多，
      // 逐个查比加一个聚合端点更简单，且这一屏本就不是热路径。
      const lists = await Promise.all(
        a.apps.slice(0, 8).map(async (app) => {
          const r = await api.releases(app.slug).catch(() => ({ releases: [] as Release[] }));
          return r.releases.slice(0, 2).map((x) => ({ ...x, appName: app.name }));
        }),
      );
      setRecent(
        lists.flat()
          .sort((x, y) => (x.publishedAt > y.publishedAt ? -1 : 1))
          .slice(0, 6),
      );
    })();
  }, []);

  const q = me.quota;
  const pct = (used: number, limit: number) => (limit > 0 ? `${Math.min(100, Math.round((used / limit) * 100))}%` : '0%');

  const kpis: { k: string; v: string; u: string; bar: boolean; pct: string }[] = [
    { k: '已发布页面', v: String(apps), u: '', bar: false, pct: '0%' },
    {
      k: '本月发布',
      v: monthly ? String(monthly.count) : '—',
      /* 环比是「与上月同期」之差；差为 0 不显示，「+0」是噪声 */
      u: monthly && monthly.delta !== 0 ? `比上月 ${monthly.delta > 0 ? '+' : ''}${monthly.delta}` : '',
      bar: false, pct: '0%',
    },
    {
      k: '后端应用', v: String(q.backendCountUsed), u: `/ ${q.backendCountLimit}`,
      bar: true, pct: pct(q.backendCountUsed, q.backendCountLimit),
    },
    {
      k: '空间占用', v: fmtBytes(q.storageBytesUsed), u: `/ ${fmtBytes(q.storageBytesLimit)}`,
      bar: true, pct: pct(q.storageBytesUsed, q.storageBytesLimit),
    },
    {
      k: '数据行数', v: q.dbRowsUsed.toLocaleString('en-US'), u: `/ ${q.dbRowsLimit.toLocaleString('en-US')}`,
      bar: true, pct: pct(q.dbRowsUsed, q.dbRowsLimit),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-script)', fontSize: 30, lineHeight: 1, color: 'var(--text-secondary)' }}>
          Happy Working
        </span>
        <h1
          style={{
            margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 46,
            lineHeight: 1.15, color: 'var(--text-heading)',
          }}
        >
          {me.user.displayName}的空间
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <span className="mono" style={{ fontSize: 18, color: 'var(--text-heading)' }}>{spacePath}</span>
          <span
            style={{
              height: 24, padding: '0 10px', borderRadius: 'var(--radius-pill)',
              background: 'var(--success-subtle)', color: 'var(--text-heading)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--success)' }} />
            {c('space.provisioned')}
          </span>
          <div style={{ flex: 1 }} />
          <OutlineBtn
            onClick={() => {
              /* 不用 alert：它会阻塞线程，而这条路径正是浏览器不给用剪贴板时才走到的 */
              void copyText(`${location.protocol}//${spacePath}`).then((done) => {
                setCopied(done ? 'ok' : 'fail');
                setTimeout(() => setCopied(null), done ? 1600 : 2600);
              });
            }}
          >
            {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制不了，手动选中' : '复制地址'}
          </OutlineBtn>
          <OutlineBtn href={`/${me.user.username}/`}>访问空间</OutlineBtn>
        </div>
        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          你的页面都挂在这个地址下，按路径区分，比如{' '}
          <span className="mono">/{me.user.username}/zhoubao/</span>
        </span>
      </div>

      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          borderTop: '1px solid var(--border-tabby)', borderBottom: '1px solid var(--border-tabby)',
        }}
      >
        {kpis.map((k) => (
          <div key={k.k} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '22px 24px 22px 0' }}>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{k.k}</span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <span
                className="mono"
                style={{ fontSize: 32, fontWeight: 500, letterSpacing: '-.02em', color: 'var(--text-heading)' }}
              >
                {k.v}
              </span>
              {k.u && <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{k.u}</span>}
            </span>
            {k.bar && (
              <div style={{ height: 4, borderRadius: 'var(--radius-pill)', background: 'var(--surface-3)', overflow: 'hidden' }}>
                <div style={{ width: k.pct, height: '100%', borderRadius: 'var(--radius-pill)', background: 'var(--text-primary)' }} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 48 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 12 }}>
            <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
              最近发布
            </span>
            <a href="#/audit" style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>全部记录 →</a>
          </div>
          {recent.length === 0 ? (
            <span style={{ padding: '12px 0', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', borderTop: '1px solid var(--border-tabby)' }}>
              还没有发布记录。
            </span>
          ) : recent.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'grid', gridTemplateColumns: '52px minmax(0,1fr) auto', alignItems: 'center',
                gap: 12, padding: '12px 0', borderTop: '1px solid var(--border-tabby)',
                fontSize: 'var(--text-base)',
              }}
            >
              <span
                className="mono"
                style={{
                  justifySelf: 'start', height: 22, padding: '0 8px', borderRadius: 6,
                  background: 'var(--surface-2)', color: 'var(--text-heading)',
                  fontSize: 'var(--text-base)', display: 'flex', alignItems: 'center',
                }}
              >
                v{r.version}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                {r.appName}
                <span style={{ color: 'var(--text-tertiary)' }}> · {c(`source.${r.source}` as 'source.mcp')}</span>
              </span>
              <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                {fmtDate(r.publishedAt)}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
            一句话发布
          </span>
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 10, padding: '22px 24px',
              borderRadius: 20, background: 'var(--dark-bg)', fontSize: 'var(--text-base)', lineHeight: 1.7,
            }}
          >
            <span style={{ color: 'rgba(255,255,255,.45)' }}>你 →</span>
            <span style={{ color: '#fff' }}>把这个项目发到我的空间，路径 /zhoubao</span>
            <span style={{ paddingTop: 4, color: 'rgba(255,255,255,.45)' }}>Claude →</span>
            <span className="mono" style={{ color: 'rgba(255,255,255,.85)' }}>
              <span style={{ color: 'var(--tabby-orange)' }}>ai-deploy.deploy</span>
              {' { site: "zhoubao", zip: "dist.zip" }'}
            </span>
          </div>
          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            发布前会自动扫一遍密钥，命中就拦下来，不会发出去。
          </span>
        </div>
      </div>
    </div>
  );
}

/** 稿上这一排是描边按钮，不是实心的——它们是「顺手用一下」，不是主操作。 */
function OutlineBtn({
  children, onClick, href,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
}) {
  const style: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', height: 36, padding: '0 14px',
    border: '1px solid var(--border-hover)', borderRadius: 10, background: 'var(--surface-1)',
    color: 'var(--text-heading)', fontSize: 'var(--text-base)',
    fontWeight: 'var(--weight-semibold)', cursor: 'pointer', textDecoration: 'none',
    whiteSpace: 'nowrap',
  };
  return href
    ? <a href={href} style={style}>{children}</a>
    : <button onClick={onClick} style={style}>{children}</button>;
}
