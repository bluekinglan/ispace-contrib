import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { User } from '@ispace/contracts';
import { Icon, Mark, Wordmark, type IconName } from '@ispace/ui';
import { api, type PendingShare } from './api';
import { AppDownloadDialog } from './UserMenu';
import { EventSideCard } from './event/Banner';
import { initial, washOf } from './wall';

/**
 * 改版稿的外壳：左边一条侧栏，右边顶栏 + 一块滚动区（§侧栏）。
 *
 * ┌─ 为什么整站共用一个外壳 ──────────────────────────────────────────┐
 * │ 改版前的门户是「我的页面 / 创意市场」两个 tab 顶在页面上方；新稿把   │
 * │ 导航挪到左侧，探索、为你推荐、iDo、我的作品是四个平级的地方，侧栏  │
 * │ 在它们之间不重绘。所以外壳必须在路由之上，而不是每屏各画一条。      │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 「为你推荐」是唯一例外：它整屏深色、自带顶栏，所以 chrome=false 时只留
 * 侧栏，顶栏和滚动区都交给那一屏自己。
 */

export type NavKey = 'explore' | 'foryou' | 'create' | 'mine';

/**
 * 「iDo」跟 Wordmark 用同一副字样：同一个 --font-sans、同样 700、同样
 * -.02em 的字距。它和「探索」「我的作品」不是一类东西——那两个是地方的
 * 名字，iDo 是这个产品让你做事的那个入口，稿上也是按字标画的。
 *
 * 不直接复用 Wordmark 组件：它写死了文案 iSPACE 和 color: var(--text-heading)，
 * 而导航项选中与否要换色。这里只取它的字样。
 */
const BRAND_LABEL: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontWeight: 700,
  letterSpacing: '-.02em',
};

const NAV: { key: NavKey; label: string; icon: IconName; href: string }[] = [
  { key: 'explore', label: '探索', icon: 'compass', href: '/' },
  { key: 'foryou', label: '为你推荐', icon: 'sparkles', href: '/foryou' },
  { key: 'create', label: 'iDo', icon: 'pen', href: '/create' },
  { key: 'mine', label: '我的作品', icon: 'grid', href: '/mine' },
];

/** 侧栏收起的临界宽度。稿上 1100 以下默认收起，用户手动开合后听用户的。 */
const COLLAPSE_AT = 1100;

export interface PinnedApp {
  name: string;
  letter: string;
  href: string;
}

export function Shell({
  me, nav, q, onQ, pinned, shares, onShareDone, back, chrome = true,
  scrollKey, restoreScroll = false, children,
}: {
  me: User;
  /** 当前高亮哪一项。详情页与作者页都算在「探索」下（稿上如此）。 */
  nav: NavKey | null;
  q: string;
  onQ: (v: string) => void;
  pinned: PinnedApp[];
  shares: PendingShare[];
  onShareDone: () => void;
  /** 返回按钮。详情、作者页、以及正在生成的创建页才有。 */
  back?: () => void;
  chrome?: boolean;
  /** 当前是哪一屏（地址）。换了就把滚动交接一下，见 useScrollMemory。 */
  scrollKey?: string;
  /** 这一次是前进后退来的：回到那一屏离开时的位置，而不是顶上。 */
  restoreScroll?: boolean;
  children: ReactNode;
}) {
  const wide = useWide();
  const scroller = useScrollMemory(scrollKey, restoreScroll);

  return (
    <div
      style={{
        display: 'flex', height: '100vh', overflow: 'hidden',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', lineHeight: 1.5,
        color: 'var(--text-primary)', background: 'var(--surface-canvas)',
      }}
    >
      <Sidebar me={me} nav={nav} q={q} onQ={onQ} pinned={pinned} wide={wide} />
      <main style={{ flex: 1, minWidth: 0, height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/*
          顶栏可有可无，**容器这一层不能变**。

          原来 chrome=false 时是把 children 直接挂在 main 下面，和有顶栏时的
          树形不一样——于是在同一屏里把 chrome 从 true 切到 false（创建屏进
          工作台就是这样），React 认定这是两个位置，把里面的组件卸载重挂，
          刚输入的那句话、刚开的会话全没了。实测踩过。

          ⚠️ 这一层对「为你推荐」和「创建工作台」必须是 **flex 列**：那两屏
          的根元素用的是 `flex: 1`，父元素一换成 block 就当场失效，整屏塌成
          内容高度（实测 637px / 900px）。普通屏仍旧是 block + overflow auto，
          和改版前一模一样——滚动页改成 flex 列的话内容会被 flex-shrink 压扁。
        */}
        {chrome && <TopBar me={me} back={back} shares={shares} onShareDone={onShareDone} />}
        <div
          ref={scroller}
          style={{
            flex: 1,
            minHeight: 0,
            ...(chrome
              ? { overflow: 'auto' as const }
              : {
                display: 'flex' as const,
                flexDirection: 'column' as const,
                overflow: 'hidden' as const,
              }),
          }}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * 侧栏该不该展开。
 *
 * null 表示「用户还没表态」，此时按视口宽度决定；用户点过收起/展开之后，
 * 不管窗口怎么变都听用户的——自动收起一个人刚手动展开的侧栏，是在和他
 * 抢方向盘。存 sessionStorage 而不是 localStorage：换一次会话重新按视口
 * 判断，免得有人在小屏上收起过一次，换了显示器还是 72px。
 */
function useWide(): { on: boolean; toggle: () => void } {
  const [manual, setManual] = useState<boolean | null>(() => {
    try {
      const v = sessionStorage.getItem('ispace-side');
      return v === null ? null : v === '1';
    } catch { return null; }
  });
  const [vw, setVw] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const on = manual === null ? vw >= COLLAPSE_AT : manual;
  return {
    on,
    toggle: () => {
      setManual(!on);
      try { sessionStorage.setItem('ispace-side', on ? '0' : '1'); } catch { /* 隐身窗口里写不进，无妨 */ }
    },
  };
}

function Sidebar({
  me, nav, q, onQ, pinned, wide,
}: {
  me: User;
  nav: NavKey | null;
  q: string;
  onQ: (v: string) => void;
  pinned: PinnedApp[];
  wide: { on: boolean; toggle: () => void };
}) {
  return (
    <aside
      style={{
        flex: 'none', width: wide.on ? 248 : 72, height: '100vh', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column',
        background: 'var(--surface-sidebar)', borderRight: '1px solid var(--border-tabby)',
        transition: 'width .2s var(--ease-standard)', overflowX: 'hidden', overflowY: 'auto',
      }}
    >
      <div
        style={{
          height: 64, flex: 'none', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 8, padding: '0 12px 0 23px',
        }}
      >
        <a
          href="/"
          style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', minWidth: 0, textDecoration: 'none' }}
        >
          <Mark size={26} />
          {wide.on && <Wordmark size={24} />}
        </a>
        {wide.on && (
          <IconBtn title="收起侧栏" onClick={wide.toggle} size={32} icon="panel" iconSize={18} />
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 12px 0' }}>
        {wide.on ? (
          <label
            style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 14px',
              borderRadius: 'var(--radius-pill)', background: 'var(--seg-bg)',
              color: 'var(--text-tertiary)', cursor: 'text',
            }}
          >
            <Icon name="search" size={16} />
            <input
              value={q}
              onChange={(e) => onQ(e.target.value)}
              placeholder="搜索页面和同事"
              style={{
                flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
                fontSize: 'var(--text-base)', color: 'var(--text-primary)', fontFamily: 'inherit',
              }}
            />
          </label>
        ) : (
          <button
            onClick={wide.toggle}
            title="展开侧栏"
            style={{
              width: 48, height: 40, border: 0, borderRadius: 12, background: 'transparent',
              color: 'var(--text-secondary)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="panel" size={19} />
          </button>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map((n) => (
            <NavRow
              key={n.key}
              href={n.href} label={n.label} icon={n.icon} iconSize={19}
              on={nav === n.key} wide={wide.on} height={42}
              /* iDo 是个名字，不是一句说明——跟字标同一副字样 */
              labelStyle={n.key === 'create' ? BRAND_LABEL : undefined}
            />
          ))}
        </div>
      </div>

      {/* 去掉「一句话做页面」那颗 CTA 之后，这里只剩常用列表，不必再包一层 fragment */}
      {wide.on && pinned.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '24px 12px 0' }}>
          <span
            style={{
              padding: '0 14px 6px', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-label)',
              color: 'var(--text-tertiary)',
            }}
          >
            常用
          </span>
          {pinned.map((p) => (
            <a
              key={p.href}
              href={p.href}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 36,
                padding: '0 14px', borderRadius: 10, background: 'transparent',
                color: 'var(--text-secondary)', fontSize: 'var(--text-md)',
                cursor: 'pointer', textDecoration: 'none',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-sidebar-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span
                style={{
                  width: 20, height: 20, flex: 'none', borderRadius: 6, background: washOf(p.href),
                  color: 'var(--text-heading)', fontSize: 'var(--text-base)',
                  fontWeight: 'var(--weight-bold)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {p.letter}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
            </a>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 12 }} />

      {wide.on && <EventSideCard />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 12px 8px' }}>
        <NavRow href="/console" label="控制台" icon="sliders" iconSize={17} on={false} wide={wide.on} height={36} />
        <NavRow href="/console#guide" label="接入 AI" icon="plug" iconSize={17} on={false} wide={wide.on} height={36} />
      </div>

      <div
        style={{
          padding: '10px 12px 14px', borderTop: '1px solid var(--border-tabby)',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <a
          href={`/${me.username}`}
          title="我的主页"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
            padding: '6px 8px', borderRadius: 12, background: 'transparent',
            cursor: 'pointer', textDecoration: 'none',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span
            style={{
              width: 32, height: 32, flex: 'none', borderRadius: 'var(--radius-pill)',
              background: me.avatarUrl ? 'transparent' : 'var(--brand-wash)',
              color: 'var(--text-heading)', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-bold)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', overflow: 'hidden',
            }}
          >
            {me.avatarUrl
              ? <img src={me.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : initial(me.displayName)}
          </span>
          {wide.on && (
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span
                style={{
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
                  color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {me.displayName}
              </span>
              <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
                /{me.username}
              </span>
            </span>
          )}
        </a>
        {wide.on && (
          <IconBtn
            title="退出登录"
            icon="logout"
            size={34}
            iconSize={17}
            onClick={() => { void api.logout().then(() => location.reload()); }}
          />
        )}
      </div>
    </aside>
  );
}

/**
 * 每一屏各记各的滚动位置。
 *
 * 页面在这个容器里滚，不在 window 上滚，所以浏览器自带的滚动恢复管不到它：
 * 原来整页刷新时每次都从顶上开始，改成页面内切换之后反过来——从探索墙
 * 往下翻到一半点进详情，新的一屏会接着停在"一半"的位置。
 *
 * 新开一屏回到顶上；前进后退回到离开时的位置（探索墙翻到哪、回来还在哪）。
 * 用 layout effect：在浏览器画出来之前就挪好，不会先闪一下旧位置。
 */
function useScrollMemory(key: string | undefined, restore: boolean) {
  const el = useRef<HTMLDivElement | null>(null);
  const saved = useRef(new Map<string, number>());
  const cur = useRef(key);

  /*
    边滚边记，而不是换屏那一刻再读：到换屏的时候新的一屏已经渲染上去了，
    内容一变短，浏览器会把 scrollTop 夹到新的最大值，读到的就不是原来的位置。
  */
  useEffect(() => {
    const box = el.current;
    if (!box) return;
    const onScroll = () => { if (cur.current !== undefined) saved.current.set(cur.current, box.scrollTop); };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const box = el.current;
    if (!box || key === undefined || key === cur.current) return;
    cur.current = key;
    box.scrollTop = restore ? saved.current.get(key) ?? 0 : 0;
    /*
      新的一屏从七分淡入到全亮，0.16 秒。只动内容区的透明度，侧栏不动。

      试过浏览器自带的 View Transitions：它要先给旧画面拍快照，带着 iframe
      的屏（为你推荐、工作台）拍一次要两三百毫秒，有一次新画面等了将近一秒
      才出来，期间整屏冻住、点什么都没反应——比原来的闪更糟。这个淡入不拍
      快照、不挡点击，最多就是没效果。
    */
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      box.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    }
  }, [key, restore]);
  return el;
}

function NavRow({
  href, label, icon, iconSize, on, wide, height, labelStyle,
}: {
  href: string;
  label: string;
  icon: IconName;
  iconSize: number;
  on: boolean;
  wide: boolean;
  height: number;
  /** 个别项要自己的字样（iDo 跟字标走）。不给就用这一行默认的。 */
  labelStyle?: CSSProperties;
}) {
  return (
    <a
      href={href}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', height,
        padding: '0 14px', borderRadius: height > 38 ? 12 : 10,
        /*
          选中态走全站通用的那一对（--sel / --sel-fg），不再自带一套。
          侧栏原先用的是另一对更浅的 --nav-on-*，于是同一个"当前选中"
          在侧栏是浅橙底深橙字、在探索页的分类标签上是实心橙底白字——
          同一件事两种长相，而 tokens.css 开头写的是"橙色承担号召性按钮
          （--cta）和当前选中（--sel），仅此两类"。统一到 --sel。
        */
        background: on ? 'var(--sel)' : 'transparent',
        color: on ? 'var(--sel-fg)' : 'var(--text-secondary)',
        fontSize: 'var(--text-md)',
        fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
        cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap', textDecoration: 'none',
      }}
      onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--surface-sidebar-hover)'; }}
      onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
    >
      <Icon name={icon} size={iconSize} />
      {wide && <span style={labelStyle}>{label}</span>}
    </a>
  );
}

function IconBtn({
  title, icon, onClick, size, iconSize,
}: {
  title: string;
  icon: IconName;
  onClick: () => void;
  size: number;
  iconSize: number;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: size, height: size, flex: 'none', border: 0, borderRadius: 10,
        background: 'transparent', color: 'var(--text-tertiary)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-sidebar-hover)';
        e.currentTarget.style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--text-tertiary)';
      }}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
}

// ── 顶栏 ────────────────────────────────────────────────────────────────
function TopBar({
  me, back, shares, onShareDone,
}: {
  me: User;
  back?: () => void;
  shares: PendingShare[];
  onShareDone: () => void;
}) {
  const [notif, setNotif] = useState(false);
  const [apk, setApk] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  /* 点别处关掉通知面板。Esc 也关——它遮着下面的卡片。 */
  useEffect(() => {
    if (!notif) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setNotif(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNotif(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [notif]);

  return (
    <div style={{ height: 64, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px 0 20px' }}>
      {back && (
        <button
          onClick={back}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 12px 0 10px',
            border: 0, borderRadius: 10, background: 'transparent', color: 'var(--text-secondary)',
            fontSize: 'var(--text-base)', fontWeight: 'var(--weight-medium)', cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--surface-2)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <Icon name="left" size={17} />返回
        </button>
      )}
      <div style={{ flex: 1 }} />

      <div style={{ position: 'relative' }} ref={box}>
        <button
          onClick={() => setNotif((v) => !v)}
          title="通知"
          style={{
            position: 'relative', width: 38, height: 38, border: 0,
            borderRadius: 'var(--radius-pill)', background: 'transparent',
            color: 'var(--text-secondary)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <Icon name="bell" size={19} />
          {shares.length > 0 && (
            <span
              style={{
                position: 'absolute', top: 8, right: 9, width: 8, height: 8,
                borderRadius: 'var(--radius-pill)', background: 'var(--tabby-orange)',
                boxShadow: '0 0 0 2px var(--surface-canvas)',
              }}
            />
          )}
        </button>
        {notif && <Notifications shares={shares} onDone={() => { setNotif(false); onShareDone(); }} />}
      </div>

      <button
        onClick={() => setApk(true)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 15px 0 13px',
          border: 0, borderRadius: 11, background: 'var(--accent)', color: 'var(--accent-fg)',
          fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
          cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        <Icon name="phone" size={16} />下载 App
      </button>
      {apk && <AppDownloadDialog onClose={() => setApk(false)} />}
      {/* me 只是让顶栏知道该把「我的空间」指向谁；头像在侧栏底部，不重复摆一个 */}
      <span hidden>{me.username}</span>
    </div>
  );
}

/**
 * 通知面板。目前只有一类：同事把页面分享给了我，等我接受。
 *
 * 设计稿把它画成一张卡 + 接受/拒绝两颗按钮，接受后出现在「我的作品 ·
 * 同事分享」里。没有待处理的就写「没有新通知」——面板里一片空白会让人
 * 以为它没加载出来。
 */
function Notifications({ shares, onDone }: { shares: PendingShare[]; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const respond = async (id: string, accept: boolean) => {
    setBusy(id);
    try {
      await api.respondShare(id, accept);
      onDone();
    } finally { setBusy(null); }
  };

  return (
    <div
      style={{
        position: 'absolute', top: 46, right: 0, width: 340, zIndex: 40, padding: 8,
        boxSizing: 'border-box', borderRadius: 16, background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        boxShadow: '0 16px 40px -12px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.04)',
      }}
    >
      <div
        style={{
          padding: '8px 10px 4px', fontSize: 'var(--text-base)',
          fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-label)',
          color: 'var(--text-tertiary)',
        }}
      >
        通知
      </div>
      {shares.length === 0 ? (
        <div style={{ padding: '14px 10px 16px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          没有新通知
        </div>
      ) : shares.map((s) => (
        <div key={s.id} style={{ display: 'flex', gap: 12, padding: 10 }}>
          <span
            style={{
              width: 34, height: 34, flex: 'none', borderRadius: 'var(--radius-pill)',
              background: s.fromUser.avatarUrl ? 'transparent' : washOf(s.fromUser.username),
              color: 'var(--text-heading)', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-bold)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', overflow: 'hidden',
            }}
          >
            {s.fromUser.avatarUrl
              ? <img src={s.fromUser.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : initial(s.fromUser.displayName)}
          </span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-primary)' }}>
              <b>{s.fromUser.displayName}</b> 分享给你「{s.app.name}」。接受后它会出现在「我的作品 · 同事分享」里。
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                disabled={busy === s.id}
                onClick={() => void respond(s.id, true)}
                style={{
                  height: 32, padding: '0 14px', border: 0, borderRadius: 9,
                  background: 'var(--accent)', color: 'var(--accent-fg)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                接受
              </button>
              <button
                disabled={busy === s.id}
                onClick={() => void respond(s.id, false)}
                style={{
                  height: 32, padding: '0 12px', border: 0, borderRadius: 9,
                  background: 'transparent', color: 'var(--text-secondary)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                拒绝
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
