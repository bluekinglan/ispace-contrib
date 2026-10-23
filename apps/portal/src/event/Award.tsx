import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CURRENT_EVENT_SLUG, EVENT_PATH,
  type EventAward, type EventConfig, type EventCriterion, type EventResponse,
} from '@ispace/contracts';
import { api } from '../api';
import { EVENT_JUDGES } from './judges';
import { registerEventEffects } from './effects';
import { LotteryStage, type LotteryHandle } from './Lottery';
import {
  BinaryTen, Caret, DOTS_ON_SCREEN, DotMatrix, dots1024, EIcon, EventKeyframes, Mark,
  type EventIconName,
} from './visual';

registerEventEffects();

/**
 * 颁奖大屏（/1024/award）。1920 × 1080，投在大培训教室那块屏上。
 *
 * ┌─ 它是一场有节奏的仪式，不是一个页面 ──────────────────────────────┐
 * │ 主持人按一下走一步：开场 → 三等奖铺垫 → 揭晓 → 二等奖 … → 总览。   │
 * │ 「铺垫」那一拍是整件事的意义所在：粒子在场上游走（roam），名字还    │
 * │ 读不出来；按下去才聚拢成获奖者的名字（gather）。少了这一拍，颁奖    │
 * │ 就只是把名单念一遍。                                               │
 * │                                                                    │
 * │ 所以每个奖是**两步**而不是一步，前进/后退都要照这个粒度走。        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 顺序是三、二、一等奖——从小到大揭晓，压轴留给冠军，一等奖揭晓时放礼炮。
 * 最佳人气奖不在这条线上：它由全员投票产生，和评委打分是两回事，
 * 放在总览页一起出现。
 *
 * 操作：点击 / → / 空格 / 回车 前进，← / Backspace 后退。
 * 数据每 30 秒拉一次——颁奖前名次可能还在动（评委补交分数）。
 */

const W = 1920;
const H = 1080;

/**
 * 一步。顺序即仪式顺序：
 *
 *   背景墙 → 下午安排 → 开场 → 三等奖(铺垫/揭晓) → 二等奖 → 一等奖 → 总览
 *   → 全员抽奖 → 切蛋糕
 *
 * 背景墙放在最前面，是因为这块屏在颁奖之前就已经挂在那儿了——主持人不必
 * 先开一个别的页面再切过来，到点按一下就进下午安排。
 * 切蛋糕放在最后，16:20 那个环节直接接着用。
 *
 * 抽奖夹在总览和切蛋糕之间，和下午的流程一致（颁奖 → 抽奖 → 切蛋糕）。
 * 它和别的步骤不一样：别的步骤按一下就过，抽奖那一步要在原地按好几下
 * （开始 / 停 / 下一轮，共五轮），所以主操作会先交给它，等它说「抽完了」
 * 才继续往下走。见下面 advance()。
 */
type Step =
  | { t: 'wall' }
  | { t: 'agenda' }
  | { t: 'intro' }
  | { t: 'award'; award: EventAward; reveal: boolean }
  | { t: 'end' }
  | { t: 'lottery' }
  | { t: 'cake' };

/** 每个奖的配色。三等奖米底、二等奖墨底、一等奖橙底——越往后越亮。 */
const THEME: Record<string, {
  bg: string; dot: string; fg: string; wm: string;
  chip: string; chipFg: string; ring: string;
  panel: string; panelFg: string; panelLine: string;
}> = {
  third: {
    bg: '#fcfcf8', dot: 'rgba(0,18,23,.08)', fg: '#001217', wm: 'rgba(0,18,23,.04)',
    chip: '#001217', chipFg: '#ffffff', ring: 'rgba(251,146,60,.45)',
    panel: '#001217', panelFg: '#ffffff', panelLine: 'rgba(255,255,255,.16)',
  },
  second: {
    bg: '#001217', dot: 'rgba(255,255,255,.08)', fg: '#ffffff', wm: 'rgba(255,255,255,.05)',
    chip: '#f97316', chipFg: '#001217', ring: 'rgba(249,115,22,.5)',
    panel: 'rgba(255,255,255,.08)', panelFg: '#ffffff', panelLine: 'rgba(255,255,255,.16)',
  },
  first: {
    bg: '#fb923c', dot: '#f97316', fg: '#001217', wm: 'rgba(249,115,22,.35)',
    chip: '#001217', chipFg: '#fb923c', ring: 'rgba(255,255,255,.55)',
    panel: '#001217', panelFg: '#ffffff', panelLine: 'rgba(255,255,255,.16)',
  },
  /* 人气奖回到米底，和前三名的渐强拉开——它是另一条线上的奖 */
  popular: {
    bg: '#fcfcf8', dot: 'rgba(0,18,23,.08)', fg: '#001217', wm: 'rgba(0,18,23,.04)',
    chip: '#fb923c', chipFg: '#001217', ring: 'rgba(251,146,60,.45)',
    panel: '#001217', panelFg: '#ffffff', panelLine: 'rgba(255,255,255,.16)',
  },
};
/** 深底：开场与下午安排。亮底：背景墙、总览、切蛋糕。 */
const DARK_THEME = { bg: '#001217', dot: 'rgba(255,255,255,.08)', fg: '#ffffff', wm: 'rgba(255,255,255,.05)' };
const ORANGE_THEME = { bg: '#fb923c', dot: '#f97316', fg: '#001217', wm: 'rgba(249,115,22,.35)' };
/** 背景墙与切蛋糕上的深色，不跟随主题。 */
const INK = '#1c1f23';


/**
 * 获奖作品的编号牌。人气奖可能落到没入围、只交了作品参与投票的项目上——
 * 它没有入围编号，写「NO.null」或空着都会让台下以为大屏出错了。
 */
function noTag(no: string | null): string {
  return no ? `NO.${no}` : '未入围作品';
}

const AWARD_META: Record<string, { en: string; rankCn: string; icon: EventIconName; wm: string }> = {
  third: { en: 'THIRD PRIZE', rankCn: '三', icon: 'award', wm: '03' },
  second: { en: 'SECOND PRIZE', rankCn: '二', icon: 'medal', wm: '02' },
  first: { en: 'FIRST PRIZE', rankCn: '一', icon: 'trophy', wm: '01' },
  popular: { en: "PEOPLE'S CHOICE", rankCn: '', icon: 'heart', wm: '♥' },
};

/**
 * 揭晓顺序：三 → 二 → 一 → 人气。
 *
 * 人气奖压在冠军**之后**：它不是「第四名」，是另一条线上评出来的
 * （全员投票，且与前三名互斥），放在最后收尾比夹在中间顺。
 */
const CEREMONY_KEYS = ['third', 'second', 'first', 'popular'] as const;

export function Award() {
  const [data, setData] = useState<EventResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [scale, setScale] = useState(1);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    const pull = () => void api.event(CURRENT_EVENT_SLUG)
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : '拿不到获奖名单'));
    pull();
    const t = setInterval(pull, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = '#000';
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.background = prev; document.body.style.overflow = ''; };
  }, []);

  const awards = data?.awards ?? null;
  const criteria = data?.event.config.criteria ?? [];
  /* 人气奖那块面板画的是得票榜前四。票数只在结果公布后才下发。 */
  const voteBoard = useMemo(
    () => [...(data?.finalists ?? [])]
      .map((f) => ({ name: f.name, votes: f.votes ?? 0 }))
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 4),
    [data?.finalists],
  );

  /** 开场 + 每个奖两步 + 总览。 */
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [{ t: 'wall' }, { t: 'agenda' }, { t: 'intro' }];
    for (const key of CEREMONY_KEYS) {
      const a = awards?.find((x) => x.key === key);
      if (!a) continue;
      out.push({ t: 'award', award: a, reveal: false });
      out.push({ t: 'award', award: a, reveal: true });
    }
    out.push({ t: 'end' }, { t: 'lottery' }, { t: 'cake' });
    return out;
  }, [awards]);

  const clamp = useCallback(
    (n: number) => Math.max(0, Math.min(steps.length - 1, n)),
    [steps.length],
  );

  const lottery = useRef<LotteryHandle>(null);
  /** 当前这一步是不是抽奖。用 ref 读，免得把它塞进键盘 effect 的依赖里反复重挂。 */
  const onLottery = useRef(false);
  onLottery.current = steps[at]?.t === 'lottery';

  /*
    前进 / 后退。

    抽奖那一步自己要吃掉好几下按键（开始、停、下一轮…），所以先问它：
    它返回 true 表示「这一下我用了」，返回 false 才轮到典礼往下走一步。
    后退同理——在抽奖里先退轮次，退到第一轮才退出这一屏。
  */
  const advance = useCallback(() => {
    if (onLottery.current && lottery.current?.primary()) return;
    setAt((n) => clamp(n + 1));
  }, [clamp]);
  const retreat = useCallback(() => {
    if (onLottery.current && lottery.current?.back()) return;
    setAt((n) => clamp(n - 1));
  }, [clamp]);

  /*
    浏览器全屏（演示模式）。

    舞台本身是 position:fixed 铺满的，但那只铺满「浏览器窗口」——标签栏、
    地址栏、书签栏是浏览器的，网页藏不掉。主持人按 ⌃⌘F 进全屏也不一定
    干净：Mac 上的 Chrome 默认「全屏时始终显示工具栏」，地址栏照样挂着。
    requestFullscreen 走的是另一条路（和看视频点全屏一样），所有工具栏都会
    收起，不受那个勾选影响。

    必须由一次按键或点击触发（浏览器要求用户手势），所以不能进页面就自动全屏。
  */
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  /*
    右下角那颗按钮：鼠标一动就出来，停 2.5 秒就隐身。投在大屏上时主持人的
    指针多半不动，屏幕上就不会挂着一颗按钮。
  */
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    let t = window.setTimeout(() => setAwake(false), 2500);
    const poke = () => {
      setAwake(true);
      window.clearTimeout(t);
      t = window.setTimeout(() => setAwake(false), 2500);
    };
    window.addEventListener('mousemove', poke);
    return () => { window.removeEventListener('mousemove', poke); window.clearTimeout(t); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* F 切全屏。带修饰键的放过：⌘F 是浏览器的查找 */
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); toggleFs(); return;
      }
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault(); advance();
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault(); retreat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, retreat, toggleFs]);

  // 键盘要能用，焦点就得在舞台上；主持人多半是点一下然后用遥控笔翻页
  useEffect(() => { stage.current?.focus(); }, []);

  if (err) {
    return (
      <Fullscreen>
        <p style={{ color: '#fff', fontSize: 24 }}>{err}</p>
        <a href={EVENT_PATH} style={{ color: '#fb923c', fontSize: 18 }}>回活动页</a>
      </Fullscreen>
    );
  }
  if (!data) return <Fullscreen><p style={{ color: 'rgba(255,255,255,.6)', fontSize: 22 }}>正在取获奖名单…</p></Fullscreen>;
  if (!awards?.length) {
    /*
      名单对外 15:10 才公布，但组织者在打分锁定、人气投票截止之后就能提前
      拿到（服务端 canPreviewAwards）。提前进要登录——投屏那台机器多半没
      登录，所以没登录时给一颗登录按钮，登完回到这一页。
    */
    const d = data.event.config.deadlines;
    const at = (iso?: string) => (iso ? new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso)) : '');
    /* 打分锁定和人气投票截止，取更晚的那个——和服务端放开的时刻一致 */
    const openAt = [d.judgeLock, d.vote]
      .filter((x): x is string => !!x)
      .reduce<string | undefined>((a, b) => (!a || Date.parse(b) > Date.parse(a) ? b : a), undefined);
    return (
      <Fullscreen>
        <p style={{ color: '#fff', fontSize: 28, fontWeight: 700 }}>获奖名单还没出来</p>
        <p style={{ color: 'rgba(255,255,255,.6)', fontSize: 18, lineHeight: 1.8, textAlign: 'center' }}>
          {at(d.award)} 颁奖时对所有人开放。<br />
          {openAt ? `组织者在 ${at(openAt)} 评分和投票都截止后，登录即可提前进入。` : ''}
        </p>
        {!data.me && (
          <button
            type="button"
            onClick={() => { location.href = `/?redirect=${encodeURIComponent(location.pathname)}`; }}
            style={{
              marginTop: 8, height: 44, padding: '0 28px', borderRadius: 100, border: 'none',
              background: '#fb923c', color: '#001217', fontSize: 16, fontWeight: 700, cursor: 'pointer',
            }}
          >组织者登录</button>
        )}
      </Fullscreen>
    );
  }

  const step = steps[clamp(at)]!;
  const theme = step.t === 'intro' || step.t === 'agenda' || step.t === 'lottery' ? DARK_THEME
    : step.t === 'wall' || step.t === 'end' || step.t === 'cake' ? ORANGE_THEME
    : THEME[step.award.key] ?? THEME.third!;
  /* 背景墙和切蛋糕是完整的一张画，顶上那条面包屑会碍事 */
  /* 抽奖自带顶栏（轮次胶囊 + 名单），再叠一条面包屑就重了 */
  const topOn = step.t !== 'wall' && step.t !== 'cake' && step.t !== 'lottery';
  const isReveal = step.t === 'award' && step.reveal;
  const isChampionReveal = isReveal && step.t === 'award' && step.award.key === 'first';

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <EventKeyframes />
      <button
        type="button"
        onClick={toggleFs}
        aria-label={fs ? '退出全屏' : '全屏'}
        style={{
          position: 'absolute', right: 16, bottom: 16, zIndex: 100,
          height: 34, padding: '0 14px', borderRadius: 100, cursor: 'pointer',
          border: '1px solid rgba(255,255,255,.28)', background: 'rgba(0,18,23,.72)',
          color: '#fff', fontSize: 13, fontWeight: 600,
          opacity: awake ? 1 : 0, pointerEvents: awake ? 'auto' : 'none',
          transition: 'opacity .3s ease',
        }}
      >
        {fs ? '退出全屏 · Esc' : '全屏 · F'}
      </button>
      <div
        ref={stage}
        id="award-screen"
        tabIndex={0}
        role="button"
        aria-label="颁奖大屏，点击或按右方向键继续"
        onClick={advance}
        style={{
          position: 'absolute', left: '50%', top: '50%',
          width: W, height: H,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center',
          boxSizing: 'border-box', overflow: 'hidden', cursor: 'pointer', outline: 'none',
          backgroundColor: theme.bg,
          backgroundImage: `radial-gradient(${theme.dot} 1.5px, transparent 1.5px)`,
          backgroundSize: '26px 26px',
          color: theme.fg,
          fontFamily: 'var(--font-sans)',
          // 奖项之间换底色：慢一点，像灯光转场
          transition: 'background-color .6s ease, color .6s ease',
        }}
      >
        {/* 背景大字：铺垫时是奖次，揭晓后换成作品编号。抽奖那屏自己铺满，不要它 */}
        {step.t !== 'lottery' && <span aria-hidden="true" className="mono" style={{
          position: 'absolute', right: -70, bottom: -230, fontWeight: 800, fontSize: 1180,
          lineHeight: 1, letterSpacing: '-.08em', color: theme.wm,
          whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
        }}>
          {step.t === 'award'
            ? (step.reveal ? step.award.no ?? '1024' : AWARD_META[step.award.key]?.wm ?? '1024')
            : '1024'}
        </span>}

        {/* 顶栏。背景墙与切蛋糕自带完整版式，不要这条。 */}
        {topOn && (
          <div style={{
            position: 'absolute', left: 96, right: 96, top: 72,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
          }}>
            {/*
              左边一整条：点阵 1024 + 活动名 + 现在走到哪一步。稿上活动名在
              左、步骤在右，但右上角整场都留给 iSpace——背景墙、开场墙、切
              蛋糕本来就是这样，颁奖这几屏跟着统一，不然一场里标志会跳来跳去。
              所以步骤跟到活动名后面：两者都是「这是什么」，本来就该挨着。
            */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div role="img" aria-label="1024" style={{
                display: 'grid', gridTemplateColumns: 'repeat(23, 5px)', gap: 1,
              }}>
                {dots1024(DOTS_ON_SCREEN).map((d, i) => (
                  <span key={i} style={{
                    width: 5, height: 5, borderRadius: 1, background: theme.fg,
                    opacity: d.bg === DOTS_ON_SCREEN.off ? 0.28 : 1,
                  }} />
                ))}
              </div>
              <span style={{ width: 1, height: 28, background: theme.fg, opacity: 0.3 }} />
              <span style={{ fontSize: 24, fontWeight: 700 }}>第 8 届程序员节 · 1024·AI创新赛</span>
              <span style={{ width: 1, height: 28, background: theme.fg, opacity: 0.3 }} />
              <span style={{ fontSize: 20, fontWeight: 600, opacity: 0.75 }}>
                {step.t === 'agenda' ? '下午安排'
                  : step.t === 'intro' ? '颁奖典礼'
                  : step.t === 'end' ? '获奖名单'
                  : step.t === 'award'
                    ? `${step.award.name} · ${step.reveal ? noTag(step.award.no) : '即将揭晓'}`
                    : ''}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Mark size={40} tone={theme.fg === '#ffffff' ? 'orange' : 'dark'} />
              <span style={{
                fontFamily: 'var(--font-sans)', fontSize: 28, fontWeight: 800, letterSpacing: '-.03em',
              }}>iSpace</span>
            </div>
          </div>
        )}

        {step.t === 'wall' && <Backdrop edition={data.event.edition} title={data.event.title} subtitle={data.event.subtitle} />}
        {step.t === 'agenda' && <Agenda cfg={data.event.config} now={data.event.now} />}
        {step.t === 'cake' && <Cake step={at} />}
        {step.t === 'lottery' && <LotteryStage ref={lottery} />}
        {step.t === 'intro' && (
          <Intro
            fg={theme.fg}
            /* 稿上是「10.23 · 大培训教室 · 15:10」，三段都从活动数据来 */
            when={[
              mdOf(data.event.config.deadlines.award),
              (data.event.venue ?? '').split(' · ').pop(),
              hmOf(data.event.config.deadlines.award),
            ].filter(Boolean).join(' · ')}
            finalistCount={data.finalists.length}
            /* 与活动页、腰带一致：人数取固定名册，不看后台此刻配了几个 */
            judgeCount={EVENT_JUDGES.length}
          />
        )}
        {step.t === 'award' && (
          <AwardStage
            award={step.award}
            reveal={step.reveal}
            criteria={criteria}
            theme={THEME[step.award.key] ?? THEME.third!}
            voteTotal={data.stats.voteTotal}
            voteBoard={voteBoard}
          />
        )}
        {step.t === 'end' && <Summary awards={awards} judgeCount={EVENT_JUDGES.length} />}

        {/* 一等奖揭晓放礼炮。key 带上步数，退回去再进来会重新放。 */}
        {isChampionReveal && (
          <confetti-burst
            key={`confetti-${at}`}
            palette="#ffffff,#001217,#38bdf8,#f472b6,#facc15,#4ade80,#a78bfa"
            style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          />
        )}

        {/*
          这里原先有一条进度条和一句「点击或按 → 继续」，都去掉了：稿上
          1920×1080 这块画面里没有它们——设计稿里那排步骤胶囊和进度条是
          原型外壳上的东西，是给看稿的人切屏用的，不在投出去的画面里。

          投到会议室那块屏上的每一个像素都是给台下看的，操作提示是给主持
          人一个人看的。主持人手里有翻页笔，他知道怎么翻；台下不需要知道
          这一场还剩几页。抽奖那一步是例外，它自己左下角留了键位说明——
          那一步要在原地按好几下，不说清楚主持人会卡住。
        */}
      </div>
    </div>
  );
}

// ── 背景墙 / 切蛋糕：整屏的一张画 ─────────────────────────────────────

/**
 * 背景墙与切蛋糕共用的外框：左上角公司图标 + 届次，右上角 iSpace。
 *
 * 和 /1024/screen 那一页是同一套视觉，但这里是仪式里的一步：居中排版、
 * 没有底部那行活动信息，因为紧接着就要翻页了。
 */
function WallFrame({ edition, children, solid = false }: {
  edition: string | null;
  children: React.ReactNode;
  /**
   * 把外框这几件东西标成 confetti-pile 的地面（切蛋糕那一屏用）。
   *
   * 只有切蛋糕下雪，背景墙不下，所以默认关着——给背景墙也挂上
   * data-solid 不会出错，但那是写给读代码的人看的假线索。
   */
  solid?: boolean;
}) {
  return (
    <>
      <span aria-hidden="true" style={{
        position: 'absolute', left: -200, top: 540, width: 640, height: 640,
        borderRadius: '50%', border: '16px solid rgba(249,115,22,.35)',
        boxSizing: 'border-box', pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', inset: 0, boxSizing: 'border-box',
        padding: '80px 96px', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <img
              src="/event-icon.png"
              alt=""
              data-solid={solid ? '0' : undefined}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              style={{ width: 68, height: 68, borderRadius: 18, display: 'block' }}
            />
            <span className="mono" data-solid={solid ? '0' : undefined} style={{
              background: INK, color: '#fff', borderRadius: 100,
              padding: '10px 22px', fontSize: 24, fontWeight: 700,
            }}>{edition ?? '第 8 届 · 2026'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Mark size={44} tone="dark" solid={solid} />
            <span data-solid={solid ? 'text' : undefined} style={{
              fontFamily: 'var(--font-sans)', fontSize: 32, fontWeight: 800, letterSpacing: '-.03em',
            }}>iSpace</span>
          </div>
        </div>
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 28, paddingBottom: 40,
        }}>
          {children}
        </div>
      </div>
    </>
  );
}

/** 开场前挂着的背景墙。主持人到点按一下就往下走。 */
function Backdrop({ edition, title, subtitle }: {
  edition: string | null; title: string; subtitle: string | null;
}) {
  return (
    <WallFrame edition={edition}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 40 }}>
        <div style={{ padding: '0 0 10px' }}>
          <DotMatrix size={30} gap={7} radius={7} palette={DOTS_ON_SCREEN} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 10 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <BinaryTen size={26} gap={8} color={INK} />
            <span className="mono" style={{ fontSize: 28, fontWeight: 700 }}>= 2¹⁰ = 0x400</span>
          </span>
          <span style={{
            fontSize: 168, fontWeight: 900, lineHeight: 1,
            letterSpacing: '-.02em', whiteSpace: 'nowrap',
          }}>{title}<Caret color={INK} /></span>
        </div>
      </div>
      <span style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.2, textAlign: 'center' }}>
        {subtitle ?? '灵感上线・AI 不设限'}
      </span>
    </WallFrame>
  );
}

/**
 * 切蛋糕。16:20 那个环节直接停在这一屏。
 *
 * 版面是整屏一张画：一个放大的 1024 点阵，底下一行字两端对齐到点阵的
 * 宽度。没有标题、没有时间地点——这一屏挂着的时候人都在蛋糕那边，屏幕
 * 是背景板不是说明书，字越少越像块装饰。
 *
 * 雪用 confetti-pile 而不是 confetti-burst：它会**堆**在点阵的每个方块
 * 和每一笔字上，越堆越厚。这一屏要挂十几分钟给大家拍照，堆积能一直长，
 * 而下雨只是一直重复同一秒。
 */
function Cake({ step }: { step: number }) {
  return (
    <>
      <WallFrame edition={null} solid>
        {/* 这一层收成点阵的宽度，下面那行字才有「两端对齐到点阵」的参照 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <DotMatrix size={56} gap={13} radius={13} palette={DOTS_ON_SCREEN} solid />
          <span data-solid="text" style={{
            fontSize: 72, fontWeight: 800, lineHeight: 1.2,
            textAlign: 'justify', textAlignLast: 'justify',
          }}>
            1024 主题蛋糕 · 全体大合影
          </span>
        </div>
      </WallFrame>
      {/*
        放在 WallFrame 后面：雪要盖在点阵和字的上面。
        key 跟着 step 走，翻回这一屏就重新开始积。
      */}
      <confetti-pile
        key={`cake-${step}`}
        scope="#award-screen"
        rate="180"
        palette="#ffffff,#001217,#38bdf8,#f472b6,#facc15,#4ade80,#a78bfa"
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
    </>
  );
}

// ── 下午安排 ──────────────────────────────────────────────────────────

/**
 * 下午流程表，开场前过一屏。
 *
 * 条目取自 config.schedule 的最后一组（下午那一场），不另写一份——
 * 活动页上显示的就是它，两处同源才不会出现「大屏写 15:30、手机写 15:00」。
 *
 * 「即将开始」标在第一条还没到点的上面，按服务端的 now 算。设计稿里那是
 * 写死的第二条，那只是稿子里的演示值。
 */
function Agenda({ cfg, now }: { cfg: EventConfig; now: string }) {
  const block = cfg.schedule[cfg.schedule.length - 1];
  if (!block) return null;

  /* 把 "15:30" 按活动当天的日期还原成时刻，用来找下一项 */
  const day = cfg.deadlines.award.slice(0, 10);
  const tz = cfg.deadlines.award.slice(-6);
  const at = (hhmm: string) => Date.parse(`${day}T${hhmm}:00${tz}`);
  const t = Date.parse(now);
  const nextIdx = block.rows.findIndex((r) => at(r.time) >= t);

  return (
    <div style={{
      position: 'absolute', inset: 0, boxSizing: 'border-box',
      padding: '150px 96px 72px', display: 'flex', alignItems: 'stretch', gap: 72,
    }}>
      <div style={{
        flex: 'none', width: 520, display: 'flex',
        flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <span className="mono" style={{
            fontSize: 24, fontWeight: 700, letterSpacing: '.14em', opacity: 0.8,
            animation: 'awardRise .7s cubic-bezier(.16,1,.3,1) both',
          }}>{block.time.split('·').pop()?.trim() ?? ''}</span>
          <span style={{
            fontSize: 112, fontWeight: 900, lineHeight: 1.05, letterSpacing: '-.02em',
            animation: 'awardRise .7s cubic-bezier(.16,1,.3,1) .1s both',
          }}>下午<br />节日狂欢</span>
          <span className="mono" style={{
            fontSize: 44, fontWeight: 700, color: '#fb923c',
            animation: 'awardRise .7s cubic-bezier(.16,1,.3,1) .2s both',
          }}>{block.time.split('·')[0]?.trim() ?? ''}</span>
        </div>
        <span style={{
          fontSize: 26, fontWeight: 600, lineHeight: 1.5, opacity: 0.7,
          animation: 'awardRise .7s cubic-bezier(.16,1,.3,1) .3s both',
        }}>凭号码牌抽奖、兑奖 · 实习生有单独伴手礼</span>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {block.rows.map((r, i) => (
          <div key={`${r.time}${r.title}`} style={{
            display: 'flex', alignItems: 'center', gap: 36, padding: '22px 0',
            animation: 'awardRise .6s cubic-bezier(.16,1,.3,1) both',
            animationDelay: `${120 + i * 90}ms`,
          }}>
            <span className="mono" style={{
              width: 140, flex: 'none', fontSize: 40, fontWeight: 700, color: '#fb923c',
            }}>{r.time}</span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ fontSize: 38, fontWeight: 800, lineHeight: 1.1 }}>{r.title}</span>
                {i === nextIdx && (
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: 8, borderRadius: 100,
                    padding: '5px 14px', background: '#fb923c', color: '#001217',
                    fontSize: 18, fontWeight: 700,
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: 100, background: '#001217' }} />
                    即将开始
                  </span>
                )}
              </span>
              <span style={{ fontSize: 24, lineHeight: 1.4, opacity: 0.7 }}>{r.desc}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 10.23 */
function mdOf(iso: string): string {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('month')}.${g('day')}`;
}

/** 15:10 */
function hmOf(iso: string): string {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('hour')}:${g('minute')}`;
}

// ── 开场 ──────────────────────────────────────────────────────────────

function Intro({ fg, when, finalistCount, judgeCount }: {
  fg: string; when: string; finalistCount: number; judgeCount: number;
}) {
  return (
    <div style={{
      position: 'absolute', left: 96, top: 0, bottom: 0, right: 96,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 28,
    }}>
      <span className="mono" style={{ fontSize: 32, fontWeight: 700, opacity: 0.7 }}>
        {when}
      </span>
      <span style={{ fontSize: 180, fontWeight: 900, lineHeight: 1, letterSpacing: '-.02em' }}>
        颁奖典礼<Caret color={fg} />
      </span>
      <span style={{ fontSize: 64, fontWeight: 800, opacity: 0.85 }}>1024·AI创新赛</span>
      <span style={{ fontSize: 28, opacity: 0.6, marginTop: 8 }}>
        {finalistCount} 件入围作品 · {judgeCount} 位评委 · 三个奖项依次揭晓
      </span>
    </div>
  );
}

// ── 单个奖项 ──────────────────────────────────────────────────────────

function AwardStage({
  award, reveal, criteria, theme, voteTotal, voteBoard,
}: {
  award: EventAward;
  reveal: boolean;
  criteria: EventCriterion[];
  theme: NonNullable<(typeof THEME)[string]>;
  /** 全场总票数，人气奖那块面板的分母 */
  voteTotal: number;
  /** 按票数排的作品榜，人气奖用它画横条 */
  voteBoard: { name: string; votes: number }[];
}) {
  const meta = AWARD_META[award.key];
  /*
    人气奖是另一套度量：没有评委分，只有票。所以面板里的标题、单位、
    那四条横条全都要换——横条画的是得票榜，不是评分维度。
  */
  const isPop = award.judgeScore == null;
  const topVotes = voteBoard[0]?.votes ?? 0;
  return (
    <>
      {/*
        奖次。铺垫与揭晓是**两种版式**，不是同一块东西缩放：

        铺垫时它就是整屏——奖名 200px、金额 120px，照设计稿。这一屏上没有
        获奖者的任何信息，大字就是全部内容，台下在这几秒里只看得到「要发
        什么奖」。字小了这一拍就撑不住，会显得只是在等下一页。

        揭晓后缩成左上角一行（奖名 40px），版面让给粒子聚出来的名字。
      */}
      <div style={{
        position: 'absolute', left: 96, top: reveal ? 228 : 324,
        display: 'flex', flexDirection: 'column',
        transition: 'top .5s cubic-bezier(.16,1,.3,1)',
      }}>
        {reveal ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 56, height: 56, borderRadius: 16,
              background: theme.chip, color: theme.chipFg, flex: 'none',
            }}>
              <EIcon name={meta?.icon ?? 'award'} size={28} />
            </span>
            <span style={{ fontSize: 40, fontWeight: 800, lineHeight: 1 }}>{award.name}</span>
            <span className="mono" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1 }}>
              {award.money}
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 46, marginBottom: 10 }}>
              <EIcon name={meta?.icon ?? 'award'} size={34} />
              <span className="mono" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '.08em' }}>
                {meta?.en}
              </span>
            </div>
            <span style={{
              fontSize: 200, fontWeight: 900, lineHeight: 1, letterSpacing: '-.04em', whiteSpace: 'nowrap',
            }}>{award.name}</span>
            {/*
              金额和这一句并排。稿上这句紧跟在金额右边、与它的底边对齐——
              人气奖那句是真有信息量的：它交代了「与一二三等奖互斥」，
              否则台下会以为票王就该是冠军。
            */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, marginTop: 42 }}>
              <span className="mono" style={{ fontSize: 120, fontWeight: 800, lineHeight: 1 }}>
                {award.money}
              </span>
              <span style={{ fontSize: 32, fontWeight: 600, opacity: 0.8 }}>
                {isPop
                  ? `京东卡 + 奖杯 · 全员 ${voteTotal} 票选出 · 与一二三等奖互斥`
                  : `现金 + 奖杯 · 1 名 · 评委打分第${meta?.rankCn ?? ''}`}
              </span>
            </div>
          </>
        )}
      </div>

      {/*
        粒子文字。mode 由 reveal 驱动：roam（游走，读不出）→ gather（聚拢成名字）。
        这是整场仪式的那一拍，别图省事换成淡入。
      */}
      <particle-text
        key={award.key}
        text={award.who}
        initial={award.who.charAt(0)}
        ink={theme.fg}
        disc={theme.chip}
        discink={theme.chipFg}
        mode={reveal ? 'gather' : 'roam'}
        left="96"
        top="390"
        width="1150"
        height="380"
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />

      {/*
        名字底下那一行。稿上这里只有这一句——作品叫什么、是干嘛的，全都在
        右边那块面板里，不在这儿重复一遍。左半屏从上到下是「奖次 → 名字 →
        这一句」，三样东西，看得过来。
      */}
      <div style={{
        position: 'absolute', left: 96, top: 780, right: 640,
        opacity: reveal ? 1 : 0,
        transform: reveal ? 'none' : 'translateY(16px)',
        /*
          延迟只在**进场**时给。写成固定的 `.9s` 延迟，离场也会照延 0.9 秒：
          从三等奖揭晓翻到二等奖铺垫时，这块已经换成二等奖的内容了却还挂
          在屏上，等于在揭晓前先把下一个奖的获奖者报了出去。
        */
        transition: reveal
          ? 'opacity .6s ease .9s, transform .6s ease .9s'
          : 'opacity .15s ease, transform .15s ease',
        pointerEvents: 'none',
      }}>
        <span style={{ display: 'block', fontSize: 30, fontWeight: 600, opacity: 0.75 }}>
          恭喜 {award.who} ·{' '}
          {award.no ? <>入围编号 NO.{award.no} ·{' '}</> : '未入围作品 ·\u00a0'}
          {isPop ? `全员投票 ${award.votes} 票` : `评委打分第${meta?.rankCn ?? ''}`}
        </span>
      </div>

      {/*
        右侧面板。两种度量各画各的：
          评委奖   —— 平均分 + 四个评分维度
          人气奖   —— 得票数 + 得票榜前几名的横条
        共用同一块版面，所以位置、动画延迟都一样，切换时不会跳。
      */}
      <div style={{
        position: 'absolute', right: 96, top: 226, width: 524,
        background: theme.panel, color: theme.panelFg,
        borderRadius: 24, padding: '28px 32px',
        display: 'flex', flexDirection: 'column', gap: 28,
        opacity: reveal ? 1 : 0,
        transform: reveal ? 'none' : 'translateX(24px)',
        /* 同上：进场留延迟，离场立刻收，别把下一个奖的作品提前亮出来 */
        transition: reveal
          ? 'opacity .6s ease 1.1s, transform .6s ease 1.1s'
          : 'opacity .15s ease, transform .15s ease',
        pointerEvents: 'none',
      }}>
        {/* 作品：编号、名字、一句话。稿上它们在这块面板顶上，和分数同属一栏 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="mono" style={{ fontSize: 16, fontWeight: 700, opacity: 0.6 }}>
            获奖作品 · {noTag(award.no)}
          </span>
          <span style={{ fontSize: 44, fontWeight: 900, lineHeight: 1.1 }}>{award.ideaName}</span>
          {/*
            最多 5 行。介绍是作者自己填的，长短没人管——本届人气奖那件写了
            三百多字，17 行把面板撑出屏幕，底下的票数整块看不见。5 行是评委
            奖里最长那段的行数，所以只截超长的，正常长度的一个字都不少。
          */}
          <span style={{
            fontSize: 21, fontWeight: 500, lineHeight: 1.5, opacity: 0.72,
            display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 5, overflow: 'hidden',
          }}>
            {award.desc}
          </span>
        </div>
        <div style={{ height: 1, background: theme.panelLine }} />

        {/* 分数左对齐、单独起一行。稿上它和作品名、维度条共用同一条左边线 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 16, fontWeight: 700, opacity: 0.6 }}>
            {isPop ? '全员投票' : '评委综合分'}
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
            <span className="mono" style={{ fontSize: 88, fontWeight: 800, lineHeight: 1 }}>
              {isPop ? award.votes : award.judgeScore!.toFixed(1)}
            </span>
            <span className="mono" style={{ fontSize: 28, fontWeight: 600, opacity: 0.5 }}>
              {isPop ? `票 / ${voteTotal}` : '/ 100'}
            </span>
          </div>
        </div>
        <div style={{ height: 1, background: theme.panelLine }} />

        {/* 横条。稿上四行等距 48px，所以这里用固定 gap，不跟外层面板的 gap 走 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {isPop
          ? voteBoard.map((w) => (
              <div key={w.name} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{
                    fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{w.name}</span>
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 17, fontWeight: 700 }}>{w.votes} 票</span>
                </div>
                <div style={{ height: 8, borderRadius: 100, background: theme.panelLine, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 100, background: '#fb923c',
                    /* 相对票王而不是总票数——否则八件作品的条都短得看不出差别 */
                    width: topVotes > 0 ? `${Math.round((w.votes / topVotes) * 100)}%` : '0%',
                    transition: 'width .8s cubic-bezier(.16,1,.3,1) 1.3s',
                  }} />
                </div>
              </div>
            ))
          : criteria.map((c, i) => {
              const v = award.dims?.[i];
              return (
                <div key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span style={{ fontSize: 17 }}>{c.key}</span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 17, fontWeight: 700 }}>
                      {v == null ? '—' : v.toFixed(1)} / {c.max}
                    </span>
                  </div>
                  <div style={{ height: 8, borderRadius: 100, background: theme.panelLine, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 100, background: '#fb923c',
                      width: v == null ? '0%' : `${Math.round((v / c.max) * 100)}%`,
                      transition: 'width .8s cubic-bezier(.16,1,.3,1) 1.3s',
                    }} />
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </>
  );
}

// ── 总览 ──────────────────────────────────────────────────────────────

/** 领奖台：一等奖最高居中，二等奖次之，三等奖最矮；人气奖单列一张卡。 */
/**
 * 总览：四个奖并排。
 *
 * 人气奖从「下面单独一条」并进了这一排——它已经在前面单独揭晓过，
 * 这里和前三名同级陈列即可。度量各用各的：评委奖是分，人气奖是票。
 */
function Summary({ awards, judgeCount }: { awards: EventAward[]; judgeCount: number }) {
  /* 左到右：二、一、三、人气。冠军居中偏左，视觉重心在它身上。 */
  const row = (['second', 'first', 'third', 'popular'] as const)
    .map((k) => awards.find((a) => a.key === k))
    .filter((a): a is EventAward => !!a);

  const H_BY_KEY: Record<string, number> = { first: 360, second: 300, third: 260, popular: 260 };
  const BG: Record<string, { bg: string; fg: string }> = {
    first: { bg: '#001217', fg: '#ffffff' },
    second: { bg: 'rgba(0,18,23,.08)', fg: '#001217' },
    third: { bg: '#ffffff', fg: '#001217' },
    popular: { bg: '#ffffff', fg: '#001217' },
  };

  return (
    <div style={{
      position: 'absolute', left: 96, right: 96, top: 170, bottom: 110,
      display: 'flex', flexDirection: 'column', gap: 28,
    }}>
      <span style={{ fontSize: 72, fontWeight: 900, lineHeight: 1 }}>本届获奖作品</span>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
        {row.map((a, i) => {
          const tone = BG[a.key] ?? BG.third!;
          const isPop = a.judgeScore == null;
          return (
            <div key={a.key} style={{
              flex: 1, minWidth: 0, height: H_BY_KEY[a.key] ?? 260,
              background: tone.bg, color: tone.fg, borderRadius: 24,
              padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 10,
              animation: 'commit .5s cubic-bezier(.16,1,.3,1) both',
              animationDelay: `${i * 120}ms`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {isPop && <EIcon name="heart" size={24} />}
                <span style={{ fontSize: 26, fontWeight: 800 }}>{a.name}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 22, opacity: 0.7 }}>{a.money}</span>
              </div>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 18, opacity: 0.55 }}>{noTag(a.no)}</span>
              <span style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.15 }}>{a.ideaName}</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 24, opacity: 0.8 }}>{a.who}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 26, fontWeight: 700 }}>
                  {isPop ? `${a.votes} 票` : a.judgeScore!.toFixed(1)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <span style={{ fontSize: 28, fontWeight: 600, opacity: 0.75 }}>
        入围奖随后颁发 · 感谢 {judgeCount} 位评委和所有参赛同事
      </span>
    </div>
  );
}

function Fullscreen({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#001217',
      display: 'grid', placeItems: 'center', gap: 16,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <Mark size={56} />
        {children}
      </div>
    </div>
  );
}
