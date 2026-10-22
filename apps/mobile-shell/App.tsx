import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, BackHandler, Dimensions, Keyboard, Platform, Pressable,
  StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect as SvgRect, Stop } from 'react-native-svg';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  channelNameFor, CURRENT_EVENT_SLUG as EVENT_SLUG, EVENT_PATH,
  type AppJson,
} from '@ispace/contracts';
import { ShellChrome, IncompatibleScreen } from './src/shell/ShellChrome';
import { NavContainer, parseAppJson } from './src/shell/NavContainer';
import { Settings, type SettingKey } from './src/shell/Settings';
import { AgentChat, type EditTarget } from './src/shell/AgentChat';
import { WebPage, type WebPageTarget } from './src/shell/WebPage';
import { Explore } from './src/shell/Explore';
import { Community, type MyApp } from './src/shell/Community';
import { Messages } from './src/shell/Messages';
import { Profile } from './src/shell/Profile';
import { Interests } from './src/shell/Interests';
import { api } from './src/api';
import { BrandMark, Icon } from './src/shell/Icon';
import { ScanScreen } from './src/shell/Scan';

import { ShellTabs, type ShellTab } from './src/shell/ShellTabs';
import { checkShellUpdate } from './src/runtime/shell-update';
import { API_BASE, DISPLAY_HOST } from './src/config';
import {
  applyUpdate, checkQuietly, rollbackToPrevious,
  switchToUserChannel, versionInfo, type LoadPhase,
} from './src/runtime/channel';
import {
  clearRecentPages, deviceId, getAutoPlay, getDefaultHome, getRecentPages, interestsAsked,
  markInterestsAsked, pushRecentPage, session, setAutoPlay, setDefaultHome, unlockWithBiometrics,
  type RecentPage,
} from './src/runtime/bridge';
import appJson from './app.json';

/**
 * 壳的入口。
 *
 * ┌─ 这个文件属于「JS 壳运行时」，随每个页面包分发 ────────────────────┐
 * │ 构建流水线在 expo export 前把它与用户页面代码合成为一个更新包。      │
 * │ 用户源码中不存在本文件，由流水线注入，用户既改不掉也删不掉——         │
 * │ 这保证了每个用户包都自带完整壳功能，且壳运行时版本永远由平台控制。   │
 * │ 见 tools/compose-bundle.mjs。                                       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 流程（对应设计稿第 10 → 01 屏）：
 *   未登录 → 内嵌包离线可开的登录页
 *   登录后 → 切到 u-{username} 通道 → 就地显示加载进度 → 重载
 *   重载后 → 渲染用户页面包声明的内容区
 *
 * 通道等实现细节不对使用者外露：进度文案只说"正在加载你的应用"。
 */

/**
 * 壳自身的版本，取自 app.json 的 version。
 *
 * 与 runtimeVersion 是两回事：runtimeVersion 决定「哪些页面包能装进来」，
 * 壳版本回答「你手上这个 App 是哪一版」。登录页把两个都显示出来，
 * 排查「同事的能用我的不能用」时第一眼就能看出差在哪。
 * 之前两处都打印 runtimeVersion，等于白占一行。
 *
 * 直接 import 而不是手抄一份字面量：发布脚本取的是 app.json 的 version，
 * 这里若另写一份，发版时漏改就会出现「下载页写 1.1.0、App 里显示 1.0.0」
 * ——而这一行的用处恰恰是排查版本差异，它自己不准就没有意义了。
 */
const SHELL_VERSION: string = appJson.expo.version;

interface Me {
  user: { username: string; displayName: string; identity: 'user' | 'developer'; email?: string | null };
  spaceUrl: string;
  /** /me 本来就带着它，改版前壳没用上——「我」那一屏顶上的容量 chip 要。 */
  quota?: { storageBytesUsed: number; storageBytesLimit: number };
}

/**
 * 用户页面包的入口约定。
 *
 * 合成时流水线把用户的入口挂到 globalThis.__ispacePage 上。
 * 壳只认这个约定，不理解页面内部结构。
 */
interface PageBundle {
  appJson: unknown;
  screens: Record<string, () => React.ReactNode>;
  title?: string;
}

function getPageBundle(): PageBundle | null {
  const g = globalThis as unknown as { __ispacePage?: PageBundle };
  return g.__ispacePage ?? null;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

/**
 * 壳内的一屏。栈只有两层深（首页 + 一个详情），够用且没有回退迷路的风险。
 */
type ShellView =
  /** 首页：用户自己设过默认页就是那一页，没设就是探索 */
  | { kind: 'home' }
  | { kind: 'screen'; route: string; name: string }
  | { kind: 'web'; target: WebPageTarget }
  /* ── 底栏的五个去处（移动端 v2 稿）────────────────────────── */
  | { kind: 'explore' }
  | { kind: 'community' }
  | { kind: 'msg' }
  | { kind: 'me' }
  /** 助手。底栏左边那颗圆钮，不是一个 tab 格子但也是一个去处 */
  | { kind: 'assistant' }
  /** 「我」左上角那颗：扫电脑上页面的二维码 */
  | { kind: 'scan' }
  /** 设置。从「我」右上角那颗齿轮进去，是「我」的下一层 */
  | { kind: 'settings' }
  /** 首次登录问一次「你常做什么」 */
  | { kind: 'interests' };

/**
 * 「我的」里的一项：页面包里的一屏，或者一个用 WebView 打开的地址
 * （自己的页面、添加的别人的页面、露出的后端）。
 */
type LaunchItem =
  | { kind: 'screen'; key: string; route: string; name: string; letter: string }
  | { kind: 'web'; key: string; path: string; name: string; letter: string; owner?: string; cover?: string | null };

/** 活动接口里横幅用得上的那几项。只取用到的，不复刻整个响应类型。 */
type EventPayload = {
  event: { phase: string; config: { deadlines: Record<string, string>; voteLimit: number } };
  stats: { ideaCount: number };
  finalists: unknown[];
  me: { idea: { name: string; finalist: boolean } | null } | null;
};

type EventBannerData = { phase: string; title: string; desc: string };

/** 10.19 */
function eventMd(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 把活动接口的响应拍成横幅那三句话。
 *
 * 与网页端 portal 的 Banner.tsx 是同一套措辞，刻意没有抽成共享模块：
 * 一边是 React DOM、一边是 React Native，能共享的只有这几个字符串，
 * 为它们建一个包不划算；真要改文案，两处一起改，各自都只有一个函数。
 */
function eventBannerData(r: EventPayload): EventBannerData {
  const d = r.event.config?.deadlines ?? {};
  const idea = r.me?.idea ?? null;
  switch (r.event.phase) {
    case 'signup':
      return idea
        ? { phase: '报名中', title: `已交创意「${idea.name}」`, desc: `${eventMd(d.idea)} 12:00 截止前可以改。` }
        : { phase: '报名中', title: '1024 程序员节 · 交创意报名', desc: `提交创意即可参赛，${eventMd(d.idea)} 截止。` };
    case 'screening':
      return { phase: '评委初筛', title: '创意已截止，评委初筛中', desc: `${eventMd(d.screening)} 公布入围名单。` };
    case 'building':
      return idea?.finalist
        ? { phase: '入围制作', title: `「${idea.name}」入围了`, desc: `${eventMd(d.work)} 前提交作品。` }
        : { phase: '入围制作', title: `${r.finalists.length} 个项目入围`, desc: `${eventMd(d.award)} 上午现场路演。` };
    case 'demo':
      return {
        phase: '今天路演',
        title: '今天路演，扫码投票',
        desc: `${r.finalists.length} 个项目现场演示，每人 ${r.event.config?.voteLimit ?? 3} 票。`,
      };
    case 'result':
      return { phase: '已公布', title: '获奖名单已公布', desc: '点开看完整获奖名单。' };
    default:
      return { phase: '进行中', title: '1024 程序员节', desc: '点开看活动详情。' };
  }
}

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [phase, setPhase] = useState<LoadPhase>({ kind: 'idle' });
  const [updateReady, setUpdateReady] = useState(false);
  /** 查过一次更新没有。设置里「页面更新」那一行据此显示「检查中…」还是结果。 */
  const [updateChecked, setUpdateChecked] = useState(false);
  const [view, setView] = useState<ShellView>({ kind: 'home' });
  /**
   * 收起助手时回到哪一格。助手是整屏的、盖在某一格上面打开的，收起来
   * 应该回到原来那一格，而不是每次都跳回探索。
   */
  const [lastTab, setLastTab] = useState<Exclude<ShellTab, 'assistant'>>('explore');
  useEffect(() => {
    const k = view.kind;
    if (k === 'explore' || k === 'community' || k === 'msg' || k === 'me') setLastTab(k);
  }, [view.kind]);
  const [webApps, setWebApps] = useState<LaunchItem[]>([]);
  /**
   * 1024 活动横幅。null = 没有在办的活动（接口拿不到、或已结束），整块不显示。
   *
   * 与 webApps 分开拉：活动接口免登录，而且它挂了不该连带让页面墙空着。
   */
  const [eventBanner, setEventBanner] = useState<EventBannerData | null>(null);
  /*
    横幅收起只对本次启动生效，不落盘：用户按 ✕ 是"现在别烦我"，
    不是"这个版本我永远不要"。下次回前台照常再提。
  */
  const [bannerHidden, setBannerHidden] = useState(false);
  /** 壳（APK）有没有新版。只用来在「我」那格点一个点。 */
  const [shellUp, setShellUp] = useState(false);
  useEffect(() => { void checkShellUpdate().then((r) => setShellUp(Boolean(r))); }, []);
  /*
    手机首页：打开 App 直接就是的那个页面（「我」里长按一个页面设）。

    大多数人做页面是为了天天用其中某一个（今天排班、本周待办），
    每次都要先刷一圈推荐再去「我」里点进去，等于每天多点两下。
    没设就落在探索——移动端 v2 的首屏本来就是刷推荐。
  */
  const [homeKey, setHomeKey] = useState<string | null>(null);
  useEffect(() => { void getDefaultHome().then(setHomeKey); }, []);
  /*
    对话的主语：这次要改哪个页面。跨 tab 保留——用户从「我」长按选了一个
    页面交给助手，切去社区逛一圈再回来，不该又变回「新页面」。
  */
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  /** 只有自己的页面能改，别人分享来的不列进去。 */
  const [myTargets, setMyTargets] = useState<EditTarget[]>([]);
  /** 发帖能附的页面：自己的全部（不只是公开的那些，服务端也只认自己的）。 */
  const [myApps, setMyApps] = useState<MyApp[]>([]);
  /**
   * 「照这个做一个」带过去的那句话。
   *
   * 用一次就清掉（AgentChat 收到后回调 onSeedUsed）：它是一次性的意图，
   * 留着的话，用户下次自己点开助手会发现输入框里莫名其妙躺着别人的提示词。
   */
  const [remixSeed, setRemixSeed] = useState<string | null>(null);
  /** 从助手「找一个」去探索时，一进去就打开搜索。用一次就清。 */
  const [exploreSearch, setExploreSearch] = useState(false);
  /** 待接受的分享数。只用来在「消息」那格点一个点。 */
  const [pendingShares, setPendingShares] = useState(0);
  /** 容量，给「我」那一屏顶上的 chip。拿不到就不显示。 */
  const [quota, setQuota] = useState<{ usedBytes: number; limitBytes: number } | undefined>(undefined);
  const [prefs, setPrefs] = useState({
    autoUpdate: true, wifiOnly: true, voiceTextOnly: true,
    clearDraftOnLogout: false, biometricLock: false,
  });
  /** 设置 ·「自动播放动态内容」。存本机，见 bridge.getAutoPlay。 */
  const [autoPlay, setAutoPlayState] = useState(true);
  useEffect(() => { void getAutoPlay().then(setAutoPlayState); }, []);
  /** 「我 · 页面 · 最近」。 */
  const [recent, setRecent] = useState<RecentPage[]>([]);
  useEffect(() => { void getRecentPages().then(setRecent); }, []);

  // ── 启动：读会话 ────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const t = await session.get();
        if (!t) return;
        setToken(t);
        const res = await fetch(`${API_BASE}/deploy/api/me`, {
          headers: { authorization: `Bearer ${t}` },
        });
        if (res.ok) setMe((await res.json()) as Me);
      } catch {
        // 离线时保持未登录态。内嵌包保证应用仍能打开（expo-updates 默认行为），
        // 这正是设计稿第 10 屏「壳自带的内嵌包离线也能打开」的含义。
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  /*
    状态栏的字：只有登录页是深底白字，其余各屏都是浅底黑字（稿上推荐页
    也是黑字）。

    之前整个壳没有一处管它，安卓默认白字——于是社区、我、设置这些白底屏上，
    时间和信号图标白字白底，整条状态栏看不见。打开页面时 WebPage 会按页面
    顶部的颜色自己再设一次，那一层盖在这里之上，关掉页面就退回这里的值。
  */
  const darkScreen = !me;
  useEffect(() => {
    StatusBar.setBarStyle(darkScreen ? 'light-content' : 'dark-content', true);
    if (Platform.OS === 'android') {
      StatusBar.setTranslucent(true);
      StatusBar.setBackgroundColor('transparent');
    }
  }, [darkScreen]);

  /**
   * 页面封面存的是站内相对路径（如 /zongkelong/gugong-yiri/cover.png）——
   * 网页端 <img> 靠浏览器同源自动补全域名，portal 那边直接拿来用就行。
   * 手机端的 Image 组件没有"当前页面源"这个概念，相对路径等于加载不出来，
   * 得自己补上 API_BASE。已经是完整 URL（页面自己声明了外部图床）的
   * 不重复加前缀。
   */
  const absCover = (u: string | null): string | null =>
    !u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`;

  /**
   * 拉这个人在电脑上做的页面/后端，以及从市场装的别人的页面/后端。
   *
   * 手机端不重新实现一套"我有哪些页面"的判断——服务端已经知道了，
   * 两端各判一次迟早会不一致。
   *
   * 后端（露出的全栈应用）与页面一视同仁地并排——它们都是 kind:'web'，
   * 打开方式同样是 WebView 打开一个地址（/svc/{user}/{name}/ 而不是
   * /{user}/{slug}/）。
   */
  const loadWebApps = useCallback(async () => {
    if (!token) return;
    const auth = { authorization: `Bearer ${token}` };
    try {
      const [mineRes, instRes, bkRes, instBkRes] = await Promise.all([
        fetch(`${API_BASE}/deploy/api/apps`, { headers: auth }),
        fetch(`${API_BASE}/deploy/api/installed`, { headers: auth }),
        fetch(`${API_BASE}/deploy/api/backends`, { headers: auth }),
        fetch(`${API_BASE}/deploy/api/installed/backends`, { headers: auth }),
      ]);
      const items: LaunchItem[] = [];
      if (mineRes.ok) {
        const { apps } = (await mineRes.json()) as {
          apps: { id: string; slug: string; name: string; iconLetter: string; status: string;
                  coverUrl: string | null }[];
        };
        const mine: EditTarget[] = [];
        for (const a of apps) {
          if (a.status === 'stopped') continue;
          items.push({
            kind: 'web', key: `mine:${a.id}`, name: a.name, letter: a.iconLetter,
            path: `/${me?.user.username ?? ''}/${a.slug}/`, cover: absCover(a.coverUrl),
          });
          mine.push({ slug: a.slug, name: a.name, letter: a.iconLetter });
        }
        setMyTargets(mine);
        setMyApps(apps.filter((a) => a.status !== 'stopped').map((a) => ({ app_id: a.id, name: a.name })));
      }
      if (instRes.ok) {
        const { installed } = (await instRes.json()) as {
          installed: { id: string; slug: string; name: string; icon_letter: string;
                       owner_username: string; owner_name: string; cover_path: string | null }[];
        };
        for (const a of installed) {
          items.push({
            kind: 'web', key: `inst:${a.id}`, name: a.name, letter: a.icon_letter,
            path: `/${a.owner_username}/${a.slug}/`, owner: a.owner_name, cover: absCover(a.cover_path),
          });
        }
      }
      if (bkRes.ok) {
        const { backends } = (await bkRes.json()) as {
          backends: { id: string; name: string; exposed: boolean; hasCover: boolean }[];
        };
        for (const b of backends) {
          if (!b.exposed) continue;
          items.push({
            kind: 'web', key: `bk:${b.id}`, name: b.name, letter: b.name.slice(0, 1),
            path: `/svc/${me?.user.username ?? ''}/${b.name}/`,
            cover: b.hasCover ? `${API_BASE}/deploy/api/backends/${b.id}/cover` : null,
          });
        }
      }
      if (instBkRes.ok) {
        const { installed } = (await instBkRes.json()) as {
          installed: { id: string; name: string; owner_username: string; owner_name: string;
                       has_cover: boolean }[];
        };
        for (const b of installed) {
          items.push({
            kind: 'web', key: `instbk:${b.id}`, name: b.name, letter: b.name.slice(0, 1),
            path: `/svc/${b.owner_username}/${b.name}/`, owner: b.owner_name,
            cover: b.has_cover ? `${API_BASE}/deploy/api/backends/${b.id}/cover` : null,
          });
        }
      }
      setWebApps(items);
    } catch {
      // 离线时照样能开：本机页面包那部分不依赖网络
    }
  }, [token, me?.user.username]);

  useEffect(() => { void loadWebApps(); }, [loadWebApps]);

  /* 待接受的分享：只用来在「消息」那格点一个点 */
  useEffect(() => {
    if (!token) return;
    void api.pendingShares(token)
      .then((r) => setPendingShares(r.shares.length))
      .catch(() => setPendingShares(0));
  }, [token]);

  /* 容量跟着 me 走，没有就不显示那颗 chip */
  useEffect(() => {
    const q = me?.quota;
    setQuota(q ? { usedBytes: q.storageBytesUsed, limitBytes: q.storageBytesLimit } : undefined);
  }, [me]);

  /*
    首次登录问一次「你常做什么」。

    问过就不再问——哪怕一个都没选（「跳过」也是一种回答）。判断依据是本机
    的一个标记而不是服务端的 interests 是否为空：空数组既可能是"还没问过"，
    也可能是"问过、他跳过了"，而把跳过的人每次登录都再拦一次，是这一屏最
    容易犯的错。
  */
  useEffect(() => {
    if (!me || !token) return;
    void interestsAsked().then((asked) => {
      if (!asked) setView({ kind: 'interests' });
    });
  }, [me, token]);

  /*
    活动横幅。带上令牌是为了拿到「我交没交创意」那一块；没有令牌也能拉到
    活动本身（接口免登录），所以这一下不等登录完成。

    任何失败都当作「没有活动」：横幅是锦上添花，不该因为它让首屏出错。
  */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/deploy/api/events/${EVENT_SLUG}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(String(res.status));
        const r = (await res.json()) as EventPayload;
        if (!alive) return;
        setEventBanner(r.event.phase === 'ended' ? null : eventBannerData(r));
      } catch {
        if (alive) setEventBanner(null);
      }
    })();
    return () => { alive = false; };
  }, [token]);

  /**
   * 更新检查：回到前台时补一次。
   *
   * 只在登录那一刻查过一次是不够的——同事在电脑上发了新版，用户这边
   * 什么都不会发生，直到他想起来杀掉 App 重开。而"回到前台"恰好是
   * 用户下一次要用它的时刻，此时提示最有意义。
   */
  const check = useCallback(() => {
    void checkQuietly().then((r) => {
      setUpdateReady(r.available);
      setUpdateChecked(true);
      if (r.available) setBannerHidden(false);
    });
  }, []);

  useEffect(() => {
    if (!me) return;
    check();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') check(); });
    return () => sub.remove();
  }, [me, check]);

  const loadMyApp = useCallback(async (user: Me) => {
    const id = await deviceId();
    await switchToUserChannel({
      username: user.user.username,
      deviceId: id,
      onPhase: setPhase,
    });
  }, []);

  /*
    登录成功。令牌要和 me 一起放进 state：之前只放了 me，令牌留在 SecureStore
    里没人读——于是刚登录的这一次，凡是要带令牌的请求（我的页面、选方向、
    发帖能附的页面……）一个都没发，「我」里显示「还没有页面」，杀掉重开才好。
    三条登录路径（密码、扫码、SSO）都是先 session.set 再回调到这里。
  */
  const onLoggedIn = (m: Me) => {
    void session.get().then((t) => {
      setToken(t);
      setMe(m);
      setView({ kind: 'home' });
      void loadMyApp(m);
    });
  };

  /*
    退出。把这个人的东西从内存里清干净：共用手机换人登录时，下一个人不该在
    「我」里先看到上一个人的页面、在助手里接着上一个人的对话。
  */
  const onLogout = () => {
    setMe(null);
    setToken(null);
    setWebApps([]);
    setMyTargets([]);
    setMyApps([]);
    setEditTarget(null);
    setRemixSeed(null);
    setRecent([]);
    void clearRecentPages();
    setView({ kind: 'home' });
  };

  if (booting) return <Splash />;

  if (!me) {
    return <LoginScreen onLoggedIn={onLoggedIn} />;
  }

  if (phase.kind === 'incompatible') {
    return (
      <IncompatibleScreen
        requiredRuntime={phase.requiredRuntime}
        currentRuntime={phase.currentRuntime}
        onRetry={() => void loadMyApp(me)}
        onFallback={() => void rollbackToPrevious(me.user.username)}
      />
    );
  }

  if (phase.kind !== 'idle' && phase.kind !== 'up-to-date' && phase.kind !== 'failed') {
    return <LoadingScreen phase={phase} onCancel={() => setPhase({ kind: 'idle' })} />;
  }

  const bundle = getPageBundle();
  const parsed = parseAppJson(bundle?.appJson ?? {});
  const config: AppJson = parsed.config;
  const v = versionInfo();

  /*
    页面包声明的屏。除首屏外的每一屏都并进「我的」——用户的第二个、
    第三个页面得有地方去，不能只有 app.json 里声明的那 5 个 tab 位。
  */
  const screenItems: LaunchItem[] = Object.keys(bundle?.screens ?? {}).map((route, i) => ({
    kind: 'screen', key: `screen:${route}`, route,
    name: i === 0 ? (bundle?.title ?? '我的应用') : route.replace(/^\//, '') || '主页',
    letter: (bundle?.title ?? '应').slice(0, 1),
  }));
  const launchItems: LaunchItem[] = [...screenItems, ...webApps];

  /*
    首页要渲染的那个页面。选过但已经不在了（删了 / 改名）就当没选过——
    停在一个打不开的东西上比空着更糟。
  */
  const homeItem = homeKey ? launchItems.find((i) => i.key === homeKey) : undefined;

  const openWeb = (path: string, title: string, cover?: string | null) => {
    setView({ kind: 'web', target: { path, title } });
    /* 「最近」只记页面（/{user}/{slug}/、/svc/…），控制台和作者主页不算 */
    if (/^\/[^/]+\/[^/]+\/?$/.test(path) || path.startsWith('/svc/')) {
      void pushRecentPage({ path, name: title, cover: cover ?? null }).then(setRecent);
    }
  };

  if (view.kind === 'web') {
    return <WebPage target={view.target} token={token} onBack={() => setView({ kind: lastTab })} />;
  }

  if (view.kind === 'scan') {
    return (
      <ScanScreen
        onClose={() => setView({ kind: 'me' })}
        onOpenPath={(path) => openWeb(path, '扫到的页面')}
      />
    );
  }

  /*
    底栏的几个去处都是壳自己的屏，切换只是换 view，不入栈。
    「进探索就打开搜索」是从助手「找一个」带过来的一次性意图，换格就清掉。
  */
  const goTab = (t: ShellTab) => { setExploreSearch(false); setView({ kind: t }); };

  /** 底栏。几屏共用一份，省得每屏抄一遍那七个 props。 */
  const tabs = (active: ShellTab | null, dark = false) => (
    <ShellTabs
      active={active}
      onChange={goTab}
      avatarLetter={avatarLetter(me.user.displayName)}
      dark={dark}
      pageUpdate={updateReady && !bannerHidden}
      onApplyPageUpdate={() => void applyUpdate(setPhase)}
      onDismissPageUpdate={() => setBannerHidden(true)}
      shellUpdate={shellUp}
      unread={pendingShares > 0}
    />
  );

  /** 带着一句话去助手（做同款、找灵感）。目标置空：这是做新的，不是改已有的那个。 */
  const toAssistant = (seed: string | null) => {
    setEditTarget(null);
    setRemixSeed(seed);
    setView({ kind: 'assistant' });
  };

  /*
    首页。设过手机首页就是那个页面；本机装着页面包（旧的个人包）就是它；
    都没有就是探索——移动端 v2 的首屏就是刷推荐。
  */
  const homeWeb = view.kind === 'home' && homeItem?.kind === 'web' ? homeItem : null;
  const homeBundle = view.kind === 'home' && !homeWeb && bundle !== null;

  if (homeWeb) {
    return (
      <View style={{ flex: 1 }}>
        {/* 首页是根：不给返回键，出口是底下那条 tab */}
        <WebPage target={{ path: homeWeb.path, title: homeWeb.name }} token={token} />
        {tabs(null)}
      </View>
    );
  }

  if (view.kind === 'explore' || (view.kind === 'home' && !homeBundle)) {
    return (
      <View style={{ flex: 1 }}>
        <Explore
          token={token}
          autoPlay={autoPlay}
          searchFirst={exploreSearch}
          onOpen={(l) => openWeb(`/${l.owner_username}/${l.slug}/`, l.name, absCover(l.cover_path))}
          onRemix={toAssistant}
          onAuthor={(u) => openWeb(`/${u}`, u)}
          onInstalled={() => void loadWebApps()}
        />
        {tabs('explore', true)}
      </View>
    );
  }

  if (view.kind === 'community') {
    return (
      <View style={{ flex: 1 }}>
        <Community
          token={token}
          me={{ displayName: me.user.displayName }}
          myApps={myApps}
          onOpenApp={(owner, slug, name) => openWeb(`/${owner}/${slug}/`, name)}
          onAuthor={(u) => openWeb(`/${u}`, u)}
          onBell={() => setView({ kind: 'msg' })}
          onRemix={toAssistant}
        />
        {tabs('community')}
      </View>
    );
  }

  if (view.kind === 'msg') {
    return (
      <View style={{ flex: 1 }}>
        <Messages
          token={token}
          pageUpdate={updateReady}
          onApplyPageUpdate={() => void applyUpdate(setPhase)}
          {...(eventBanner ? {
            event: { title: eventBanner.title, desc: eventBanner.desc },
            onOpenEvent: () => openWeb(EVENT_PATH, '1024 程序员节'),
          } : {})}
          onWorks={() => { void loadWebApps(); setView({ kind: 'me' }); }}
        />
        {tabs('msg')}
      </View>
    );
  }

  if (view.kind === 'interests') {
    return (
      <Interests
        token={token}
        initial={[]}
        onDone={() => { void markInterestsAsked(); setView({ kind: 'explore' }); }}
      />
    );
  }

  /*
    助手。移动端 v2 把它提成了底栏左边那颗圆钮，而且是整屏的——稿上这一屏
    没有底栏，右上角那颗 ⌄ 收起。之前底栏照样浮在上面，正好压住输入框。
  */
  if (view.kind === 'assistant') {
    return (
      <AgentChat
        token={token}
        displayName={me.user.displayName}
        target={editTarget}
        onClearTarget={() => setEditTarget(null)}
        onClose={() => {
          if (exploreSearch) setExploreSearch(false);
          setView({ kind: lastTab });
        }}
        onOpenPage={(path, name) => openWeb(path, name)}
        onExplore={(search) => { setExploreSearch(search); setView({ kind: 'explore' }); }}
        seed={remixSeed}
        onSeedUsed={() => setRemixSeed(null)}
      />
    );
  }

  if (view.kind === 'me') {
    return (
      <View style={{ flex: 1 }}>
        <Profile
          token={token}
          username={me.user.username}
          displayName={me.user.displayName}
          spaceUrl={me.spaceUrl}
          {...(quota ? { quota } : {})}
          pages={launchItems
            .filter((it): it is Extract<LaunchItem, { kind: 'web' }> => it.kind === 'web')
            .map((it) => ({
              key: it.key, name: it.name, letter: it.letter,
              cover: it.cover ?? null, owner: it.owner, path: it.path,
              editable: it.key.startsWith('mine:'),
            }))}
          recent={recent}
          homeKey={homeKey}
          onOpenPath={(path, name, cover) => openWeb(path, name, cover)}
          onSettings={() => setView({ kind: 'settings' })}
          onConsole={() => openWeb('/console', '控制台')}
          onAuthor={(u) => openWeb(`/${u}`, u)}
          onExpand={() => openWeb('/console#quota', '空间与配额')}
          onScan={() => setView({ kind: 'scan' })}
          onSetHome={(key) => { setHomeKey(key); void setDefaultHome(key); }}
          onEdit={(key) => {
            const it = launchItems.find((i) => i.key === key);
            const slug = it?.kind === 'web' ? it.path.split('/').filter(Boolean)[1] : undefined;
            const t = slug ? myTargets.find((m) => m.slug === slug) : undefined;
            if (t) { setEditTarget(t); setRemixSeed(null); setView({ kind: 'assistant' }); }
          }}
        />
        {tabs('me')}
      </View>
    );
  }

  if (view.kind === 'settings') {
    return (
      <View style={{ flex: 1 }}>
        <Settings
          token={token}
          user={me.user}
          shellVersion={SHELL_VERSION}
          bundleVersion={v.updateId ? v.updateId.slice(0, 8) : '内嵌包'}
          updateChannel={channelNameFor(me.user.username)}
          quota={quota}
          pageUpdate={updateChecked ? updateReady : null}
          onCheckUpdate={check}
          onApplyUpdate={() => void applyUpdate(setPhase)}
          autoPlay={autoPlay}
          onAutoPlay={(on) => { setAutoPlayState(on); void setAutoPlay(on); }}
          autoUpdate={prefs.autoUpdate}
          wifiOnly={prefs.wifiOnly}
          voiceTextOnly={prefs.voiceTextOnly}
          clearDraftOnLogout={prefs.clearDraftOnLogout}
          biometricLock={prefs.biometricLock}
          onToggle={(k: SettingKey, val) => {
            setPrefs((p) => ({ ...p, [k]: val }));
            if (k === 'biometricLock' && val) void unlockWithBiometrics('开启后回到应用需要验证');
          }}
          onRollback={() => void rollbackToPrevious(me.user.username)}
          onOpenWeb={(path, title) => openWeb(path, title)}
          onRenamed={(displayName) => setMe((m) => (m ? { ...m, user: { ...m.user, displayName } } : m))}
          onLogout={onLogout}
          onClose={() => setView({ kind: 'me' })}
        />
        {tabs('me')}
      </View>
    );
  }

  /* 剩下的只有一种：本机装着页面包（旧的个人包），首页就是它 */
  return (
    <ShellChrome
      appJson={config}
      // 设置只有「我」这一个入口，页面角落不再挂齿轮；更新提示也统一
      // 收在底栏那条横幅上——用户页面的四个角都还给页面自己
      {...(view.kind === 'screen' ? { onBack: () => setView({ kind: 'home' }) } : {})}
    >
      {bundle ? (
        <NavContainer
          config={config}
          screens={bundle.screens}
          title={bundle.title}
          {...(view.kind === 'screen' ? { forceRoute: view.route } : {})}
        />
      ) : (
        <NoBundleScreen
          username={me.user.username}
          onLoad={() => void loadMyApp(me)}
          error={phase.kind === 'failed' ? phase.message : parsed.error}
        />
      )}

      {/*
        壳的底部导航只在首页出现。
        进到具体页面（view.kind === 'screen'）就交出整块屏幕——页面可能
        自带底部操作条，两条叠在一起谁都点不准。
      */}
      {view.kind === 'home' && tabs(null)}
    </ShellChrome>
  );
}

/** 头像里的那个字。中文取最后一个字，英文取首字母——与电脑端同一条规则。 */
function avatarLetter(name: string): string {
  const t = (name || '').trim();
  if (!t) return '·';
  return /[\u4e00-\u9fa5]/.test(t) ? t.slice(-1) : t.slice(0, 1).toUpperCase();
}

// ── 登录（移动端 v2 稿 01）──────────────────────────────────────────
/**
 * 登录。
 *
 * 邮箱 + 密码，与桌面端同一套账号；配了 OIDC_* 时多一个「用公司账号登录」。
 *
 * 版式照移动端 v2 稿第 01 屏：整屏深色，上半屏一片斜着的封面拼贴往下渐暗，
 * 底下一句大字、两颗胶囊。两颗胶囊按有没有 SSO 换角色：
 *   有 SSO：用公司账号登录 / 邮箱（稿上就是这样）
 *   没 SSO：用邮箱登录 / 扫码登录——稿上那颗「公司账号」点下去没有地方去，
 *           不摆一颗死按钮；扫码本来就在这一屏，提上来当第二颗
 * 点「邮箱」才展开输入框：稿上这一屏没有输入框，一进来就是两个空框，
 * 和稿的气质差得最远。
 *
 * 手机上不做注册：那一栏「空间标识」在小屏上很难解释清楚，而且注册这件事
 * 一辈子做一次，在电脑上做更合适。
 */
function LoginScreen({ onLoggedIn }: { onLoggedIn: (m: Me) => void }) {
  const insets = useSafeAreaInsets();
  const v = versionInfo();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    void fetch(`${API_BASE}/deploy/api/auth/policy`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ssoEnabled?: boolean } | null) => setSsoEnabled(Boolean(d?.ssoEnabled)))
      .catch(() => setSsoEnabled(false));
  }, []);

  /*
    键盘：安卓 edge-to-edge 下窗口不缩，输入框在屏幕下半截，键盘一起来就把
    它整个盖住。自己量键盘顶边，把底下那一块往上抬。
  */
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => {
      setKb(Math.max(0, Dimensions.get('screen').height - e.endCoordinates.screenY));
    });
    const b = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => { a.remove(); b.remove(); };
  }, []);

  const login = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${API_BASE}/deploy/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = (await r.json()) as { token?: string; message?: string };
      if (!r.ok || !body.token) throw new Error(body.message ?? '登录失败');

      await session.set(body.token);
      const meRes = await fetch(`${API_BASE}/deploy/api/me`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      if (!meRes.ok) throw new Error('登录成功但取不到账号信息');
      onLoggedIn((await meRes.json()) as Me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (scanning) {
    return (
      <QrScanScreen
        onDone={(m) => { setScanning(false); if (m) onLoggedIn(m); }}
      />
    );
  }

  const emailReady = email.trim().length > 0 && password.length > 0;
  const { width, height } = Dimensions.get('window');

  return (
    <View style={{ flex: 1, backgroundColor: '#100f0e' }}>
      {/*
        封面拼贴。稿上每一块是一张真页面的封面——那些封面要登录才拿得到
        （/marketplace 要会话），所以这里是同一组底色的空块：构图照稿，
        但不假装展示了并不存在的内容。
      */}
      <View style={s.collage} pointerEvents="none">
        {COLLAGE.map((col, i) => (
          <View key={i} style={{ width: 170, gap: 14, paddingTop: col.top }}>
            {col.tiles.map((t, j) => (
              <View key={j} style={{ height: t.h, borderRadius: 28, backgroundColor: t.bg }} />
            ))}
          </View>
        ))}
      </View>
      <Svg style={StyleSheet.absoluteFill} width={width} height={height} pointerEvents="none">
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.3" stopColor="#100f0e" stopOpacity={0} />
            <Stop offset="0.62" stopColor="#100f0e" stopOpacity={0.92} />
            <Stop offset="0.78" stopColor="#100f0e" stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <SvgRect x={0} y={0} width={width} height={height} fill="url(#fade)" />
      </Svg>

      {/* 左上那颗 ×：安卓上就是退出（这一屏没有别的地方可回）。iOS 不许 App 自己退出，不摆 */}
      {Platform.OS === 'android' && (
        <Pressable
          style={[s.loginClose, { top: insets.top + 10 }]}
          onPress={() => BackHandler.exitApp()}
          accessibilityLabel="退出"
        >
          <Icon name="x" size={20} color="#fff" />
        </Pressable>
      )}
      <View style={[s.loginBrand, { top: insets.top + 14 }]}>
        <BrandMark size={30} />
        <Text style={s.loginWordmark}>iSPACE</Text>
      </View>

      <View style={[s.loginBottom, { bottom: kb > 0 ? kb + 16 : insets.bottom + 28 }]}>
        {kb === 0 && (
          <>
            <Text style={s.loginTitle}>用同事的{'\n'}做自己的</Text>
            <Text style={s.loginSub}>下一个，做给组里每天都要用它的人。</Text>
          </>
        )}

        {formOpen ? (
          <View style={s.loginForm}>
            <TextInput
              style={s.loginInput}
              value={email}
              onChangeText={setEmail}
              placeholder="公司邮箱"
              placeholderTextColor="rgba(255,255,255,.45)"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              autoFocus
              editable={!busy}
            />
            <TextInput
              style={s.loginInput}
              value={password}
              onChangeText={setPassword}
              placeholder="密码"
              placeholderTextColor="rgba(255,255,255,.45)"
              secureTextEntry
              autoCapitalize="none"
              autoComplete="password"
              editable={!busy}
              onSubmitEditing={() => { if (emailReady) void login(); }}
            />
            {err && <Text style={s.loginErr}>{err}</Text>}
            <Pressable
              style={[s.loginPrimary, !emailReady && { opacity: 0.4 }]}
              disabled={busy || !emailReady}
              onPress={() => void login()}
            >
              <Text style={[s.loginPrimaryText, { textAlign: 'center' }]}>{busy ? '登录中…' : '登录'}</Text>
            </Pressable>
            <Pressable style={s.loginLink} onPress={() => { setFormOpen(false); setErr(null); }} hitSlop={8}>
              <Text style={s.loginLinkText}>换个方式登录</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Pressable
              style={s.loginPrimary}
              disabled={busy}
              onPress={ssoEnabled
                ? () => { void openSsoAndAwait().then((m) => m && onLoggedIn(m)); }
                : () => setFormOpen(true)}
            >
              <View style={s.loginPrimaryIcon}>
                <Icon name={ssoEnabled ? 'building' : 'mail'} size={21} color="#fff" />
              </View>
              <Text style={s.loginPrimaryText}>{ssoEnabled ? '用公司账号登录' : '用邮箱登录'}</Text>
              <Text style={s.loginChevrons}>›››</Text>
            </Pressable>
            <Pressable
              style={s.loginSecondary}
              onPress={ssoEnabled ? () => setFormOpen(true) : () => setScanning(true)}
              disabled={busy}
            >
              <Icon name={ssoEnabled ? 'mail' : 'qr'} size={20} color="#fff" />
              <Text style={s.loginSecondaryText}>{ssoEnabled ? '邮箱' : '扫码登录'}</Text>
            </Pressable>
          </>
        )}

        {kb === 0 && (
          <Text style={s.loginFoot}>
            {ssoEnabled && !formOpen ? (
              <Text style={s.loginFootLink} onPress={() => setScanning(true)}>扫码登录 · 电脑上已登录就不用敲密码{'\n'}</Text>
            ) : null}
            {/* 注册引导到桌面端：空间标识那一栏在小屏上很难解释清楚，
                而它是长期对外的地址，值得在电脑前想清楚再定。 */}
            还没有账号？在电脑上打开 <Text style={s.loginFootLink}>{DISPLAY_HOST}</Text> 注册{'\n'}
            App {SHELL_VERSION} · runtimeVersion {v.runtimeVersion}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * 登录页那片封面拼贴的几何，照稿抄：三列、每列宽 170、错开的起点、
 * 整片转 -9°。颜色是稿上那几块封面的底色。
 */
const COLLAGE = [
  { top: 40, tiles: [{ h: 300, bg: '#36241e' }, { h: 260, bg: '#3a3120' }] },
  { top: 140, tiles: [{ h: 300, bg: '#2f3b2f' }, { h: 300, bg: '#2a2745' }] },
  { top: 80, tiles: [{ h: 280, bg: '#34373b' }, { h: 300, bg: '#36241e' }] },
];

/**
 * 扫码登录的取景屏。
 *
 * 桌面端（已登录）在头像菜单里生成一个 60 秒的一次性码显示成二维码，
 * 这里扫到后用它换会话——手机有摄像头、桌面有会话，各出各的，
 * 不用在手机上敲一遍密码。
 *
 * 码的格式是 `ispace-login:{uuid}`。故意不用 URL：普通相机 App 扫到
 * 也只是一串认不出的文本，不会跳去任何地方，码也不会落进浏览器历史。
 */
function QrScanScreen({ onDone }: { onDone: (m: Me | null) => void }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 相机每秒能回调几十次同一个码，必须锁住首个，否则同一个码会被
  // exchange 两次——第二次必然失败（用一次即毁），反而把成功盖成报错
  const locked = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const onScanned = async (data: string) => {
    if (locked.current || busy) return;
    if (!data.startsWith('ispace-login:')) return;   // 别人的二维码，静默忽略
    locked.current = true;
    setBusy(true); setErr(null);
    try {
      const code = data.slice('ispace-login:'.length);
      const r = await fetch(`${API_BASE}/deploy/api/auth/native/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = (await r.json()) as { token?: string; message?: string };
      if (!r.ok || !body.token) throw new Error(body.message ?? '这个码不对或已过期');

      await session.set(body.token);
      const meRes = await fetch(`${API_BASE}/deploy/api/me`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      if (!meRes.ok) throw new Error('登录成功但取不到账号信息');
      onDone((await meRes.json()) as Me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      // 出错后放开锁：码过期是常态（60 秒），让人在电脑上点「重新生成」再扫
      locked.current = false;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {permission?.granted ? (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => void onScanned(data)}
        />
      ) : (
        <View style={[s.center, { backgroundColor: '#000' }]}>
          <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center', lineHeight: 24 }}>
            需要相机权限才能扫码。{'\n'}
            {permission?.canAskAgain === false
              ? '请到系统设置里给 iSpace 打开相机权限。'
              : '正在请求权限…'}
          </Text>
        </View>
      )}

      {/* 顶部说明与取消，压在取景之上 */}
      <View style={{
        position: 'absolute', left: 0, right: 0, top: insets.top,
        alignItems: 'center', paddingTop: 16, gap: 10,
      }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
          扫电脑上的登录二维码
        </Text>
        <Text style={{ color: 'rgba(255,255,255,.75)', fontSize: 12, textAlign: 'center', paddingHorizontal: 40, lineHeight: 18 }}>
          电脑上打开 {API_BASE.replace('http://', '')}，点右上角头像 → 手机扫码登录
        </Text>
        {err && (
          <Text style={{ color: '#ffb4a1', fontSize: 13, paddingHorizontal: 32, textAlign: 'center' }}>
            {err}
          </Text>
        )}
        {busy && <Text style={{ color: '#fff', fontSize: 13 }}>登录中…</Text>}
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 24, alignItems: 'center' }}>
        <Pressable
          onPress={() => onDone(null)}
          style={{ paddingVertical: 12, paddingHorizontal: 36, borderRadius: 24, backgroundColor: 'rgba(255,255,255,.18)' }}
        >
          <Text style={{ color: '#fff', fontSize: 15 }}>取消</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * SSO 登录。
 *
 * 走系统浏览器而非内嵌 WebView：企业 IdP 通常拒绝在 WebView 里完成登录
 * （出于防钓鱼考虑），且系统浏览器能复用已有的公司登录态。
 * 回跳经 scheme ispace:// 深链，token 由壳存入 SecureStore。
 */
async function openSsoAndAwait(): Promise<Me | null> {
  const WebBrowser = await import('expo-web-browser');

  /**
   * 先向服务端登记一个配对 id，再开浏览器，然后轮询把令牌取回来。
   *
   * 为什么不靠深链回跳兑现 Promise：实测荣耀机上 Chrome 送来的 intent 带
   * FLAG_ACTIVITY_CLEAR_TOP，配 singleTask 会重建 Activity，
   * openAuthSessionAsync 的 Promise 就此消失——用户看到的是"登录完又回到
   * 登录页"，而且没有任何报错。各家 ROM 行为不一致，这条路不可靠。
   *
   * 轮询则与深链是否送达无关：Activity 重建也好、用户手动切回来也好，
   * 令牌都在服务端等着被取走。深链仍保留为快路径——它先到就先关浏览器。
   */
  const pairRes = await fetch(`${API_BASE}/deploy/api/auth/native/pair`, { method: 'POST' });
  if (!pairRes.ok) return null;
  const { pairingId } = (await pairRes.json()) as { pairingId: string };

  const url =
    `${API_BASE}/deploy/api/auth/login?pairing=${encodeURIComponent(pairingId)}`;

  /**
   * 用 openBrowserAsync 而不是 openAuthSessionAsync。
   *
   * 后者为了截获深链回跳会挂一套 Linking 监听，并在部分 ROM 上把浏览器
   * 拉进独立 task——实测荣耀机上关掉浏览器后回到的是**另一个** App 实例，
   * 正在轮询的那个还在后台，于是屏幕上仍是登录页。
   *
   * 既然改成轮询，就完全不需要深链，也就不需要那套机制。
   * 普通浏览器窗口回来的是同一个实例。
   */
  void WebBrowser.openBrowserAsync(url).catch(() => undefined);

  const token = await pollForToken(pairingId);
  // 拿到了就把浏览器收掉，用户不用自己按返回
  WebBrowser.dismissBrowser?.();
  if (!token) return null;

  await session.set(token);
  const res = await fetch(`${API_BASE}/deploy/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok ? ((await res.json()) as Me) : null;
}

/**
 * 轮询直到拿到令牌。
 *
 * 5 分钟上限与服务端的配对有效期一致——超了服务端也已经把它删了，
 * 再问下去只会一直拿到 expired。间隔 1.5 秒：人在浏览器里操作要几十秒，
 * 更密只是白耗电，更疏则登录完还要干等。
 */
async function pollForToken(pairingId: string): Promise<string | null> {
  const deadline = Date.now() + 5 * 60_000;

  const once = async (): Promise<string | null | 'pending'> => {
    try {
      const r = await fetch(
        `${API_BASE}/deploy/api/auth/native/poll?id=${encodeURIComponent(pairingId)}`,
      );
      if (!r.ok) return 'pending';
      const body = (await r.json()) as { status: string; token?: string };
      if (body.status === 'ok' && body.token) return body.token;
      if (body.status === 'expired') return null;
      return 'pending';
    } catch {
      // 网络抖动不该中断整个登录，当作还没好，继续等
      return 'pending';
    }
  };

  /**
   * 除了定时轮询，还要在 App 回到前台时立刻补一次。
   *
   * 实测荣耀机（HyperHold 后台冻结）在切去浏览器后会把 JS 定时器冻住，
   * 于是整个登录期间只发出了一次轮询——回到前台后循环也醒不过来，
   * 表现为"登录完了但 App 还停在登录页"。各家国产 ROM 的省电策略都类似，
   * 所以不能只依赖 setTimeout。AppState 变 active 是最可靠的唤醒点：
   * 用户从浏览器回到 App 的那一刻，正是令牌已经就绪的时刻。
   */
  let wake: (() => void) | null = null;
  const sub = AppState.addEventListener('change', (st) => {
    if (st === 'active') wake?.();
  });

  try {
    while (Date.now() < deadline) {
      const r = await once();
      if (r !== 'pending') return r;
      await new Promise<void>((resolve) => {
        wake = resolve;
        const t = setTimeout(resolve, 1500);
        // 谁先到算谁的；重复 resolve 是无害的
        void t;
      });
      wake = null;
    }
  } finally {
    sub.remove();
  }
  return null;
}

// ── 加载中（设计稿：就地显示加载进度，不外露通道细节）──────────────
function LoadingScreen({ phase, onCancel }: { phase: LoadPhase; onCancel?: () => void }) {
  /*
    等久了给一个出口。

    这一屏是全屏的：网络慢、服务端抽风、或者上面那层抛了异常没人接，
    用户就被永久困在这儿，只能杀进程。12 秒之后露出「先不更新」——
    更新是锦上添花，不该成为进入 App 的必经关卡。
  */
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, []);
  const text =
    phase.kind === 'switching' ? '正在准备你的应用'
    : phase.kind === 'checking' ? '正在检查更新'
    : phase.kind === 'downloading' ? '正在下载'
    : '即将就绪';
  return (
    <View style={s.center}>
      <ActivityIndicator color="#fb923c" />
      <Text style={[s.body, { marginTop: 14 }]}>{text}</Text>
      {slow && onCancel && (
        <Pressable style={[s.btn, { marginTop: 18 }]} onPress={onCancel}>
          <Text style={s.body}>先不更新，直接进去</Text>
        </Pressable>
      )}
    </View>
  );
}

function NoBundleScreen({
  username, onLoad, error,
}: { username: string; onLoad: () => void; error?: string }) {
  return (
    <View style={s.center}>
      <Text style={s.title}>还没有加载你的应用</Text>
      <Text style={s.body}>
        你的空间 /{username} 下还没有发布过手机页面包，或尚未下载到本机。
      </Text>
      {/* 既可能是页面声明不合法，也可能是刚才那次加载抛了错。
          必须展示出来：这块屏静默吞错时，"加载失败"和"确实没发过版"
          看起来一模一样，排查只能靠服务端日志倒推。 */}
      {error && <Text style={s.errText}>没能加载：{error}</Text>}
      <Pressable style={[s.btn, s.btnPrimary]} onPress={onLoad}>
        <Text style={s.btnPrimaryText}>重新加载</Text>
      </Pressable>
    </View>
  );
}

function Splash() {
  return <View style={s.center}><ActivityIndicator color="#fb923c" /></View>;
}

const s = StyleSheet.create({
  // ── 登录（移动端 v2 稿 01）──────────────────────────────────────
  collage: {
    position: 'absolute', left: -70, top: -40, flexDirection: 'row', gap: 14,
    transform: [{ rotate: '-9deg' }], transformOrigin: 'top left',
  },
  loginClose: {
    position: 'absolute', left: 18, width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,.14)', alignItems: 'center', justifyContent: 'center',
  },
  loginBrand: { position: 'absolute', right: 18, flexDirection: 'row', alignItems: 'center', gap: 8 },
  loginWordmark: { fontSize: 22, fontWeight: '700', color: '#fff', letterSpacing: -0.2 },
  loginBottom: { position: 'absolute', left: 24, right: 24, gap: 14 },
  loginTitle: { fontSize: 54, fontWeight: '900', lineHeight: 60, color: '#fff', letterSpacing: -1 },
  loginSub: { fontSize: 16, color: 'rgba(255,255,255,.72)', paddingBottom: 14 },
  loginPrimary: {
    flexDirection: 'row', alignItems: 'center', gap: 12, height: 62, paddingLeft: 8, paddingRight: 20,
    borderRadius: 31, backgroundColor: '#ee5c2a', justifyContent: 'center',
  },
  loginPrimaryIcon: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(255,255,255,.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  loginPrimaryText: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: '#fff' },
  loginChevrons: { fontSize: 18, color: 'rgba(255,255,255,.8)', letterSpacing: -1 },
  loginSecondary: {
    flexDirection: 'row', gap: 10, height: 58, borderRadius: 29, backgroundColor: '#1e1c1a',
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  loginSecondaryText: { fontSize: 17, fontWeight: '700', color: '#fff' },
  loginForm: { gap: 10 },
  loginInput: {
    height: 56, borderRadius: 28, paddingHorizontal: 22,
    backgroundColor: '#1e1c1a', borderWidth: 1, borderColor: 'rgba(255,255,255,.14)',
    fontSize: 16, color: '#fff',
  },
  loginErr: { fontSize: 14, color: '#ff8a8a', paddingHorizontal: 8 },
  loginLink: { alignItems: 'center', paddingTop: 4 },
  loginLinkText: { fontSize: 14, color: 'rgba(255,255,255,.72)' },
  loginFoot: {
    paddingTop: 10, textAlign: 'center', fontSize: 13, lineHeight: 22,
    color: 'rgba(255,255,255,.55)',
  },
  loginFootLink: { color: '#ff8965' },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 32, gap: 8, backgroundColor: '#fcfcf8',
  },
  /**
   * 与桌面端登录页一致：Caveat 手写体、26px、常规字重。
   *
   * 设计稿在这两处本身不一致（手机端写的是 Happy tabby），按产品要求统一。
   * 字体由 expo-font 在构建期嵌入，fontFamily 用的是 TTF 里的家族名，
   * 不是文件名——写错了安卓会静默回落到系统字体，看着"像没生效"。
   */
  greeting: { fontFamily: 'Caveat-Regular', fontSize: 26, lineHeight: 31, color: '#1c1f23' },
  title: { fontSize: 18, fontWeight: '700', color: '#001217', marginTop: 4 },
  body: { fontSize: 14, color: '#545659', textAlign: 'center', lineHeight: 21 },
  errText: { fontSize: 12, color: '#f8672f', textAlign: 'center' },
  footnote: { fontSize: 11, color: '#909599', textAlign: 'center', marginTop: 20, lineHeight: 17 },
  btn: {
    height: 46, borderRadius: 12, paddingHorizontal: 28,
    alignItems: 'center', justifyContent: 'center', marginTop: 18,
  },
  btnPrimary: { backgroundColor: '#1c1f23' },
  btnPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '500' },

  // ── 登录表单 ───────────────────────────────────────────────────────
  form: { width: '100%', maxWidth: 320, marginTop: 20, gap: 10 },
  input: {
    height: 46, borderRadius: 12, borderWidth: 1, borderColor: '#e8e8e0',
    backgroundColor: '#fff', paddingHorizontal: 14, fontSize: 15, color: '#001217',
  },
  formErr: { fontSize: 12, color: '#f8672f', lineHeight: 18 },
  linkBtn: { alignItems: 'center', paddingVertical: 10 },
  linkText: { fontSize: 13, color: '#545659', textDecorationLine: 'underline' },
  hintText: {
    fontSize: 12, color: '#909599', textAlign: 'center', lineHeight: 19, marginTop: 14,
  },
});

export { Updates };
