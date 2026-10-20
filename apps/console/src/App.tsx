import { useEffect, useState } from 'react';
import {
  Avatar, AvatarMenu, GlobalKeyframes, Icon, Mark, Tabs, ToneProvider, Wordmark,
  type IconName,
} from '@ispace/ui';
import type { Tone } from '@ispace/copy';
import { api, type Me } from './api';
import { SpaceOverview } from './screens/SpaceOverview';
import { MyPages } from './screens/MyPages';
import { Backends } from './screens/Backends';
import { SharedBackends } from './screens/SharedBackends';
import { Connectors } from './screens/Connectors';
import { DataSpace } from './screens/DataSpace';
import { MobileChannel } from './screens/MobileChannel';
import { QuotaScreen } from './screens/Quota';
import { AuditScreen } from './screens/Audit';
import { Guide } from './screens/Guide';
import { AdminOverviewScreen } from './screens/AdminOverview';
import { AdminUsers } from './screens/AdminUsers';
import { AdminTokens } from './screens/AdminTokens';
import { AdminConnectors } from './screens/AdminConnectors';
import { AdminSettings } from './screens/AdminSettings';
import { AdminResources } from './screens/AdminResources';
import { AdminAudit } from './screens/AdminAudit';
import { AdminInspection } from './screens/AdminInspection';
import { AdminApps } from './screens/AdminApps';
import { AdminEvent } from './screens/AdminEvent';

/**
 * 控制台（设计稿：员工 8 屏 + 管理员 5 屏）。
 *
 * 员工与管理员共用同一个入口 /console，由角色决定渲染哪套导航——
 * 设计稿的「员工视角 / 管理员」开关。非管理员看不到该开关。
 *
 * 路由用 hash 而非 History API：控制台是挂在 /console 下的 SPA，
 * hash 路由不需要服务端为每条子路径做兜底，也不会与平台的路径寻址
 * （/{user}/{app}/）产生歧义。
 */

/** 每屏配一个图标。图标名与 path 取自设计稿实测，见 packages/ui/src/icons.tsx。 */
type EmployeeScreen =
  | 'overview' | 'pages' | 'backends' | 'mobile' | 'audit' | 'guide';
type AdminScreen =
  | 'a-overview' | 'a-users' | 'a-tokens'
  | 'a-connectors' | 'a-apps'
  | 'a-resources' | 'a-settings' | 'a-audit' | 'a-inspection'
  | 'a-event';
type Screen = EmployeeScreen | AdminScreen;

const EMPLOYEE_NAV: { group: string; items: { key: EmployeeScreen; label: string; icon: IconName }[] }[] = [
  {
    /*
      改版稿的控制台只有五条：空间总览、页面与版本、后端与数据、发布记录、
      接入 AI。原来的九条里，「数据空间」「连接器」被并进了「后端与数据」
      （一个管数据存哪、一个管数据从哪来，稿上它们在同一屏），「配额与用量」
      并进了总览那排数字。
    */
    group: '控制台',
    items: [
      { key: 'overview', label: '空间总览', icon: 'home' },
      { key: 'pages', label: '页面与版本', icon: 'layers' },
      { key: 'backends', label: '后端与数据', icon: 'db' },
      { key: 'audit', label: '发布记录', icon: 'scroll' },
      { key: 'guide', label: '接入 AI', icon: 'plug' },
    ],
  },
  {
    /*
      稿上没有这一组。手机更新通道是真实存在的功能（APK 发版），不能因为
      新稿没画就没了入口——放在单独一组里，和日常五条分开。
    */
    group: '其他',
    items: [
      { key: 'mobile', label: '手机更新通道', icon: 'mobile' },
    ],
  },
];

const ADMIN_NAV: { group: string; items: { key: AdminScreen; label: string; icon: IconName }[] }[] = [
  {
    group: '平台',
    items: [
      { key: 'a-overview', label: '平台总览', icon: 'home' },
      { key: 'a-users', label: '员工与开通', icon: 'userPlus' },
      { key: 'a-tokens', label: '访问令牌', icon: 'key' },
      { key: 'a-connectors', label: '平台连接器', icon: 'zap' },
    ],
  },
  {
    // 赛事单独一组：它一年用一次，和日常治理（巡查、配额、审计）不是一类事，
    // 混进去只会让那一组变成"杂项"。
    group: '活动',
    items: [
      { key: 'a-event', label: '1024 赛事', icon: 'sparkles' },
    ],
  },
  {
    group: '治理',
    items: [
      { key: 'a-apps', label: '全部作品', icon: 'search' },
      { key: 'a-resources', label: '资源与配额', icon: 'sliders' },
      { key: 'a-settings', label: '平台设置', icon: 'settings' },
      { key: 'a-audit', label: '审计与安全', icon: 'book' },
      { key: 'a-inspection', label: '平台巡检', icon: 'zap' },
    ],
  },
];

/**
 * 从 hash 认出该显示哪一屏。
 *
 * 认三种写法：
 *   #/pages        控制台自己写出去的
 *   #guide         门户侧栏「接入 AI」那条链接过来的
 *   #page=gongshi  门户「我的作品」里点「管理」过来的，带着要选中的页面
 *
 * 认不出来就回总览，而不是白屏——hash 是人能手改的东西。
 */
export function screenFromHash(hash: string): Screen {
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return 'overview';
  if (raw.startsWith('page=')) return 'pages';
  /* 并屏之后，老 hash 仍该落到新屏上：书签和已经发出去的链接不会自己改 */
  const alias: Record<string, Screen> = {
    backend: 'backends', data: 'backends', connectors: 'backends', quota: 'backends',
  };
  return alias[raw] ?? (raw as Screen);
}

/**
 * 文案系统（规格 D9 的双口径）保留，但不再给用户切换开关——
 * 同一个界面两套说法，对使用者是多余的选择。需要技术口径时
 * 改下面 ToneProvider 的常量即可整体切换。
 */
export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const [adminView, setAdminView] = useState(false);
  const [screen, setScreen] = useState<Screen>(() => screenFromHash(location.hash));

  useEffect(() => {
    void api.me().then(setMe).catch(() => setMe(null)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    /*
      只在「当前 hash 指向的不是这一屏」时才写回去，否则门户带过来的
      #page=gongshi 会被立刻改写成 #/pages，而页面与版本那一屏还要从
      hash 里读出该选中哪个页面。
    */
    if (screenFromHash(location.hash) !== screen) location.hash = `#/${screen}`;
  }, [screen]);

  /* 前进后退也该换屏——控制台是 SPA，但 hash 本来就进历史 */
  useEffect(() => {
    const onHash = () => setScreen(screenFromHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)' }}>载入中…</div>;
  }
  if (!me) {
    location.replace(`/deploy/api/auth/login?redirect=${encodeURIComponent('/console')}`);
    return null;
  }

  const isAdmin = me.user.role === 'admin';
  const nav = adminView && isAdmin ? ADMIN_NAV : EMPLOYEE_NAV;

  return (
    <ToneProvider tone="business">
      <GlobalKeyframes />
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <Sidebar
          me={me}
          nav={nav}
          screen={screen}
          onScreen={(s) => setScreen(s as Screen)}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TopBar
            isAdmin={isAdmin}
            adminView={adminView}
            onAdminView={(v) => {
              setAdminView(v);
              setScreen(v ? 'a-overview' : 'overview');
            }}
          />
          {/*
            maxWidth 有了但一直没配 margin: 0 auto，宽屏上内容全靠在侧栏那侧，
            右边留一大片空。minWidth: 0 是给里面的横向滚动表格用的——
            flex 子项默认 min-width:auto，不归零的话表格会把整条主区撑宽，
            滚动条永远出不来（见各屏表格外层的 overflowX）。
          */}
          {/*
            稿上控制台的正文是 1160 宽、左右 40 的留白。比原来的 1440 窄——
            这几屏是读的（总览、版本、记录），一行太长反而难读；真正要宽的
            是管理员那几张表，它们自己带横向滚动。
            minWidth: 0 不能去：flex 子项默认 min-width:auto，不归零的话表格
            会把整条主区撑宽，滚动条永远出不来。
          */}
          <main style={{
            flex: 1, minWidth: 0, margin: '0 auto',
            padding: '12px 40px 96px',
            maxWidth: isAdmin && adminView ? 1440 : 1160, width: '100%',
          }}>
            <Screens screen={screen} me={me} />
          </main>
        </div>
      </div>
    </ToneProvider>
  );
}

/**
 * 「后端与数据」：稿上是一屏，实现上仍是三块（后端应用、数据空间、连接器）。
 *
 * 不把三个组件揉成一个大文件——它们各自有自己的对话框和请求，合并只会让
 * 一个 900 行的文件更难改。这里只负责把它们按稿上的顺序摞起来。
 */
function BackendAndData({ me }: { me: Me }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 56 }}>
      <Backends me={me} />
      <SharedBackends />
      <DataSpace me={me} />
      <Connectors me={me} />
      <QuotaScreen />
    </div>
  );
}

function Screens({ screen, me }: { screen: Screen; me: Me }) {
  switch (screen) {
    case 'overview':     return <SpaceOverview me={me} />;
    case 'pages':        return <MyPages me={me} />;
    case 'backends':     return <BackendAndData me={me} />;
    case 'mobile':       return <MobileChannel />;
    case 'audit':        return <AuditScreen />;
    case 'guide':        return <Guide me={me} />;
    case 'a-overview':   return <AdminOverviewScreen />;
    case 'a-users':      return <AdminUsers />;
    case 'a-tokens':     return <AdminTokens />;
    case 'a-connectors': return <AdminConnectors />;
    case 'a-apps':       return <AdminApps />;
    case 'a-resources':  return <AdminResources />;
    case 'a-settings':   return <AdminSettings />;
    case 'a-audit':      return <AdminAudit />;
    case 'a-inspection': return <AdminInspection />;
    case 'a-event':      return <AdminEvent />;
    default:             return <SpaceOverview me={me} />;
  }
}

/**
 * 退出登录。
 *
 * 无论服务端那一步成不成，都要离开当前页——
 * 原先写成 `api.logout().then(() => location.replace('/'))`，
 * 请求一失败 then 就不跑，页面纹丝不动，用户看到的就是"点了没反应"，
 * 而且控制台里连条错误都没有。会话 cookie 是 HttpOnly，前端清不掉，
 * 所以真失败时也得走到 / 让人看见自己还登着，而不是停在原地猜。
 */
function logout(): void {
  void api.logout()
    .catch(() => undefined)
    .finally(() => location.replace('/'));
}

/**
 * 侧栏（改版稿 §侧栏 · 控制台态）。
 *
 * 与门户那条是同一条侧栏的两副面孔：门户态是探索/推荐/创建/我的作品，
 * 控制台态把它们换成控制台的几项，顶上多一条「回到 iSpace」。两边的尺寸、
 * 圆角、选中底色都一样，所以在两个 SPA 之间跳的时候，侧栏看起来没有动过
 * ——它实际上是两个应用各画了一份（控制台是独立的 /console SPA），
 * 这件事不该让用户察觉。
 */
function Sidebar({
  me, nav, screen, onScreen,
}: {
  me: Me;
  nav: { group: string; items: { key: string; label: string; icon: IconName }[] }[];
  screen: string;
  onScreen: (s: string) => void;
}) {
  return (
    <aside
      style={{
        width: 248, flex: 'none', background: 'var(--surface-sidebar)',
        borderRight: '1px solid var(--border-tabby)',
        display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh', overflowY: 'auto',
      }}
    >
      <div style={{ height: 64, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 12px 0 23px' }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <Mark size={26} />
          <Wordmark size={24} />
        </a>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 12px 0' }}>
        {/*
          a 而不是 button：这是真的离开控制台回到门户，键盘用户和
          「新标签页打开」都只认得真正的链接。
        */}
        <a
          href="/"
          style={{
            display: 'flex', alignItems: 'center', gap: 12, width: '100%', height: 40,
            padding: '0 14px', borderRadius: 12, background: 'transparent',
            color: 'var(--text-secondary)', fontSize: 'var(--text-md)',
            fontWeight: 'var(--weight-medium)', textDecoration: 'none', whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Icon name="left" size={18} />回到 iSpace
        </a>

        {nav.map((g) => (
          <div key={g.group} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span
              style={{
                padding: '20px 14px 6px', fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-label)',
                color: 'var(--text-tertiary)',
              }}
            >
              {g.group}
            </span>
            {g.items.map((it) => {
              const on = screen === it.key;
              return (
                <button
                  key={it.key}
                  onClick={() => onScreen(it.key)}
                  title={it.label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, width: '100%', height: 42,
                    padding: '0 14px', border: 0, borderRadius: 12,
                    background: on ? 'var(--nav-on-bg)' : 'transparent',
                    boxShadow: on ? 'var(--nav-on-sh)' : 'none',
                    color: on ? 'var(--nav-on-fg)' : 'var(--text-secondary)',
                    fontSize: 'var(--text-md)',
                    fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                    cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--surface-sidebar-hover)'; }}
                  onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
                >
                  <Icon name={it.icon} size={18} />
                  <span>{it.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 12 }} />

      <div
        style={{
          padding: '10px 12px 14px', borderTop: '1px solid var(--border-tabby)',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <AvatarMenu
          name={me.user.displayName}
          src={me.user.avatarUrl}
          subtitle={`${location.host}/${me.user.username}`}
          // 挂在侧栏底部：必须往上弹，且必须靠左对齐——侧栏贴着屏幕左缘，
          // 靠右对齐会让菜单往左溢出到视口外
          placement="top"
          align="left"
          trigger={(
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, padding: '6px 8px' }}>
              <Avatar name={me.user.displayName} src={me.user.avatarUrl} size={32} />
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span style={{
                  display: 'block', fontSize: 'var(--text-base)',
                  fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)',
                }}>
                  {me.user.displayName}
                </span>
                <span className="mono" style={{
                  display: 'block', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {/* 管理员显示角色而非身份：对他来说「平台管理员」信息量更大 */}
                  {me.user.role === 'admin' ? '平台管理员 · ' : ''}/{me.user.username}
                </span>
              </span>
            </span>
          )}
          items={[
            { label: '我的作品', href: '/mine' },
            { label: '我的空间', href: `/${me.user.username}/` },
            { label: '退出登录', danger: true, onClick: logout },
          ]}
        />
      </div>
    </aside>
  );
}

/**
 * 顶栏只剩管理员那个视角开关。
 *
 * 改版稿的控制台没有顶栏——内容直接从屏幕顶上开始，而原来那条里的东西
 * （回我的主页、空间地址、平台运行中）要么挪进了侧栏，要么就在总览屏的
 * 第一屏里写着。普通员工因此完全不渲染它，省下 57px 的高度。
 */
function TopBar({
  isAdmin, adminView, onAdminView,
}: {
  isAdmin: boolean; adminView: boolean; onAdminView: (v: boolean) => void;
}) {
  if (!isAdmin) return null;
  return (
    <header
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-8)', height: 56,
        padding: '0 40px', flex: 'none', position: 'sticky', top: 0, zIndex: 5,
        background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
      }}
    >
      <div style={{ flex: 1 }} />
      <Tabs
        value={adminView ? 'admin' : 'employee'}
        onChange={(v) => onAdminView(v === 'admin')}
        items={[
          { value: 'employee' as const, label: '员工视角' },
          { value: 'admin' as const, label: '管理员' },
        ]}
      />
    </header>
  );
}
