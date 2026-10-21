import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '@ispace/ui';
import { api, type Listing } from './api';

/**
 * 探索墙与作者页共用的一面卡片墙（改版稿 §探索）。
 *
 * 布局用 CSS 多列（columns）而不是 grid：设计稿里卡片高度随页面比例变化
 * （手机页面 9:16、网页 4:3），要的是错落的瀑布流。grid 做不到——它会把
 * 同一行拉成一样高，卡片下方留出一条条空白。
 */

// ── 底色 ────────────────────────────────────────────────────────────────
/**
 * 没有封面图时卡片的底色。
 *
 * 设计稿给每个页面手挑了一个 wash 色；真实数据里没有这个字段，所以按 id
 * 取哈希稳定地分一个——同一个页面每次进来颜色一样，一面墙上又不会连着
 * 三张同色。刻意不按分类分色：分类只有七个，"同类同色"会让一面墙看起来
 * 像分了组，而设计稿要的是随机的错落。
 */
const WASHES = ['o', 'y', 'p', 'g', 'b', 't', 'c', 's'] as const;

export function washOf(key: string | null | undefined): string {
  if (!key) return 'var(--wash-c)';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `var(--wash-${WASHES[Math.abs(h) % WASHES.length]})`;
}

/** 头像里的那个字。中文名取最后一个字（设计稿如此），英文名取首字母。 */
export function initial(name: string): string {
  const s = (name || '').trim();
  if (!s) return '·';
  return /[一-龥]/.test(s) ? s.slice(-1) : s.slice(0, 1).toUpperCase();
}

export const fmt = (n: number | string): string => Number(n || 0).toLocaleString('en-US');

/**
 * 页面是手机优先还是电脑优先。
 *
 * 设计稿里每个页面带一个 dev 字段，库里没有——但 apps.type 里的 'h5' 正是
 * 「手机上看的页面」（移动端壳 WebView 里打开的那种），其余 static /
 * static_backend 都是网页。拿它当 dev 用，比凭空加一个字段再要求作者填
 * 要准：类型是发布时就定下来的。
 */
export type Device = 'phone' | 'pc';
export const deviceOf = (type: string): Device => (type === 'h5' ? 'phone' : 'pc');
export const ratioOf = (type: string): string => (deviceOf(type) === 'phone' ? '9 / 16' : '4 / 3');

/**
 * 试玩地址：换一张令牌，拿它的 url 塞 iframe。
 *
 * ┌─ 为什么不能直接用 appHref ──────────────────────────────────────────┐
 * │ 预览 iframe 不给 allow-same-origin（给了等于没有沙箱），里面的文档  │
 * │ 是 opaque origin。浏览器把它自己发出的子资源请求当作**跨站**，而会话 │
 * │ cookie 是 SameSite=Lax —— 跨站不带。而 /{owner}/{slug}/ 下连 CSS 和 │
 * │ 图片都要鉴权，于是 HTML 进得来、它引用的一切都被挡在登录门外。       │
 * │ 线上实测就是一页裸 HTML：蓝色下划线链接、裂掉的图片。               │
 * │                                                                      │
 * │ 令牌放在路径里，相对路径的子资源天然继承它，一个 cookie 都不需要。   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 换令牌要一次往返，所以**没换到之前先不渲染 iframe**——返回 null，调用方
 * 摆封面或底色。空着也比先闪一下错误页好。
 */
export function usePlayUrl(l: Pick<Listing, 'owner_username' | 'slug' | 'status'> | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = l ? `${l.owner_username}/${l.slug}` : '';
  const status = l?.status ?? '';

  /*
    ⚠️ 依赖只能是 key 与 status 这两个**字符串**，不能有 l 这个对象。

    原来写的是 `[key, l]` 再加一个 `last.current === key` 的守卫。那套组合有
    一个必然的竞态：调用方几乎总会在这一次换令牌的往返里重渲染一次（列表
    到了、喜欢数变了、翻页动画跑完），`l` 是每次渲染新造的对象，于是 effect
    重跑 → 清理函数把 alive 置成 false → 而守卫又让它不再发第二次请求。
    结果那个已经成功的响应被丢掉，url 永远停在 null，调用方一直摆封面。

    线上表现就是"大部分作品的试玩框是空的"，而且时灵时不灵——取决于那一次
    重渲染有没有赶在响应之前。实测如此。

    依赖换成两个字符串之后，同一个作品不会重复换令牌（key 没变 effect 不
    重跑），换了作品才重新换——守卫也就不需要了。
  */
  useEffect(() => {
    if (!key || status === 'stopped') { setUrl(null); return; }
    let alive = true;
    setUrl(null);
    const [owner, slug] = key.split('/');
    void api.playOpen(owner!, slug!)
      .then((r) => { if (alive) setUrl(r.url); })
      .catch(() => { /* 换不到就不渲染，调用方退回封面 */ });
    return () => { alive = false; };
  }, [key, status]);

  return url;
}

export const appHref = (l: Pick<Listing, 'owner_username' | 'slug'>): string =>
  `/${l.owner_username}/${l.slug}/`;
export const detailHref = (l: Pick<Listing, 'owner_username' | 'slug'>): string =>
  `/app/${l.owner_username}/${l.slug}`;

// ── 封面 ────────────────────────────────────────────────────────────────
/**
 * 一张卡的封面。有封面图就铺满，没有就用底色加一行占位字。
 *
 * 占位字写「排班表 · 手机截图」这种话（设计稿的 image-slot placeholder），
 * 不是"暂无封面"——前者告诉人这张卡本该是什么，后者只说了一个缺失。
 */
export function Cover({
  src, label, tint, radius = 20, children, style,
}: {
  src: string | null;
  label: string;
  tint: string;
  radius?: number;
  children?: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: 'absolute', inset: 0, background: tint, color: 'var(--cover-ink)',
        borderRadius: radius, overflow: 'hidden', ...style,
      }}
    >
      {src ? (
        <img
          src={src} alt=""
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <span
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', padding: 16, textAlign: 'center',
            fontSize: 'var(--text-base)', lineHeight: 1.6,
          }}
        >
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

// ── 一张卡 ──────────────────────────────────────────────────────────────
export function WallCard({
  item, onOpen, onPlay, onRemix, onAuthor, showDesc = false,
}: {
  item: Listing;
  onOpen: () => void;
  onPlay: () => void;
  onRemix: (() => void) | null;
  onAuthor: () => void;
  showDesc?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const badge = item.mine ? '你发布的' : (item.category?.includes('1024') ? '1024' : '');
  const label = `${item.name} · ${deviceOf(item.type) === 'phone' ? '手机截图' : '网页截图'}`;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ breakInside: 'avoid', paddingBottom: 30 }}
    >
      <div
        onClick={onOpen}
        style={{
          position: 'relative', aspectRatio: ratioOf(item.type), borderRadius: 20,
          cursor: 'pointer',
          transform: hover ? 'translateY(-3px)' : 'none',
          boxShadow: hover ? '0 24px 48px -24px rgba(0,0,0,.35)' : 'none',
          transition: 'transform .25s var(--ease-out-expo), box-shadow .25s',
        }}
      >
        <Cover src={item.cover_path} label={label} tint={washOf(item.app_id)}>
          {badge && (
            <span
              style={{
                position: 'absolute', top: 12, left: 12, height: 24, padding: '0 10px',
                borderRadius: 'var(--radius-pill)', background: 'var(--surface-1)',
                color: 'var(--text-heading)', fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-semibold)', display: 'flex', alignItems: 'center',
                pointerEvents: 'none',
              }}
            >
              {badge}
            </span>
          )}
          {hover && (
            <div style={{ position: 'absolute', left: 12, right: 12, bottom: 12, display: 'flex', gap: 8 }}>
              <CoverButton onClick={onPlay} tone="plain">
                <Icon name="play" size={13} filled />试玩
              </CoverButton>
              {/*
                「做同款」只在真有提示词的页面上出现。没有的不显示灰按钮——
                一个点不动的入口只会引出"为什么我这个不行"，而答案跟看的人
                一点关系都没有。
              */}
              {onRemix && (
                <CoverButton onClick={onRemix} tone="cta">
                  <Icon name="remix" size={15} />做同款
                </CoverButton>
              )}
            </div>
          )}
        </Cover>
      </div>

      <div
        onClick={onOpen}
        style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 10, padding: '14px 2px 6px', cursor: 'pointer',
        }}
      >
        <span
          style={{
            fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)',
            letterSpacing: '-.01em', color: 'var(--text-heading)',
          }}
        >
          {item.name}
        </span>
        <span
          className="num"
          style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
        >
          {fmt(item.install_count)} 人在用
        </span>
      </div>

      {showDesc && item.description && (
        <p
          style={{
            margin: '0 2px 10px', fontSize: 'var(--text-base)', lineHeight: 1.6,
            color: 'var(--text-secondary)', textWrap: 'pretty',
          }}
        >
          {item.description}
        </p>
      )}

      <AuthorChip
        name={item.owner_name} username={item.owner_username} onClick={onAuthor}
      />
    </div>
  );
}

function CoverButton({
  onClick, tone, children,
}: {
  onClick: () => void;
  tone: 'plain' | 'cta';
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        flex: 1, height: 38, border: 0, borderRadius: 11,
        background: tone === 'cta' ? 'var(--cta)' : 'var(--surface-1)',
        color: tone === 'cta' ? 'var(--cta-fg)' : 'var(--text-heading)',
        fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        cursor: 'pointer',
        boxShadow: tone === 'cta' ? '0 4px 14px rgba(0,0,0,.18)' : '0 4px 14px rgba(0,0,0,.14)',
      }}
    >
      {children}
    </button>
  );
}

/** 头像 + 名字，点进作者主页。卡片下方和详情页都用它。 */
export function AuthorChip({
  name, username, avatarUrl, onClick, size = 22,
}: {
  name: string;
  username: string;
  avatarUrl?: string | null;
  onClick: () => void;
  size?: number;
}) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`/${username}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: 'fit-content',
        padding: '0 2px', cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: size, height: size, flex: 'none', borderRadius: 'var(--radius-pill)',
          background: avatarUrl ? 'transparent' : washOf(username),
          color: 'var(--text-heading)', fontSize: 'var(--text-base)',
          fontWeight: 'var(--weight-bold)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', overflow: 'hidden',
        }}
      >
        {avatarUrl
          ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : initial(name)}
      </span>
      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{name}</span>
    </div>
  );
}

/** 整面墙。columns 的数值取自设计稿：4 列、最窄 240px、列间 24。 */
export function Wall({ children }: { children: React.ReactNode }) {
  return <div style={{ columns: '4 240px', columnGap: 24 }}>{children}</div>;
}
