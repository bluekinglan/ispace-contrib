import { useEffect, useState } from 'react';
import { exploreBucket, type Interest } from '@ispace/contracts';
import { Icon, copyText } from '@ispace/ui';
import { api, type Listing } from './api';
import { Segment } from './detail';
import { appHref, deviceOf, fmt, initial, washOf, type Device } from './wall';
import { Cover } from './wall';

/**
 * 为你推荐（改版稿 §为你推荐）。
 *
 * 整屏深色、一次只看一个页面、上下键翻——探索是「逛」，这一屏是「刷」。
 * 它是全站唯一一处自带顶栏的屏（外壳的 chrome=false），因为深色背景下
 * 再压一条浅色顶栏会把这一屏切成两半。
 *
 * 预览同详情页：装的是真页面，sandbox 不给 allow-same-origin（理由见
 * detail.tsx 那段方框注释）。
 */
export function ForYou({
  listings, interests, onDetail, onAuthor, onRemix, onToast, onInstalled, onLiked,
}: {
  listings: Listing[];
  interests: Interest[];
  onDetail: (l: Listing) => void;
  onAuthor: (username: string) => void;
  onRemix: (l: Listing) => void;
  onToast: (t: string) => void;
  onInstalled: () => void;
  onLiked: (appId: string, liked: boolean, count: number) => void;
}) {
  const ordered = rank(listings, interests);
  const [i, setI] = useState(0);
  const [dev, setDev] = useState<Device | null>(null);
  const wide = useInfoWide();

  const n = ordered.length;
  const cur = n ? ordered[((i % n) + n) % n]! : null;
  const move = (d: number) => { setI((v) => v + d); setDev(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!cur) {
    return (
      <div
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--dark-bg)', color: 'rgba(255,255,255,.7)', fontSize: 'var(--text-md)',
        }}
      >
        还没有可以推荐的页面。先去探索看看，或者自己做一个。
      </div>
    );
  }

  const d = dev ?? deviceOf(cur.type);
  const tint = washOf(cur.app_id);

  const toggleLike = async () => {
    try {
      const r = cur.liked ? await api.unlike(cur.app_id) : await api.like(cur.app_id);
      onLiked(cur.app_id, r.liked, r.likeCount);
    } catch { onToast('没点上，重试一下'); }
  };
  const toggleAdd = async () => {
    try {
      if (cur.mine) { onToast('这是你自己的页面'); return; }
      if (cur.installed) {
        await api.uninstallFromMarket(cur.app_id);
        onToast('已从「我的作品」移除');
      } else {
        await api.installFromMarket(cur.app_id);
        onToast('已添加到「我的作品」');
      }
      onInstalled();
    } catch { onToast('没成功，重试一下'); }
  };
  const share = async () => {
    const url = `${location.origin}${appHref(cur)}`;
    onToast(await copyText(url) ? '链接已复制，发给同事就能打开' : url);
  };

  const pad = (v: number) => (v < 10 ? `0${v}` : String(v));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dark-bg)', color: '#fff' }}>
      <div
        style={{
          height: 64, flex: 'none', display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)',
          alignItems: 'center', gap: 16, padding: '0 24px',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)' }}>为你推荐</span>
          <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'rgba(255,255,255,.45)' }}>
            {pad((((i % n) + n) % n) + 1)} / {pad(n)}
          </span>
        </span>
        <Segment
          dark
          options={[
            { k: 'phone', label: '手机', icon: 'phone' },
            { k: 'pc', label: '电脑', icon: 'monitor' },
          ]}
          value={d}
          onPick={(k) => setDev(k as Device)}
        />
        <span style={{ justifySelf: 'end', fontSize: 'var(--text-base)', color: 'rgba(255,255,255,.45)' }}>
          ↑ ↓ 键切换
        </span>
      </div>

      <div
        style={{
          flex: 1, minHeight: 0, display: 'grid',
          /*
            三列必须左右对称，中间那块才真的在屏幕中间。

            稿上写的是 1fr / auto / 1fr：两侧等宽，中间由内容撑开，天然居中。
            照搬的问题是电脑版的框按 `54vw` 算宽，而 vw 里含着左边那条 248px
            的侧栏——1440 宽时两侧各只剩一百来像素，作品名被挤成一行两个字。

            曾经为此把右栏改成 auto（动作栏只要 46px），左栏吃掉剩下的全部。
            那确实治好了挤，但代价是两侧不再等宽：宽屏上中间那块整个被推到
            右边去（2000px 下尤其明显）。

            现在只分成「左栏 / 剩下的全部 / 动作栏」：左栏按内容封顶 340（稿上
            的值），右边那条动作栏本来就只要 46，中间 1fr 把余下的宽度全部吃掉。
            这样电脑版的框横向占满可用区，而不是在两侧各留一截空白。

            框也不再自己按 vw 算宽——vw 里含着那条 248px 的侧栏，那正是它早先
            算歪、整块被推到右边去的根子。
          */
          gridTemplateColumns: 'minmax(200px,340px) minmax(0,1fr) auto',
          gridTemplateRows: 'minmax(0,1fr)', alignItems: 'center', gap: 40, padding: '0 40px 32px',
        }}
      >
        <div
          style={{
            alignSelf: 'end', justifySelf: 'end', width: '100%', maxWidth: 340,
            display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 8,
          }}
        >
          {wide && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    height: 26, padding: '0 11px', borderRadius: 'var(--radius-pill)',
                    background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.8)',
                    fontSize: 'var(--text-base)', display: 'flex', alignItems: 'center',
                  }}
                >
                  {exploreBucket(cur.category)}
                </span>
              </div>
              <h2
                style={{
                  margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500,
                  /* 稿上是定死的 42。那是一张定宽画布，真实窗口窄下来时
                     左栏会跟着窄，42 的作品名就断成两行 */
                  fontSize: 'clamp(28px, 2.4vw, 42px)',
                  lineHeight: 1.1, color: '#fff',
                }}
              >
                {cur.name}
              </h2>
              {cur.description && (
                <p style={{ margin: 0, fontSize: 'var(--text-md)', lineHeight: 1.7, color: 'rgba(255,255,255,.7)', textWrap: 'pretty' }}>
                  {cur.description}
                </p>
              )}
              <span style={{ fontSize: 'var(--text-base)', color: 'rgba(255,255,255,.6)' }}>
                {cur.owner_name} · {fmt(cur.install_count)} 人在用
              </span>
              <button
                onClick={() => onDetail(cur)}
                style={{
                  alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, height: 40,
                  padding: '0 12px 0 16px', border: '1px solid rgba(255,255,255,.22)', borderRadius: 12,
                  background: 'transparent', color: '#fff', fontSize: 'var(--text-base)',
                  fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                看详情<Icon name="chevRight" size={15} />
              </button>
            </>
          )}
        </div>

        <div style={{ height: '100%', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {d === 'phone' ? (
            <div
              style={{
                /* 不封高：手机版要纵向占满内容区，宽度由 9/19.5 自己算出来 */
                height: '100%', aspectRatio: '9 / 19.5', boxSizing: 'border-box',
                padding: 9, borderRadius: 50, background: '#000',
                boxShadow: '0 0 0 1px rgba(255,255,255,.12), 0 50px 100px -30px rgba(0,0,0,.8)',
              }}
            >
              <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 41, overflow: 'hidden' }}>
                <Frame item={cur} tint={tint} />
              </div>
            </div>
          ) : (
            <div
              style={{
                width: '100%', borderRadius: 14, overflow: 'hidden',
                background: 'var(--dark-surface)',
                boxShadow: '0 0 0 1px rgba(255,255,255,.1), 0 50px 100px -30px rgba(0,0,0,.8)',
              }}
            >
              <div
                style={{
                  height: 38, display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px',
                  borderBottom: '1px solid rgba(255,255,255,.08)',
                }}
              >
                <div style={{ display: 'flex', gap: 6, width: 46 }}>
                  {[0, 1, 2].map((k) => (
                    <span key={k} style={{ width: 10, height: 10, borderRadius: 'var(--radius-pill)', background: 'rgba(255,255,255,.18)' }} />
                  ))}
                </div>
                <span
                  className="mono"
                  style={{
                    flex: 1, textAlign: 'center', fontSize: 'var(--text-base)',
                    color: 'rgba(255,255,255,.5)', whiteSpace: 'nowrap', overflow: 'hidden',
                  }}
                >
                  {location.host}{appHref(cur)}
                </span>
                <div style={{ width: 46 }} />
              </div>
              <div style={{ position: 'relative', aspectRatio: '16 / 10' }}>
                <Frame item={cur} tint={tint} />
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            alignSelf: 'end', justifySelf: 'start', display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 18, paddingBottom: 8,
          }}
        >
          <Round title="上一个" icon="chevUp" onClick={() => move(-1)} />
          <Round title="下一个" icon="chevDown" onClick={() => move(1)} />
          <div style={{ height: 10 }} />
          <button
            onClick={() => onAuthor(cur.owner_username)}
            title={cur.owner_name}
            style={{
              width: 46, height: 46, border: '2px solid rgba(255,255,255,.9)',
              borderRadius: 'var(--radius-pill)', background: washOf(cur.owner_username),
              color: 'var(--text-heading)', fontSize: 'var(--text-lg)',
              fontWeight: 'var(--weight-bold)', cursor: 'pointer',
            }}
          >
            {initial(cur.owner_name)}
          </button>
          <Rail
            icon="heart" filled={cur.liked} label={fmt(cur.like_count)} title="喜欢"
            color={cur.liked ? '#ee5c2a' : '#fff'} onClick={() => void toggleLike()}
          />
          <Rail
            icon={cur.mine ? 'grid' : cur.installed ? 'check' : 'plus'}
            label={cur.mine ? '我的' : cur.installed ? '已添加' : '添加'}
            title="添加到我的作品" color="#fff" onClick={() => void toggleAdd()}
          />
          <Rail icon="link" label="分享" title="复制链接" color="#fff" onClick={() => void share()} />
          {cur.source_prompt && (
            <Rail icon="remix" label="做同款" title="做同款" color="#fff" onClick={() => onRemix(cur)} />
          )}
        </div>
      </div>
    </div>
  );
}

function Frame({ item, tint }: { item: Listing; tint: string }) {
  if (item.status === 'stopped') {
    return <Cover src={item.cover_path} label={`${item.name} · 已停用`} tint={tint} radius={0} />;
  }
  return (
    <iframe
      src={appHref(item)}
      title={item.name}
      sandbox="allow-scripts allow-forms allow-popups"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: tint }}
    />
  );
}

function Round({ title, icon, onClick }: { title: string; icon: 'chevUp' | 'chevDown'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 44, height: 44, border: '1px solid rgba(255,255,255,.16)',
        borderRadius: 'var(--radius-pill)', background: 'transparent', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={20} />
    </button>
  );
}

function Rail({
  icon, label, title, color, filled, onClick,
}: {
  icon: 'heart' | 'plus' | 'check' | 'grid' | 'link' | 'remix';
  label: string;
  title: string;
  color: string;
  filled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
        padding: 0, border: 0, background: 'transparent', color: '#fff', cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 46, height: 46, borderRadius: 'var(--radius-pill)',
          background: 'rgba(255,255,255,.08)', color, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={20} filled={filled} />
      </span>
      <span style={{ fontSize: 'var(--text-base)', color: 'rgba(255,255,255,.72)' }}>{label}</span>
    </button>
  );
}

function useInfoWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= 1180);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 1180);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return wide;
}

/**
 * 排序：先看方向对不对，再看别人用得多不多。
 *
 * 「选方向」里勾的分类排在前面——这是这一屏叫「为你推荐」而不是「热门」
 * 的全部含义。没勾过方向（跳过了、或还没进过手机端）就退化成按热度排，
 * 而不是空着。
 *
 * 热度 = 喜欢×3 + 在用×2 + 访问/50。喜欢权重最高是因为它最便宜也最直接
 * ——点一下心只表示"我觉得好"，而访问量里混着很多"点进去看一眼就走"。
 */
export function rank(list: Listing[], interests: Interest[]): Listing[] {
  const want = new Set<string>(interests);
  const heat = (l: Listing) =>
    Number(l.like_count) * 3 + Number(l.install_count) * 2 + Number(l.visit_count) / 50;
  return [...list].sort((a, b) => {
    const pa = want.has(exploreBucket(a.category)) ? 1 : 0;
    const pb = want.has(exploreBucket(b.category)) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return heat(b) - heat(a);
  });
}
