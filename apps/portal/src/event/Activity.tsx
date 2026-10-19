import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CURRENT_EVENT_SLUG, EVENT_PATH, phaseAtLeast,
  type App as AppEntity, type EventConfig, type EventFile, type EventFinalist,
  type EventPhase, type EventResponse,
} from '@ispace/contracts';
import { Avatar, Badge, Button, GlobalKeyframes, Input, Tabs, Toast, ToneProvider } from '@ispace/ui';
import { api } from '../api';
import { BitField } from './BitField';
import { EVENT_JUDGES, judgeAvatar } from './judges';
import { EventLayoutStyles } from './styles';
import {
  BinaryTen, Caret, DOTS_ON_ORANGE, DotMatrix, EIcon, EventKeyframes,
  Mark, SectionHead, type EventIconName,
} from './visual';

/**
 * 1024 程序员节的活动详情页（/1024）。
 *
 * ┌─ 免登录是这一页的设计前提 ────────────────────────────────────────┐
 * │ 横幅会被转发到群里，点进来的人可能根本没登录过 iSpace。先让他看见     │
 * │ 「这是什么、怎么参加、有什么奖」，比先让他看见登录框对。            │
 * │                                                                    │
 * │ 所以：整页由一个免登录的接口驱动（GET /events/:slug，服务端用        │
 * │ optionalAuth），`data.me` 为 null 时页面完整显示，只有「我的状态」    │
 * │ 那一格换成一句引导。**只有按下底部那颗按钮时才跳登录**，登完回到      │
 * │ 这一页继续。                                                        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 一页四态：报名中 / 入围制作 / 展示答辩 / 结果公布，由服务端解析出的
 * phase 决定显示哪几段、底部栏长什么样。阶段是服务端按截止时间算的——
 * 把 10.19 12:00 的截止交给浏览器本地时钟，等于把表往前拨就能接着改。
 */

/**
 * 内容最大宽度，与样式表里 `.ev-page` 的一致——底部固定栏要和内容对齐。
 *
 * 这一页不再是固定宽的手机列：设计师这版给了四列 / 三列领奖台 / 两栏日程，
 * 宽屏要撑开才成立，窄屏由 styles.tsx 的断点逐级塌成一列。
 */
const COL = 1120;

/**
 * 交创意 / 交作品那两个底部弹层的宽度。
 *
 * 不跟 COL 走：弹层是一张表单，拉到 1120 宽之后每行输入框横跨整个屏幕，
 * 读起来反而费劲。表单该窄。
 */
const SHEET = 560;

/** 页内小节的锚点。hero 的次按钮靠它滚过去。 */
const SEC = {
  works: 'ev-sec-works',
  results: 'ev-sec-results',
  rules: 'ev-sec-rules',
  awards: 'ev-sec-awards',
  schedule: 'ev-sec-schedule',
} as const;

/** 报名要身份。登完回到这一页——portal 根路径认 ?redirect= 且只放行站内路径。 */
function gotoLogin(): void {
  location.href = `/?redirect=${encodeURIComponent(location.pathname)}`;
}

const TZ = 'Asia/Shanghai';

/** 10.19 */
function fmtMd(iso: string): string {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit' })
    .formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('month')}.${get('day')}`;
}

/** 10.19 12:00 */
function fmtMdHm(iso: string): string {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${fmtMd(iso)} ${hm}`;
}

/** 12:00 */
function fmtHm(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

/**
 * 还有几天。向上取整，且不为负。
 *
 * 以服务端的 `now` 为基准而不是 Date.now()：这一行显示的是「还剩几天」，
 * 和服务端判截止用的是同一个时钟才不会出现「页面说还有 1 天、提交却被拒」。
 */
function daysUntil(nowIso: string, targetIso: string): number {
  return Math.max(0, Math.ceil((Date.parse(targetIso) - Date.parse(nowIso)) / 86_400_000));
}

const STEP_NAMES = ['交创意', '评委初筛', '入围制作', '展示答辩'];

/** 当前走到第几步。result 之后四步全亮。 */
function stepIndex(phase: EventPhase): number {
  return phase === 'signup' ? 0
    : phase === 'screening' ? 1
    : phase === 'building' ? 2
    : 3;
}

export function Activity() {
  const [data, setData] = useState<EventResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: 'info' | 'error' } | null>(null);
  const [sheet, setSheet] = useState<'idea' | 'work' | null>(null);

  const say = useCallback((msg: string, tone: 'info' | 'error' = 'info') => {
    setToast({ msg, tone });
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await api.event(CURRENT_EVENT_SLUG));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '活动信息拿不到');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /*
    首页腰带的按钮会带着 #ev-sec-works 这类锚点跳过来。浏览器自带的锚点
    定位在这里不管用：跳转时整页还是 loading，目标小节根本还没渲染出来。
    所以等数据到位之后再滚一次。
  */
  useEffect(() => {
    if (!data || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) el.scrollIntoView({ block: 'start' });
  }, [data]);

  if (err) {
    return (
      <Center>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-md)' }}>{err}</p>
        <a href="/" style={{ fontSize: 'var(--text-sm)', color: 'var(--link)' }}>回 iSpace</a>
      </Center>
    );
  }
  if (!data) return <Center><Pulse /></Center>;

  const { event, stats, finalists, awards, me } = data;
  const phase = event.phase;
  const cfg = event.config;

  /* 小节编号连续递增：入围名单/获奖名单在前，怎么参加、奖项、日程跟在后面。 */
  let n = 0;
  const no = () => `0x0${(n += 1)}`;

  const showCards = (phase === 'building' || phase === 'demo' || event.votingOpen) && finalists.length > 0;
  const showAwards = phaseAtLeast(phase, 'result') && !!awards?.length;
  const showRules = phase === 'signup' || phase === 'screening' || phase === 'building';

  return (
    <ToneProvider tone="business">
      <GlobalKeyframes />
      <EventKeyframes />
      <EventLayoutStyles />
      <div style={{ minHeight: '100vh', background: 'var(--surface-canvas)' }}>
        <div style={{
          minHeight: '100vh', background: 'var(--surface-canvas)', position: 'relative',
        }}>
          {/* 内容区这一层用橙字橙光，压在浅色底上才看得见 */}
          <BitField rgb="249,115,22" alpha={0.42} glow="251,146,60" glowAlpha={0.1} />
          <Hero
            data={data}
            onIdea={() => (me ? setSheet('idea') : gotoLogin())}
            onWork={() => (me ? setSheet('work') : gotoLogin())}
          />

          <div className="ev-page">
            {showCards && (
              <section className="ev-section-block ev-section-block--works" id={SEC.works}>
                <SectionHead
                  no={no()}
                  title={phase === 'building' ? '入围名单' : '今天路演的作品'}
                  en={phase === 'building' ? 'FINALISTS' : "TODAY'S DEMOS"}
                  /* 进度条贴在标题行右端，窄屏回到标题下方（见 ev-section-side） */
                  side={phase === 'building'
                    ? <Progress done={stats.workCount} total={finalists.length} />
                    : undefined}
                />
                <span className="ev-section-caption">
                  {phase === 'building'
                    ? `${finalists.length} 个创意入围，编号就是 ${fmtMd(cfg.deadlines.award)} 的路演顺序 · ${fmtMd(cfg.deadlines.work)} 前交作品`
                    : `${finalists.length} 件 · 最佳人气奖投票 ${fmtHm(cfg.deadlines.vote)} 截止，每人 ${cfg.voteLimit} 票 · 不能投给自己`}
                </span>
                <FinalistCards
                  data={data}
                  onVoted={load}
                  say={say}
                />
              </section>
            )}

            {showAwards && (
              <section className="ev-section-block ev-section-block--works" id={SEC.results}>
                <SectionHead
                  no={no()}
                  title="获奖名单"
                  en="WINNERS"
                  side={`${fmtMdHm(cfg.deadlines.award)} 公布 · 评委 ${EVENT_JUDGES.length} 人 · 投票 ${stats.voteTotal} 张`}
                />
                <Awards awards={awards!} myName={me?.displayName} />
                {/*
                  没拿奖的那几件也要列出来，按票数。八个人做了四天，
                  名单上只留四个名字是不合适的。
                */}
                <RestOfField finalists={finalists} awards={awards!} />
              </section>
            )}

            {showRules && <HowSection no={no()} cfg={cfg} />}

            <PrizesSection
              no={no()}
              cfg={cfg}
              awardDate={fmtMd(cfg.deadlines.award)}
              /*
                评委入口。/1024/judge 这一个地址按阶段是两件事：初筛期是给创意
                投票，入围之后是给作品打分。入口跟着变——原先只在打分期露出来，
                初筛那两个小时评委在活动页上找不到地方点。
              */
              judgeLink={!(me?.isJudge || me?.isAdmin) ? null
                : phase === 'screening' ? 'vote'
                : phaseAtLeast(phase, 'building') && !event.judgingLocked ? 'score'
                : null}
            />

            <ScheduleSection no={no()} cfg={cfg} />

            <footer style={{
              display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4,
              borderTop: '1px solid var(--border-subtle)', marginTop: 4,
            }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', paddingTop: 16 }}>
                {cfg.contact}
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {location.host}{EVENT_PATH}
              </span>
            </footer>
          </div>

        </div>
      </div>

      {sheet === 'idea' && (
        <IdeaSheet
          cfg={cfg}
          current={me?.idea ?? null}
          onClose={() => setSheet(null)}
          onDone={async (msg) => { setSheet(null); say(msg); await load(); }}
          say={say}
        />
      )}
      {sheet === 'work' && (
        <WorkSheet
          cfg={cfg}
          current={me?.work ?? null}
          onClose={() => setSheet(null)}
          onDone={async (msg) => { setSheet(null); say(msg); await load(); }}
          say={say}
        />
      )}

      {toast && (
        <Toast message={toast.msg} tone={toast.tone} onClose={() => setToast(null)} />
      )}
    </ToneProvider>
  );
}

// ── 头图 ──────────────────────────────────────────────────────────────

function Hero({ data, onIdea, onWork }: {
  data: EventResponse; onIdea: () => void; onWork: () => void;
}) {
  const { event, stats, finalists, awards, me } = data;
  const cfg = event.config;
  const phase = event.phase;
  const si = stepIndex(phase);
  const done = phaseAtLeast(phase, 'result');

  const count = countdown(data);
  const mine = myStatus(data);

  /*
    宽屏铺开、窄屏摞起来的是同一棵 DOM：版式差异全在 styles.tsx 的断点里，
    不按屏宽渲染两套（那会在 SSR/首屏之间闪一下，也多一份要同步的代码）。
    点阵与方块的尺寸是画出来的，没法靠 CSS 改，所以这里按视口挑一次。
  */
  const dots = useDotScale();

  return (
    <header style={{
      position: 'relative', overflow: 'hidden',
      backgroundColor: 'var(--tabby-orange)',
      backgroundImage: 'radial-gradient(var(--tabby-orange-hover) 1.2px, transparent 1.2px)',
      backgroundSize: '20px 20px',
    }}>
      {/* 指针扫过时亮起来的 0/1。参数照稿：橙底上用白字白光。 */}
      <BitField rgb="255,255,255" alpha={0.55} glow="255,255,255" glowAlpha={0.14} />

      {/* 出血的巨大 1024。纯装饰，不可选中也不吃点击。 */}
      <span aria-hidden="true" className="mono ev-hero-mark" style={{
        position: 'absolute', fontWeight: 800,
        lineHeight: 1, letterSpacing: '-.06em', color: 'var(--tabby-orange-hover)',
        whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
      }}>1024</span>

      <div className="ev-hero-inner">
        <div className="ev-hero-top">
          <a
            href="/"
            aria-label="回 iSpace"
            style={{
              width: 36, height: 36, margin: '-6px 2px -6px -8px', borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-heading)', textDecoration: 'none',
            }}
          >
            <EIcon name="back" size={20} />
          </a>
          <Mark size={22} />
          <span style={{
            fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 800,
            letterSpacing: '-.03em', color: 'var(--text-heading)',
          }}>
            iSpace
          </span>
          <span style={{ flex: 1 }} />
          {me ? (
            <div style={{ background: 'var(--surface-1)', borderRadius: 100, padding: 2, display: 'flex' }}>
              <Avatar name={me.displayName} size={28} />
            </div>
          ) : (
            /*
              未登录不摆头像，也不摆「登录」按钮——这一页的主张就是不必登录。
              要身份的时候底部那颗按钮会去要。
            */
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-heading)', opacity: 0.72 }}>
              {cfg.dateLabel.split(' ')[0]}
            </span>
          )}
        </div>

        <div className="ev-hero-main">
          <div className="ev-hero-copy">
            {event.edition && (
              <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                <span className="mono" style={{
                  background: 'var(--text-heading)', color: '#fff', borderRadius: 100,
                  padding: dots.wide ? '5px 12px' : '4px 10px', fontSize: dots.wide ? 12 : 11,
                }}>{event.edition}</span>
              </div>
            )}

            <div className="ev-hero-title-row">
              {/* flex:none——点阵是画出来的固定宽，被 flex 压缩就塌成一条竖线 */}
              <div style={{ flex: 'none', padding: dots.wide ? '2px 0 6px' : '0 0 4px' }}>
                <DotMatrix
                  size={dots.size}
                  gap={dots.gap}
                  radius={dots.radius}
                  palette={DOTS_ON_ORANGE}
                />
              </div>
              <div className="ev-hero-title-col" style={{ gap: dots.wide ? 8 : 5 }}>
                {/*
                  宽屏方块与公式并排，窄屏竖着摞——标题右边那一列在手机上
                  放不下一整行。
                */}
                <span style={{
                  display: 'flex', flexDirection: dots.wide ? 'row' : 'column',
                  alignItems: dots.wide ? 'center' : 'flex-start', gap: dots.wide ? 10 : 5,
                  flexWrap: 'wrap',
                }}>
                  <BinaryTen size={dots.wide ? 12 : 9} gap={4} color="var(--text-heading)" />
                  <span className="mono" style={{
                    fontSize: dots.wide ? 13 : 11, fontWeight: 700, color: 'var(--text-heading)',
                  }}>= 2¹⁰ = 0x400 = 1 KB</span>
                </span>
                <span className="ev-hero-title">
                  {event.title}<Caret color="var(--text-heading)" />
                </span>
              </div>
            </div>

            {event.subtitle && <span className="ev-hero-sub">{event.subtitle}</span>}

            {cfg.intro && <span className="ev-hero-intro">{cfg.intro}</span>}

            <div className="ev-hero-meta">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <EIcon name="calendar" size={14} /><span>{cfg.dateLabel}</span>
              </span>
              {event.venue && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <EIcon name="pin" size={14} /><span>{event.venue}</span>
                </span>
              )}
            </div>

            <HeroCta data={data} onIdea={onIdea} onWork={onWork} />
          </div>

          {/* 当前阶段卡：倒数 + 我的状态。整页唯一一处随「我」变化的地方。 */}
          <div className="ev-hero-stage">
            <div style={{
              /* 稿上是 rgba(255,255,255,.8)：压在橙底上要透出一点底下的点阵 */
              background: 'rgba(255,255,255,.8)', borderRadius: 'var(--radius-16)',
              padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14,
              boxShadow: 'var(--shadow-card)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, letterSpacing: '.05em',
                  textTransform: 'uppercase', color: 'var(--text-tertiary)',
                }}>当前阶段</span>
                <Badge tone="brand" dot>{PHASE_LABEL[phase]}</Badge>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span className="mono" style={{
                  fontSize: 44, fontWeight: 700, lineHeight: 1, color: 'var(--text-heading)',
                }}>{count.num}</span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{count.unit}</span>
              </div>
              <div style={{ height: 1, background: 'var(--border-subtle)' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {me && <Avatar name={me.displayName} size={28} />}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>
                    {mine.title}
                  </span>
                  <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                    {mine.hint}
                  </span>
                </div>
              </div>
              <div style={{ height: 1, background: 'var(--border-subtle)' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {heroStats(data).map((m) => (
                  <Metric key={m.label} value={m.value} label={m.label} />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="ev-hero-steps">
          {STEP_NAMES.map((name, i) => {
            const cur = i === si && !done;
            const past = i < si || done;
            return (
              <div key={name} className="ev-hero-step" style={{
                minWidth: 0,
                background: cur ? 'var(--text-heading)' : past ? 'rgba(255,255,255,.32)' : 'transparent',
                border: `1px solid ${cur ? 'var(--text-heading)' : past ? 'transparent' : 'rgba(0,18,23,.22)'}`,
                color: cur ? '#fff' : 'var(--text-heading)',
              }}>
                <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{name}</span>
                <span className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                  {(cfg.how[i]?.date ?? '').replace(/\s*–\s*/, '–')}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </header>
  );
}

/**
 * 阶段卡右下角那两个数。取哪两个跟着阶段走：报名期关心有多少人交了创意，
 * 入围后关心作品交了几件，出结果后关心一共投了多少票。
 */
function heroStats(data: EventResponse): { value: string; label: string }[] {
  const { event, stats, finalists } = data;
  switch (event.phase) {
    case 'signup':
    case 'screening':
      return [
        { value: String(stats.ideaCount), label: '个创意已提交' },
        { value: String(EVENT_JUDGES.length), label: '位评委' },
      ];
    case 'building':
      return [
        { value: `${stats.workCount}/${finalists.length}`, label: '件作品已交' },
        { value: String(EVENT_JUDGES.length), label: '位评委' },
      ];
    default:
      return [
        { value: String(finalists.length), label: '件入围作品' },
        { value: String(stats.voteTotal), label: '张人气票' },
      ];
  }
}

const PHASE_LABEL: Record<EventPhase, string> = {
  signup: '报名中',
  screening: '评委初筛',
  building: '入围制作',
  demo: '展示答辩',
  result: '结果公布',
  ended: '已结束',
};

/**
 * 点阵与二进制方块的尺寸。
 *
 * 这几块是用格子「画」出来的，尺寸进不了 CSS 媒体查询，只能按视口挑一次。
 *
 * ┌─ 为什么不照搬设计稿 ──────────────────────────────────────────────┐
 * │ 稿上点阵恒为 13px 格子（整块 365px 宽），窄屏靠裁切解决——设计师给   │
 * │ 的 701px 截图里公式那行就是被右边裁掉的。701 上这样没问题，标题还     │
 * │ 在；可到 375 的手机上，365px 的点阵会把「程序员节」整个挤出屏幕。     │
 * │ 这一页主要是被转发到群里、用手机点开的，所以 720 以下分两档缩。      │
 * └────────────────────────────────────────────────────────────────────┘
 */
function useDotScale(): { size: number; gap: number; radius: number; wide: boolean } {
  const read = () => {
    const w = typeof window === 'undefined' ? 1280 : window.innerWidth;
    if (w > 720) return { size: 13, gap: 3, radius: 3, wide: true };
    if (w > 480) return { size: 9, gap: 3, radius: 2, wide: false };
    return { size: 6, gap: 2, radius: 1.5, wide: false };
  };
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

function countdown(data: EventResponse): { num: string; unit: string } {
  const { event, stats, finalists, awards } = data;
  const { now, phase, config: cfg } = event;
  const d = cfg.deadlines;
  switch (phase) {
    case 'signup':
      return {
        num: String(daysUntil(now, d.idea)),
        unit: `天后截止交创意 · ${fmtMdHm(d.idea)}`,
      };
    case 'screening':
      return {
        num: String(stats.ideaCount),
        unit: `个创意已提交 · ${fmtMdHm(d.screening)} 公布入围`,
      };
    case 'building':
      return {
        num: String(daysUntil(now, d.work)),
        unit: `天开发时间 · ${fmtMd(d.work)} 前交作品`,
      };
    case 'demo':
      return {
        num: String(finalists.length),
        unit: `个项目今天路演 · 投票 ${fmtHm(d.vote)} 截止`,
      };
    case 'result':
      return {
        num: String(awards?.length ?? 0),
        unit: `个奖项 · ${fmtMd(d.award)} 已公布`,
      };
    default:
      return { num: String(stats.ideaCount), unit: '个创意参与了本届' };
  }
}

/**
 * 「我的状态」那两行。
 *
 * 未登录时它是唯一需要特殊处理的地方——其余各段对匿名访客和登录用户
 * 完全一样。这里给的话要把「不用登录也能看」这件事说清楚，别让人以为
 * 页面坏了。
 */
function myStatus(data: EventResponse): { title: string; hint: string } {
  const { event, me, awards } = data;
  const { phase, config: cfg } = event;
  const d = cfg.deadlines;

  if (!me) {
    return phase === 'signup'
      ? { title: '活动详情不用登录', hint: `想参加就点下面那颗按钮，登录后交创意 · ${fmtMdHm(d.idea)} 截止` }
      : { title: '活动详情不用登录', hint: '登录后能看到自己的参赛状态' };
  }

  const idea = me.idea;
  const work = me.work;

  switch (phase) {
    case 'signup':
      return idea
        ? {
            title: `已交创意「${idea.name}」`,
            hint: `${fmtMdHm(d.idea)} 截止前可以改，${fmtHm(d.screening)} 公布入围`,
          }
        : {
            title: '你还没交创意',
            hint: `${fmtMdHm(d.idea)} 截止，写清楚想解决什么问题就行`,
          };
    case 'screening':
      return idea
        ? { title: `创意「${idea.name}」已提交`, hint: `评委正在初筛，${fmtHm(d.screening)} 公布入围名单` }
        : { title: '这届没赶上交创意', hint: `${fmtMd(d.award)} 来现场看路演，还能扫码投票` };
    case 'building':
      if (idea?.finalist) {
        return work
          ? {
              title: `已交作品「${work.name}」`,
              hint: `${fmtMd(d.work)} 截止前可以换 · ${fmtMd(d.award)} 上午路演`,
            }
          : {
              title: `「${idea.name}」入围了`,
              hint: `入围奖 ¥200 京东卡 · ${fmtMd(d.work)} 前交作品`,
            };
      }
      return idea
        ? { title: '这次没入围', hint: `${fmtMd(d.award)} 上午来看路演，扫码投票选最佳人气奖` }
        : { title: '你没参赛', hint: `${fmtMd(d.award)} 上午来看路演，扫码投票选最佳人气奖` };
    case 'demo': {
      const left = cfg.voteLimit - me.votes.length;
      return {
        title: idea?.finalist ? `你的「${idea.name}」今天路演` : '今天现场投票',
        hint: left > 0
          ? `你还有 ${left} 票，不能投给自己`
          : `${cfg.voteLimit} 票已投完，${fmtHm(d.vote)} 前可以撤回重投`,
      };
    }
    case 'result': {
      const won = awards?.find((a) => a.who === me.displayName);
      return won
        ? { title: `「${won.ideaName}」拿到${won.name}`, hint: `${won.money} · 恭喜` }
        : { title: '本届已颁奖', hint: '明年再来。获奖名单在下面' };
    }
    default:
      return { title: '本届已结束', hint: '明年见' };
  }
}

// ── 入围 / 路演作品卡 ─────────────────────────────────────────────────

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        flex: 1, height: 6, borderRadius: 100, background: 'var(--surface-3)', overflow: 'hidden',
      }}>
        <div style={{ height: '100%', borderRadius: 100, background: 'var(--tabby-orange)', width: `${pct}%` }} />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        已交作品{' '}
        <span className="mono" style={{ fontWeight: 700, color: 'var(--text-heading)' }}>
          {done} / {total}
        </span>
      </span>
    </div>
  );
}

function FinalistCards({
  data, onVoted, say,
}: {
  data: EventResponse;
  onVoted: () => Promise<void>;
  say: (m: string, tone?: 'info' | 'error') => void;
}) {
  const { event, finalists, me } = data;
  /*
    投票开不开由服务端算好（event.votingOpen）。本届窗口是 10.22 18:00 –
    10.23 12:00，横跨 building 与 demo 两个阶段——用 `phase === 'demo'` 判断
    会把 10.22 晚上那半程整个挡掉。
  */
  const voting = event.votingOpen;
  const [busy, setBusy] = useState<string | null>(null);

  const vote = async (f: EventFinalist) => {
    if (!me) { gotoLogin(); return; }
    setBusy(f.ideaId);
    try {
      const r = await api.toggleVote(CURRENT_EVENT_SLUG, f.ideaId);
      say(r.voted
        ? (r.remaining === 0 ? `${event.config.voteLimit} 票都投完了，截止前还能改` : `已投，还剩 ${r.remaining} 票`)
        : `已撤回，还剩 ${r.remaining} 票`);
      await onVoted();
    } catch (e) {
      say(e instanceof Error ? e.message : '投票没成功', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ev-card-grid">
      {finalists.map((f) => {
        const isMine = !!me && f.ownerUsername === me.username;
        const voted = !!me && me.votes.includes(f.ideaId);
        return (
          <article key={f.ideaId} style={{
            position: 'relative', overflow: 'hidden', borderRadius: 16,
            backgroundColor: 'var(--dark-bg)',
            backgroundImage: 'radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px)',
            backgroundSize: '14px 14px',
            padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <span aria-hidden="true" className="mono" style={{
              position: 'absolute', right: -4, bottom: -24, fontWeight: 800, fontSize: 96,
              lineHeight: 1, letterSpacing: '-.06em', color: 'rgba(251,146,60,.14)',
              pointerEvents: 'none', userSelect: 'none',
            }}>{f.no}</span>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="mono" style={{
                fontSize: 12, fontWeight: 700, letterSpacing: '.04em', color: 'var(--tabby-orange)',
              }}>NO.{f.no}</span>
              <span style={{ flex: 1 }} />
              {!voting && f.kind && (
                <span className="mono" style={{
                  flex: 'none', fontSize: 11, color: 'var(--tabby-orange)',
                  border: '1px solid rgba(251,146,60,.45)', borderRadius: 6,
                  padding: '2px 7px', whiteSpace: 'nowrap',
                }}>{f.kind === 'page' ? 'iSpace 页面' : '硬件'}</span>
              )}
              {!voting && (
                <span style={{
                  flex: 'none', display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 11, color: 'rgba(255,255,255,.72)', whiteSpace: 'nowrap',
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: 100,
                    background: f.submitted ? 'var(--success)' : 'var(--warning)',
                  }} />
                  {f.submitted ? '已交作品' : '制作中'}
                </span>
              )}
              {voting && f.votes != null && (
                <span className="mono" style={{ flex: 'none', fontSize: 11, color: 'rgba(255,255,255,.72)' }}>
                  {f.votes} 票
                </span>
              )}
            </div>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#fff' }}>{f.name}</h3>
              {isMine && (
                <span style={{
                  fontSize: 10, fontWeight: 700, borderRadius: 100, padding: '2px 7px',
                  background: 'var(--tabby-orange)', color: 'var(--text-heading)',
                }}>我的</span>
              )}
            </div>
            <p style={{
              position: 'relative', margin: 0, fontSize: 12, lineHeight: 1.6,
              color: 'rgba(255,255,255,.72)',
            }}>{f.desc}</p>

            <div style={{
              position: 'relative', display: 'flex', alignItems: 'center',
              gap: 10, paddingTop: 2,
            }}>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,.62)' }}>{f.who}</span>
              <span style={{ flex: 1 }} />
              {f.url && (
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    fontSize: 12, color: 'var(--tabby-orange)', textDecoration: 'none',
                  }}
                >
                  打开作品<EIcon name="ext" size={12} />
                </a>
              )}
              {voting && (
                isMine ? (
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,.5)' }}>不能投给自己</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy === f.ideaId}
                    onClick={() => void vote(f)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      height: 30, padding: '0 12px', borderRadius: 8, cursor: 'pointer',
                      background: voted ? 'var(--tabby-orange)' : 'transparent',
                      color: voted ? 'var(--text-heading)' : '#fff',
                      border: `1px solid ${voted ? 'var(--tabby-orange)' : 'rgba(255,255,255,.28)'}`,
                      font: '600 12px/1 var(--font-sans)',
                      opacity: busy === f.ideaId ? 0.6 : 1,
                    }}
                  >
                    {voted && <EIcon name="check" size={14} />}
                    {voted ? '已投' : '投一票'}
                  </button>
                )
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ── 获奖名单 ──────────────────────────────────────────────────────────

function Awards({ awards, myName }: { awards: EventResponse['awards']; myName?: string }) {
  if (!awards?.length) return null;
  const [top, ...rest] = awards;
  const ICONS: Record<string, EventIconName> = {
    first: 'trophy', second: 'medal', third: 'award', popular: 'heart',
  };
  return (
    <div className="ev-card-grid">
      {/* 一等奖单独一张大卡：橙底，分数与票数并排 */}
      {top && (
        <div style={{
          background: 'var(--tabby-orange)', borderRadius: 16, padding: '16px 18px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-heading)' }}>
              {top.no}
            </span>
            <span style={{ display: 'flex', color: 'var(--text-heading)' }}>
              <EIcon name={ICONS[top.key] ?? 'trophy'} size={18} />
            </span>
            <span className="mono" style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '.12em', color: 'var(--text-heading)', opacity: 0.7,
            }}>CHAMPION</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}>{top.name}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            {top.url ? (
              <a href={top.url} target="_blank" rel="noreferrer" style={{
                fontSize: 20, fontWeight: 800, color: 'var(--text-heading)', textDecoration: 'none',
              }}>{top.ideaName}</a>
            ) : (
              <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-heading)' }}>{top.ideaName}</span>
            )}
            <span style={{ fontSize: 13, color: 'var(--text-heading)', opacity: 0.8 }}>{top.who}</span>
            {myName === top.who && (
              <span style={{
                fontSize: 10, fontWeight: 700, borderRadius: 100, padding: '2px 7px',
                background: 'var(--text-heading)', color: '#fff',
              }}>我的</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <Metric value={top.money} label="奖金" />
            {top.judgeScore != null && <Metric value={top.judgeScore.toFixed(1)} label="评委分" />}
            <Metric value={String(top.votes)} label="大众票" />
          </div>
          {top.comment && (
            <p style={{
              margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text-heading)',
              background: 'rgba(255,255,255,.4)', borderRadius: 10, padding: '8px 10px',
            }}>{top.comment}</p>
          )}
        </div>
      )}

      {rest.map((a) => (
        <div key={a.key} style={{
          background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
          borderRadius: 14, padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'flex', color: 'var(--tabby-orange-hover)' }}>
              <EIcon name={ICONS[a.key] ?? 'award'} size={16} />
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}>{a.name}</span>
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-heading)' }}>
              {a.money}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>NO.{a.no}</span>
            {a.url ? (
              <a href={a.url} target="_blank" rel="noreferrer" style={{
                fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textDecoration: 'none',
              }}>{a.ideaName}</a>
            ) : (
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{a.ideaName}</span>
            )}
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{a.who}</span>
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {a.judgeScore != null ? `${a.judgeScore.toFixed(1)} 分` : `${a.votes} 票`}
            </span>
          </div>
          {a.comment && (
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              评委说：{a.comment}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** 其余入围作品，按票数从多到少。拿了奖的已经在上面，这里不重复。 */
function RestOfField({
  finalists, awards,
}: {
  finalists: EventFinalist[]; awards: NonNullable<EventResponse['awards']>;
}) {
  const won = new Set(awards.map((a) => a.no));
  const rest = finalists
    .filter((f) => !won.has(f.no))
    .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
  if (rest.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>其余入围作品 · 按票数</span>
      <div style={{
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        borderRadius: 14, padding: '2px 14px',
      }}>
        {rest.map((f, i) => (
          <div key={f.ideaId} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
            borderBottom: i === rest.length - 1 ? 'none' : '1px solid var(--border-subtle)',
          }}>
            <span className="mono" style={{ flex: 'none', fontSize: 11, color: 'var(--text-tertiary)' }}>
              {f.no}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {f.url ? (
                <a href={f.url} target="_blank" rel="noreferrer" style={{
                  fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', textDecoration: 'none',
                }}>{f.name}</a>
              ) : (
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{f.name}</span>
              )}
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{f.who}</span>
            </span>
            <span className="mono" style={{ flex: 'none', fontSize: 12, color: 'var(--text-secondary)' }}>
              {f.votes ?? 0} 票
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span className="mono" style={{
        fontSize: 18, fontWeight: 700, lineHeight: 1, color: 'var(--text-heading)',
      }}>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--text-heading)', opacity: 0.66 }}>{label}</span>
    </span>
  );
}

/** 评委头像。照片取不到（文件没发上去、被挡了）就退回文字头像，不留碎图。 */
function JudgeFace({ judge }: { judge: typeof EVENT_JUDGES[number] }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Avatar name={judge.name} size={48} />;
  return (
    <img
      src={judgeAvatar(judge.key)}
      alt=""
      aria-hidden="true"
      onError={() => setBroken(true)}
      style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
    />
  );
}

// ── 怎么参加 ──────────────────────────────────────────────────────────

/*
  以下三段走 styles.tsx 的 `ev-*` 类名，不像本文件其余部分那样内联。
  原因只有一个：设计稿这几段是响应式的（四列 → 两列 → 一列），断点写
  不进 style 属性。排版交给样式表，这里只管把数据填进去。
*/

function HowSection({ no, cfg }: { no: string; cfg: EventConfig }) {
  return (
    <section className="ev-section-block" id={SEC.rules}>
      <SectionHead no={no} title="怎么参加" en="HOW TO PARTICIPATE" />
      <div className="ev-how-grid">
        {cfg.how.map((h) => {
          const icon = (h.icon as EventIconName) ?? 'idea';
          return (
            <div key={h.title} className="ev-how-card">
              {/* 右下角压出血的大图标：重复的是卡片里已有的信息，对读屏藏掉 */}
              <span className="ev-how-watermark" aria-hidden="true">
                <EIcon name={icon} size={112} />
              </span>
              <div className="ev-how-content">
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <span className="ev-how-icon" style={{ background: 'var(--tabby-orange)' }}>
                    <EIcon name={icon} size={18} />
                  </span>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {h.date}
                  </span>
                </div>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-heading)' }}>
                  {h.title}
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                  {h.desc}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="ev-panel-card">
        <div className="ev-rules-title ev-panel-title">参赛规则</div>
        <div className="ev-rules-list">
          {cfg.rules.map((t, i) => (
            <div key={t} className="ev-rule-row">
              <span className="ev-rule-index">{`0${i + 1}`}</span>
              <span className="ev-rule-text">{t}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── 奖项与评选 ────────────────────────────────────────────────────────

/** 把 "¥5,000" 读成 5000。读不出来返回 null——拿不准就不显示那行汇总。 */
function yuan(s: string): number | null {
  const m = /^¥\s*([\d,]+)$/.exec(s.trim());
  return m?.[1] ? Number(m[1].replace(/,/g, '')) : null;
}

/** 评委入口那一行。两个阶段同一个地址，只是字不同。 */
function JudgeLink({ label }: { label: string }) {
  return (
    <a href={`${EVENT_PATH}/judge`} style={{
      alignSelf: 'flex-start', fontSize: 12, fontWeight: 600,
      color: 'var(--link)',
    }}>你是本届评委 · {label} →</a>
  );
}

function PrizesSection({
  no, cfg, awardDate, judgeLink,
}: {
  no: string; cfg: EventConfig; awardDate: string;
  /** vote = 初筛期去投票，score = 入围后去打分，null = 不显示 */
  judgeLink: 'vote' | 'score' | null;
}) {
  /*
    前三名上领奖台（二在左、一居中更高、三在右，由 ev-main-prize-rank-N 定位），
    其余的走下面两格小卡。顺序取 config，因为结算 awardRules 也按这个顺序。
  */
  const main = cfg.prizes.slice(0, 3);
  const mini = cfg.prizes.slice(3);
  const MAIN_ICONS: EventIconName[] = ['trophy', 'medal', 'award'];
  const MINI_ICONS: EventIconName[] = ['heart', 'card'];

  /* 标题下那行汇总：现金奖总额由前三名加出来，任一项读不出金额就整行不显示 */
  const cash = main.map((p) => yuan(p.money));
  const last = mini[mini.length - 1];
  const note = cash.every((n): n is number => n !== null)
    ? `现金奖 ¥${cash.reduce((a, b) => a + b, 0).toLocaleString('en-US')}${
      last ? ` · ${last.name} ${last.money}` : ''}`
    : undefined;

  const screening = cfg.screening ?? [];

  return (
    <section className="ev-section-block" id={SEC.awards}>
      <SectionHead
        no={no}
        title="奖项与评选"
        en="AWARDS & JUDGING"
        note={note ? <span className="mono">{note}</span> : undefined}
      />

      <div className="ev-prize-showcase">
        <div className="ev-main-prizes">
          {main.map((p, i) => (
            <div key={p.name} className={`ev-main-prize ev-main-prize-rank-${i + 1}`}>
              <span className="ev-prize-rank-deco" aria-hidden="true">{`0${i + 1}`}</span>
              {/*
                奖牌是装饰。onError 把自己藏起来：缺一张图不该在领奖台上
                留个破图图标，这一页会被转发到群里。
              */}
              <img
                className="ev-prize-medal"
                src={`/event-prize-${i + 1}.png`}
                alt=""
                aria-hidden="true"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <div className="ev-main-prize-meta">
                <span className="ev-main-prize-icon">
                  <EIcon name={MAIN_ICONS[i] ?? 'award'} size={30} />
                </span>
              </div>
              <span className="ev-main-prize-name">{p.name}</span>
              <div className="ev-main-prize-value">
                <span className="ev-main-prize-label">奖金</span>
                <span className="ev-main-prize-money">{p.money}</span>
                <span className="ev-main-prize-how">{p.how}</span>
              </div>
            </div>
          ))}
        </div>
        {mini.length > 0 && (
          <div className="ev-mini-prizes">
            {mini.map((p, i) => (
              <div key={p.name} className="ev-mini-prize">
                <span className="ev-mini-prize-icon">
                  <EIcon name={MINI_ICONS[i] ?? 'award'} size={24} />
                </span>
                <div className="ev-mini-prize-copy">
                  <span className="ev-mini-prize-name">{p.name}</span>
                  <span className="ev-mini-prize-how">{p.how}</span>
                </div>
                <div className="ev-mini-prize-value">
                  <span className="ev-mini-prize-money">{p.money}</span>
                  <span className="ev-mini-prize-count">{p.count}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ev-panel-card">
        {/*
          名单走 judges.ts 的固定名册，不读接口——那边是「谁能打分」的权限，
          这里是「海报上印谁」。理由写在 judges.ts 开头。
        */}
        <div className="ev-judge-panel">
          <span className="ev-panel-title">评委 · {EVENT_JUDGES.length} 位 TL</span>
          <div className="ev-judge-row">
            {EVENT_JUDGES.map((j) => (
              <div key={j.key} className="ev-judge-cell">
                <JudgeFace judge={j} />
                <span style={{
                  fontSize: 13, fontWeight: 600,
                  color: 'var(--text-heading)', whiteSpace: 'nowrap',
                }}>{j.name}</span>
              </div>
            ))}
          </div>
        </div>
        {/* 没有初筛那一栏时收成一列，否则右半边空着 */}
        <div className={`ev-criteria-grid${screening.length ? '' : ' ev-criteria-grid--single'}`}>
          {screening.length > 0 && (
            <div className="ev-criteria-panel">
              <span className="ev-panel-title">初筛看什么</span>
              {screening.map((c) => (
                <div key={c.key} className="ev-screen-row">
                  <span className="ev-screen-key">{c.key}</span>
                  <span className="ev-screen-desc">{c.desc}</span>
                </div>
              ))}
              {cfg.screeningNote && (
                <span className="ev-criteria-note">{cfg.screeningNote}</span>
              )}
              {judgeLink === 'vote' && <JudgeLink label="打开评委投票页" />}
            </div>
          )}
          <div className="ev-criteria-panel ev-criteria-panel-score">
            <span className="ev-panel-title">{awardDate} 答辩怎么打分</span>
            {cfg.criteria.map((c) => (
              <div key={c.key} className="ev-score-row">
                <span className="ev-score-label">{c.key}</span>
                <span className="ev-score-desc">{c.desc}</span>
                <span className="ev-score-leader" aria-hidden="true" />
                <span className="ev-score-weight">{c.max} 分</span>
              </div>
            ))}
            {/*
              赛制说明走 config：这一届它就改过一次（投票从现场扫码改成全员
              线上、人气奖与前三名互斥），写死在这里等于改规则要改代码。
            */}
            <span className="ev-criteria-note">
              {cfg.judgingNote
                ?? '路演作品全靠评委打分排名次，定一、二、三等奖；现场扫码投票只用来选最佳人气奖。'}
            </span>
            {judgeLink === 'score' && <JudgeLink label="打开评委打分页" />}
            {/* 没有「初筛看什么」那一栏时，投票入口无处可放，落到这里 */}
            {judgeLink === 'vote' && screening.length === 0 && <JudgeLink label="打开评委投票页" />}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── 日程 ──────────────────────────────────────────────────────────────

/** 小节副标题要英文：10.23 → OCT 23。 */
function enMonthDay(iso: string): string {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric',
  }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('month')} ${get('day')}`;
}

function ScheduleSection({ no, cfg }: { no: string; cfg: EventConfig }) {
  return (
    <section className="ev-section-block" id={SEC.schedule}>
      <SectionHead
        no={no}
        title={`${fmtMd(cfg.deadlines.award)} 线下`}
        en={`${enMonthDay(cfg.deadlines.award)} / OFFLINE`}
        note={cfg.dateLabel}
      />
      <div className="ev-panel-card">
        <div className="ev-schedule-grid">
          {cfg.schedule.map((block, bi) => (
            <div key={block.label} className="ev-schedule-column">
              <div className="ev-schedule-header">
                <span className="ev-schedule-code">{bi === 0 ? 'AM' : 'PM'}</span>
                <div className="ev-schedule-title">
                  <span className="ev-schedule-name">{block.label}</span>
                  <span className="ev-schedule-time">{block.time}</span>
                </div>
              </div>
              {block.rows.map((r) => (
                <div key={`${r.time}${r.title}`} className="ev-schedule-item">
                  <span className="ev-schedule-item-time">{r.time}</span>
                  <span className="ev-schedule-item-icon" style={{
                    background: r.icon === 'gift' || r.icon === 'mail'
                      ? 'var(--tabby-orange-subtle)' : 'var(--surface-2)',
                    color: 'var(--text-heading)',
                  }}>
                    <EIcon name={(r.icon as EventIconName) ?? 'zap'} size={18} />
                  </span>
                  <div className="ev-schedule-item-copy">
                    <span className="ev-schedule-item-title">{r.title}</span>
                    <span className="ev-schedule-item-desc">{r.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── hero 里的行动按钮 ─────────────────────────────────────────────

/** 滚到某个小节。目标在当前阶段没渲染时什么都不做。 */
function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * hero 里那一到两颗按钮，取代了原先那条吸底栏。
 *
 * ┌─ 为什么不吸底 ────────────────────────────────────────────────────┐
 * │ 设计稿把动作放在日期/地点下面，和上面那段介绍连着读：先说清这是     │
 * │ 什么、什么时候、在哪，然后才是「那我该做什么」。悬在屏幕底下的一条   │
 * │ 栏把这个顺序打断了，而且在宽屏上尤其突兀。                          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 每个阶段「此刻该做什么」只有一件，所以主按钮永远只有一颗；次按钮是可选的
 * 「顺便看看」，滚到页内对应小节。
 */
function HeroCta({
  data, onIdea, onWork,
}: {
  data: EventResponse; onIdea: () => void; onWork: () => void;
}) {
  const { event, me } = data;
  const { phase, config: cfg } = event;

  type Act = { label: string; run: () => void };
  let primary: Act;
  let second: Act | null = null;

  switch (phase) {
    case 'signup':
      primary = { label: me?.idea ? '修改创意' : '提交创意', run: onIdea };
      break;
    case 'screening':
      primary = { label: '看初筛怎么评', run: () => scrollToSection(SEC.awards) };
      break;
    case 'building':
      if (me?.idea?.finalist) {
        primary = { label: me.work ? '更换作品' : '提交作品', run: onWork };
        second = { label: '看入围名单', run: () => scrollToSection(SEC.works) };
      } else {
        primary = { label: '看入围名单', run: () => scrollToSection(SEC.works) };
      }
      break;
    case 'demo': {
      const left = me ? cfg.voteLimit - me.votes.length : cfg.voteLimit;
      primary = {
        label: left > 0 ? `去投票 · 还有 ${left} 票` : `${cfg.voteLimit} 票已投完`,
        run: () => scrollToSection(SEC.works),
      };
      second = { label: '今天的安排', run: () => scrollToSection(SEC.schedule) };
      break;
    }
    case 'result':
      primary = { label: '看获奖名单', run: () => scrollToSection(SEC.results) };
      second = { label: '线下安排', run: () => scrollToSection(SEC.schedule) };
      break;
    default:
      primary = { label: '看获奖作品', run: () => scrollToSection(SEC.results) };
  }

  /*
    组件只有 sm/md 两档，稿上这两颗是 lg，差的那一档在这里补。
    主次不同尺寸是稿里明确写的：主按钮 48 高、至少 176 宽、16px/700。
  */
  const PRIMARY = { minWidth: 176, height: 48, padding: '0 32px', fontSize: 16, fontWeight: 700 } as const;
  const SECOND = { height: 44, padding: '0 20px', fontSize: 14 } as const;

  return (
    <div className="ev-hero-cta">
      <Button variant="primary" onClick={primary.run} style={PRIMARY}>{primary.label}</Button>
      {second && (
        <Button variant="secondary" onClick={second.run} style={SECOND}>{second.label}</Button>
      )}
    </div>
  );
}

// ── 底部弹层（提交创意 / 提交作品）────────────────────────────────────

/**
 * 提交表单的弹层。电脑上居中，手机上从底部升起。
 *
 * 没用 @ispace/ui 的 Dialog：那个固定宽 440，而且只有居中一种形态。
 * 手机上表单该贴着拇指从下方升起，内容高度不定还要能滚。
 *
 * 两档的差异（对齐、圆角、最大高度、入场动画）全在 styles.tsx 的
 * .ev-sheet-* 里——内联 style 优先级高于媒体查询，放在这里切不动。
 */
function Sheet({
  title, footer, onClose, children,
}: {
  title: string; footer: React.ReactNode; onClose: () => void; children: React.ReactNode;
}) {
  // 打开时锁背景滚动，否则手指在表单外一滑，底下的长页面跟着动
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="ev-sheet-backdrop"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ev-sheet-panel"
        style={{
          width: '100%', maxWidth: SHEET,
          background: 'var(--surface-canvas)',
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 18px 12px', flex: 'none',
        }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 700, color: 'var(--text-heading)' }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'var(--surface-2)', color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <EIcon name="x" size={18} />
          </button>
        </div>
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          padding: '0 18px 8px', display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          {children}
        </div>
        <div style={{
          flex: 'none', padding: '12px 18px',
          paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {footer}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{hint}</span>}
    </label>
  );
}

const textareaStyle: React.CSSProperties = {
  width: '100%', minHeight: 80, padding: '10px 12px', resize: 'vertical',
  background: 'var(--surface-1)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-8)', color: 'var(--text-primary)',
  font: 'var(--weight-regular) var(--text-base)/1.6 var(--font-sans)',
  boxSizing: 'border-box',
};

function IdeaSheet({
  cfg, current, onClose, onDone, say,
}: {
  cfg: EventConfig;
  current: NonNullable<EventResponse['me']>['idea'];
  onClose: () => void;
  onDone: (msg: string) => Promise<void>;
  say: (m: string, tone?: 'info' | 'error') => void;
}) {
  const [name, setName] = useState(current?.name ?? '');
  const [problem, setProblem] = useState(current?.problem ?? '');
  const [plan, setPlan] = useState(current?.plan ?? '');
  const [form, setForm] = useState(current?.form ?? 'iSpace 页面');
  const [files, setFiles] = useState<EventFile[]>(current?.files ?? []);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !problem.trim() || !plan.trim()) {
      say('创意名称、想解决的问题、打算怎么做都要写', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.putIdea(CURRENT_EVENT_SLUG, {
        name: name.trim(), problem: problem.trim(), plan: plan.trim(), form, files,
      });
      await onDone(current ? '创意已更新' : `创意已提交，${fmtHm(cfg.deadlines.screening)} 公布入围`);
    } catch (e) {
      say(e instanceof Error ? e.message : '提交没成功', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={current ? '修改创意' : '提交创意'}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()} disabled={busy} style={{ width: '100%' }}>
            {busy ? '提交中…' : current ? '保存' : '提交创意'}
          </Button>
          <span style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            初筛结束前，创意只有评委能看到。{fmtMdHm(cfg.deadlines.idea)} 截止前可以改。
          </span>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        评委从所有创意里选出 {cfg.prizes.find((p) => p.name === '入围奖')?.count ?? '若干'} 个入围，
        入围即得 {cfg.prizes.find((p) => p.name === '入围奖')?.money ?? '¥200'} 京东卡。
        入围后 {fmtMd(cfg.deadlines.award)} 上午现场路演。
      </p>
      <Field label="创意名称">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="一句话说清它是什么" maxLength={60} />
      </Field>
      <Field label="想解决什么问题">
        <textarea
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
          placeholder="现在这件事是怎么做的，哪儿麻烦"
          style={textareaStyle}
          maxLength={2000}
        />
      </Field>
      <Field label="打算怎么做">
        <textarea
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          placeholder="不用写得很细，说清思路就行"
          style={textareaStyle}
          maxLength={2000}
        />
      </Field>
      <Field label="做成什么">
        <Tabs
          value={form}
          onChange={setForm}
          items={[
            { value: 'iSpace 页面', label: 'iSpace 页面' },
            { value: '硬件', label: '硬件' },
            { value: '其他', label: '其他' },
          ]}
        />
      </Field>
      <FilePicker
        files={files}
        onChange={setFiles}
        max={5}
        label="效果图、HTML 设计稿或草图"
        hint="选填，最多 5 个"
        say={say}
      />
    </Sheet>
  );
}

function WorkSheet({
  cfg, current, onClose, onDone, say,
}: {
  cfg: EventConfig;
  current: NonNullable<EventResponse['me']>['work'];
  onClose: () => void;
  onDone: (msg: string) => Promise<void>;
  say: (m: string, tone?: 'info' | 'error') => void;
}) {
  const [tab, setTab] = useState<'page' | 'other'>(current?.kind === 'other' ? 'other' : 'page');
  const [apps, setApps] = useState<AppEntity[] | null>(null);
  const [pick, setPick] = useState<string | null>(current?.appSlug ?? null);
  const [name, setName] = useState(current?.kind === 'other' ? current.name : '');
  const [pitch, setPitch] = useState(current?.pitch ?? '');
  const [files, setFiles] = useState<EventFile[]>(current?.kind === 'other' ? current.files : []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.apps()
      .then((r) => {
        setApps(r.apps);
        /* 没选过就默认停在第一个能提交的页面上，少一步点击 */
        setPick((p) => p ?? r.apps.find((a) => a.status === 'running' && a.currentReleaseId)?.slug ?? null);
      })
      .catch(() => setApps([]));
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      if (tab === 'page') {
        if (!pick) { say('先选一个页面', 'error'); return; }
        const r = await api.putWork(CURRENT_EVENT_SLUG, {
          kind: 'page', appSlug: pick, pitch: pitch.trim() || undefined,
        });
        await onDone(`${current ? '已换成' : '已提交'}「${apps?.find((a) => a.slug === pick)?.name ?? pick}」`
          + (r.appVersion ? ` · 参评版本 v${r.appVersion}` : ''));
      } else {
        if (!name.trim()) { say('先写作品名称', 'error'); return; }
        if (files.length === 0) { say('至少传一张照片或一段视频', 'error'); return; }
        await api.putWork(CURRENT_EVENT_SLUG, {
          kind: 'other', name: name.trim(), pitch: pitch.trim() || undefined, files,
        });
        await onDone(`${current ? '已换成' : '已提交'}「${name.trim()}」`);
      }
    } catch (e) {
      say(e instanceof Error ? e.message : '提交没成功', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={current ? '更换作品' : '提交作品'}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()} disabled={busy} style={{ width: '100%' }}>
            {busy ? '提交中…' : current ? '换成这个' : '提交'}
          </Button>
          <span style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            {fmtMd(cfg.deadlines.work)} 截止，截止前可以换。
          </span>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'page' as const, label: 'iSpace 页面' },
          { value: 'other' as const, label: '硬件或其他' },
        ]}
      />
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        {tab === 'page'
          ? '从你部署好的页面里选一个。参评的是提交那一刻的版本，之后再发布不影响。'
          : `传照片或视频，写清楚它是做什么的。${fmtMd(cfg.deadlines.award)} 带实物到场。`}
      </p>

      {tab === 'page' ? (
        apps === null ? (
          <Pulse />
        ) : apps.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            你还没有发布过页面。先把作品发到 iSpace，再回来提交。
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {apps.map((a) => {
              /*
                能不能选，只看两件可验证的事：页面没停用，且有发布成功的版本。
                「还在构建」的页面此刻没有可定格的版本号，选了等于交了个空壳。
              */
              const ok = a.status === 'running' && !!a.currentReleaseId;
              const on = pick === a.slug;
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={!ok}
                  onClick={() => setPick(a.slug)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                    padding: '12px 14px', borderRadius: 12, cursor: ok ? 'pointer' : 'not-allowed',
                    background: on ? 'var(--surface-2)' : 'var(--surface-1)',
                    border: `1px solid ${on ? 'var(--border-hover)' : 'var(--border-subtle)'}`,
                    color: ok ? 'var(--text-heading)' : 'var(--text-tertiary)',
                    font: 'inherit',
                  }}
                >
                  <span style={{
                    width: 18, height: 18, borderRadius: 100, flex: 'none', boxSizing: 'border-box',
                    border: on ? '5px solid var(--text-heading)'
                      : ok ? '1.5px solid var(--border-hover)' : '1.5px dashed var(--border-hover)',
                  }} />
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{a.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      /{a.slug}/ · {ok ? '可提交' : a.status === 'building' ? '还在构建，发布完成后才能提交' : '已停用'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )
      ) : (
        <>
          <Field label="作品名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="它叫什么" maxLength={60} />
          </Field>
          <FilePicker
            files={files}
            onChange={setFiles}
            max={9}
            label="照片、视频"
            hint="至少一张照片或一段视频"
            say={say}
          />
        </>
      )}

      <Field label="一句话介绍" hint="选填。会显示在入围名单和大屏上。">
        <Input value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="它解决什么问题" maxLength={200} />
      </Field>
    </Sheet>
  );
}

/** 附件选择。真上传，上传完才进列表——不做「假成功」的乐观 UI。 */
function FilePicker({
  files, onChange, max, label, hint, say,
}: {
  files: EventFile[];
  onChange: (f: EventFile[]) => void;
  max: number;
  label: string;
  hint: string;
  say: (m: string, tone?: 'info' | 'error') => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const add = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const room = max - files.length;
    if (room <= 0) { say(`最多 ${max} 个文件`, 'error'); return; }
    setBusy(true);
    const out: EventFile[] = [];
    for (const f of Array.from(picked).slice(0, room)) {
      try {
        out.push(await api.uploadEventFile(CURRENT_EVENT_SLUG, f));
      } catch (e) {
        say(`「${f.name}」没传上去：${e instanceof Error ? e.message : '未知原因'}`, 'error');
      }
    }
    if (out.length) onChange([...files, ...out]);
    setBusy(false);
    if (input.current) input.current.value = '';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,application/pdf"
        onChange={(e) => void add(e.target.files)}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
          padding: '14px 16px', borderRadius: 12, cursor: 'pointer',
          background: 'var(--surface-1)', border: '1px dashed var(--border-hover)',
          color: 'var(--text-heading)', font: 'inherit',
        }}
      >
        <EIcon name="upload" size={18} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {busy ? '上传中…' : files.length ? `已添加 ${files.length} 个 · 点击继续添加` : label}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{hint}</span>
        </span>
      </button>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {files.map((f) => (
            <div key={f.url} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)',
            }}>
              <span style={{
                flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{f.name}</span>
              <button
                type="button"
                onClick={() => onChange(files.filter((x) => x.url !== f.url))}
                aria-label={`移除 ${f.name}`}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 2,
                  color: 'var(--text-tertiary)', display: 'flex',
                }}
              >
                <EIcon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 小件 ──────────────────────────────────────────────────────────────

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', gap: 10,
      background: 'var(--surface-canvas)', padding: 24, textAlign: 'center',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
        {children}
      </div>
    </div>
  );
}

/** 转圈。自带关键帧，因为它也出现在整页渲染之前（那时 EventKeyframes 还没挂）。 */
function Pulse() {
  return (
    <>
      <EventKeyframes />
      <div
        aria-label="加载中"
        style={{
          width: 28, height: 28, borderRadius: 100,
          border: '2px solid var(--border)', borderTopColor: 'var(--tabby-orange)',
          animation: 'spin .8s linear infinite', margin: '12px auto',
        }}
      />
    </>
  );
}
