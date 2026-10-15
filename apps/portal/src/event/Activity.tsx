import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CURRENT_EVENT_SLUG, EVENT_PATH, phaseAtLeast,
  type App as AppEntity, type EventConfig, type EventFile, type EventFinalist,
  type EventPhase, type EventResponse,
} from '@ispace/contracts';
import { Avatar, Badge, Button, GlobalKeyframes, Input, Tabs, Toast, ToneProvider } from '@ispace/ui';
import { api } from '../api';
import {
  AsciiBits, BinaryTen, Caret, DOTS_ON_ORANGE, DotMatrix, EIcon, EventKeyframes,
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

/** 手机设计稿的内容宽度。电脑上打开就居中成这么一条，不拉伸成宽屏。 */
const COL = 460;

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

  if (err) {
    return (
      <Center>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-md)' }}>{err}</p>
        <a href="/" style={{ fontSize: 'var(--text-sm)', color: 'var(--link)' }}>回 iSpace</a>
      </Center>
    );
  }
  if (!data) return <Center><Pulse /></Center>;

  const { event, stats, finalists, awards, judges, me } = data;
  const phase = event.phase;
  const cfg = event.config;

  /* 小节编号连续递增：入围名单/获奖名单在前，怎么参加、奖项、日程跟在后面。 */
  let n = 0;
  const no = () => `0x0${(n += 1)}`;

  const showCards = (phase === 'building' || phase === 'demo') && finalists.length > 0;
  const showAwards = phaseAtLeast(phase, 'result') && !!awards?.length;
  const showRules = phase === 'signup' || phase === 'screening' || phase === 'building';

  return (
    <ToneProvider tone="business">
      <GlobalKeyframes />
      <EventKeyframes />
      <div style={{ minHeight: '100vh', background: 'var(--surface-canvas)' }}>
        <div style={{
          maxWidth: COL, margin: '0 auto', minHeight: '100vh',
          background: 'var(--surface-canvas)', position: 'relative',
          /* 底部操作栏是固定定位的，给内容留出等高的垫子，免得压住最后一行 */
          paddingBottom: phase === 'result' || phase === 'ended' ? 24 : 92,
        }}>
          <Hero data={data} />

          <div style={{ padding: '26px 16px 28px', display: 'flex', flexDirection: 'column', gap: 32 }}>
            {showCards && (
              <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHead
                  no={no()}
                  title={phase === 'building' ? '入围名单' : '今天路演的作品'}
                  sub={phase === 'building'
                    ? `${finalists.length} 个创意入围，编号就是 ${fmtMd(cfg.deadlines.award)} 的路演顺序 · ${fmtMd(cfg.deadlines.work)} 前交作品`
                    : `${finalists.length} 件 · 扫码投票选最佳人气奖，每人 ${cfg.voteLimit} 票，不能投给自己`}
                />
                {phase === 'building' && (
                  <Progress done={stats.workCount} total={finalists.length} />
                )}
                <FinalistCards
                  data={data}
                  onVoted={load}
                  say={say}
                />
              </section>
            )}

            {showAwards && (
              <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHead
                  no={no()}
                  title="获奖名单"
                  sub={`${fmtMdHm(cfg.deadlines.award)} 公布 · 评委 ${stats.judgeCount} 人 · 投票 ${stats.voteTotal} 张`}
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

            <PrizesSection no={no()} cfg={cfg} judges={judges} awardDate={fmtMd(cfg.deadlines.award)} />

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

          <BottomBar
            data={data}
            onIdea={() => (me ? setSheet('idea') : gotoLogin())}
            onWork={() => (me ? setSheet('work') : gotoLogin())}
          />
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

function Hero({ data }: { data: EventResponse }) {
  const { event, stats, finalists, awards, me } = data;
  const cfg = event.config;
  const phase = event.phase;
  const si = stepIndex(phase);
  const done = phaseAtLeast(phase, 'result');

  const count = countdown(data);
  const mine = myStatus(data);

  return (
    <header style={{
      position: 'relative', overflow: 'hidden',
      backgroundColor: 'var(--tabby-orange)',
      backgroundImage: 'radial-gradient(var(--tabby-orange-hover) 1.2px, transparent 1.2px)',
      backgroundSize: '20px 20px',
      padding: '20px 18px 18px',
    }}>
      {/* 出血的巨大 1024。纯装饰，不可选中也不吃点击。 */}
      <span aria-hidden="true" className="mono" style={{
        position: 'absolute', right: -46, top: 150, fontWeight: 800, fontSize: 230,
        lineHeight: 1, letterSpacing: '-.06em', color: 'var(--tabby-orange-hover)',
        whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
      }}>1024</span>

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 18 }}>
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
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 14, color: 'var(--text-heading)' }}>
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

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          {event.edition && (
            <span className="mono" style={{
              background: 'var(--text-heading)', color: '#fff', borderRadius: 100,
              padding: '4px 10px', fontSize: 11,
            }}>{event.edition}</span>
          )}
          <AsciiBits color="var(--text-heading)" />
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ paddingBottom: 4 }}>
            <DotMatrix size={6} gap={2} radius={1.5} palette={DOTS_ON_ORANGE} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <BinaryTen size={9} gap={3} color="var(--text-heading)" />
            </span>
            <span style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: 'var(--text-heading)' }}>
              {event.title}<Caret color="var(--text-heading)" />
            </span>
          </div>
        </div>

        {event.subtitle && (
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-heading)' }}>
            {event.subtitle}
          </span>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          fontSize: 12, fontWeight: 600, color: 'var(--text-heading)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <EIcon name="calendar" size={14} /><span>{cfg.dateLabel}</span>
          </span>
          {event.venue && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <EIcon name="pin" size={14} /><span>{event.venue}</span>
            </span>
          )}
        </div>

        {/* 当前阶段卡：倒数 + 我的状态。整页唯一一处随「我」变化的地方。 */}
        <div style={{
          marginTop: 4, background: 'var(--surface-1)', borderRadius: 16,
          padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
          boxShadow: 'var(--shadow-card)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '.05em',
              textTransform: 'uppercase', color: 'var(--text-tertiary)',
            }}>当前阶段</span>
            <Badge tone="brand" dot>{PHASE_LABEL[phase]}</Badge>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono" style={{
              fontSize: 36, fontWeight: 700, lineHeight: 1, color: 'var(--text-heading)',
            }}>{count.num}</span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{count.unit}</span>
          </div>
          <div style={{ height: 1, background: 'var(--border-subtle)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>{mine.title}</span>
            <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{mine.hint}</span>
          </div>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, marginTop: 2,
        }}>
          {STEP_NAMES.map((name, i) => {
            const cur = i === si && !done;
            const past = i < si || done;
            return (
              <div key={name} style={{
                minWidth: 0, borderRadius: 10, padding: 8,
                display: 'flex', flexDirection: 'column', gap: 2,
                background: cur ? 'var(--text-heading)' : past ? 'rgba(255,255,255,.32)' : 'transparent',
                border: `1px solid ${cur ? 'var(--text-heading)' : past ? 'transparent' : 'rgba(0,18,23,.22)'}`,
                color: cur ? '#fff' : 'var(--text-heading)',
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{name}</span>
                <span className="mono" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
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

const PHASE_LABEL: Record<EventPhase, string> = {
  signup: '报名中',
  screening: '评委初筛',
  building: '入围制作',
  demo: '展示答辩',
  result: '结果公布',
  ended: '已结束',
};

/** 大数字 + 一句说明。每个阶段数的是不同的东西。 */
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
  const voting = event.phase === 'demo';
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
    <>
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
    </>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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

// ── 怎么参加 ──────────────────────────────────────────────────────────

function HowSection({ no, cfg }: { no: string; cfg: EventConfig }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHead no={no} title="怎么参加" />
      {cfg.how.map((h, i) => (
        <div key={h.title} style={{
          display: 'flex', gap: 12, background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 14,
        }}>
          <span style={{
            width: 36, height: 36, flex: 'none', borderRadius: 10,
            background: i === 0 ? 'var(--tabby-orange)' : 'var(--surface-2)',
            color: 'var(--text-heading)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <EIcon name={(h.icon as EventIconName) ?? 'idea'} size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)' }}>{h.title}</span>
              <span className="mono" style={{ flex: 'none', fontSize: 11, color: 'var(--text-secondary)' }}>
                {h.date}
              </span>
            </div>
            <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{h.desc}</span>
          </div>
        </div>
      ))}
      <div style={{
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        borderRadius: 14, padding: '6px 16px',
      }}>
        {cfg.rules.map((t, i) => (
          <div key={t} style={{
            display: 'flex', gap: 10, padding: '10px 0',
            borderBottom: i === cfg.rules.length - 1 ? 'none' : '1px solid var(--border-subtle)',
          }}>
            <span className="mono" style={{
              flex: 'none', fontSize: 11, color: 'var(--text-tertiary)', paddingTop: 2,
            }}>{`0${i + 1}`}</span>
            <span style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)' }}>{t}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── 奖项与评选 ────────────────────────────────────────────────────────

function PrizesSection({
  no, cfg, judges, awardDate,
}: {
  no: string; cfg: EventConfig; judges: EventResponse['judges']; awardDate: string;
}) {
  const TONE: Record<EventPrize['tone'], { bg: string; bd: string; fg: string }> = {
    brand:  { bg: 'var(--tabby-orange)', bd: 'var(--tabby-orange)', fg: 'var(--text-heading)' },
    dark:   { bg: 'var(--dark-bg)', bd: 'var(--dark-bg)', fg: '#ffffff' },
    subtle: { bg: 'var(--tabby-orange-subtle)', bd: 'rgba(251,146,60,.35)', fg: 'var(--text-heading)' },
    plain:  { bg: 'var(--surface-1)', bd: 'var(--border-subtle)', fg: 'var(--text-heading)' },
  };
  const ICONS: EventIconName[] = ['trophy', 'medal', 'award', 'heart', 'card'];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHead no={no} title="奖项与评选" />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {cfg.prizes.map((p, i) => {
          const t = TONE[p.tone] ?? TONE.plain;
          return (
            <div key={p.name} style={{
              background: t.bg, border: `1px solid ${t.bd}`, color: t.fg,
              borderRadius: 14, padding: '12px 14px',
              display: 'flex', flexDirection: 'column', gap: 4,
              /* 一等奖占满一行：它是这组里唯一的主角 */
              gridColumn: i === 0 ? 'span 2' : 'auto',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <EIcon name={ICONS[i] ?? 'award'} size={18} />
                <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, opacity: 0.72 }}>{p.count}</span>
              </div>
              <span className="mono" style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>
                {p.money}
              </span>
              <span style={{ fontSize: 11, lineHeight: 1.5, opacity: 0.8 }}>{p.how}</span>
            </div>
          );
        })}
      </div>

      {judges.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>
            评委 · {judges.length} 位
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {judges.map((j) => (
              <span key={j.username} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
                borderRadius: 100, padding: '4px 10px 4px 4px',
              }}>
                <Avatar name={j.displayName} size={22} />
                <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{j.displayName}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        borderRadius: 14, padding: '6px 16px',
      }}>
        <div style={{
          padding: '10px 0', borderBottom: '1px solid var(--border-subtle)',
          fontSize: 13, fontWeight: 600, color: 'var(--text-heading)',
        }}>
          {awardDate} 答辩怎么打分
        </div>
        {cfg.criteria.map((c, i) => (
          <div key={c.key} style={{
            display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 0',
            borderBottom: i === cfg.criteria.length - 1 ? 'none' : '1px solid var(--border-subtle)',
          }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{c.key}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.desc}</span>
            </div>
            <span className="mono" style={{
              flex: 'none', fontSize: 12, fontWeight: 700, color: 'var(--text-heading)',
            }}>{c.max} 分</span>
          </div>
        ))}
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
        路演作品全靠评委打分排名次，定一、二、三等奖；现场扫码投票只用来选最佳人气奖。
      </p>
    </section>
  );
}

type EventPrize = EventConfig['prizes'][number];

// ── 日程 ──────────────────────────────────────────────────────────────

function ScheduleSection({ no, cfg }: { no: string; cfg: EventConfig }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHead no={no} title={`${fmtMd(cfg.deadlines.award)} 线下`} />
      {cfg.schedule.map((block) => (
        <div key={block.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}>{block.label}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{block.time}</span>
          </div>
          <div style={{
            background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
            borderRadius: 14, padding: '6px 14px',
          }}>
            {block.rows.map((r, i) => (
              <div key={`${r.time}${r.title}`} style={{
                display: 'flex', gap: 10, padding: '10px 0',
                borderBottom: i === block.rows.length - 1 ? 'none' : '1px solid var(--border-subtle)',
              }}>
                <span className="mono" style={{
                  flex: 'none', width: 40, fontSize: 11, fontWeight: 600,
                  color: 'var(--text-heading)', paddingTop: 3,
                }}>{r.time}</span>
                <span style={{
                  width: 26, height: 26, flex: 'none', borderRadius: 8,
                  background: r.icon === 'gift' || r.icon === 'mail'
                    ? 'var(--tabby-orange-subtle)' : 'var(--surface-2)',
                  color: 'var(--text-heading)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <EIcon name={(r.icon as EventIconName) ?? 'zap'} size={15} />
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>{r.title}</span>
                  <span style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{r.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

// ── 底部操作栏 ────────────────────────────────────────────────────────

function BottomBar({
  data, onIdea, onWork,
}: {
  data: EventResponse; onIdea: () => void; onWork: () => void;
}) {
  const { event, me } = data;
  const { phase, config: cfg } = event;
  if (phase === 'result' || phase === 'ended') return null;

  const judgeLink = me?.isJudge || me?.isAdmin;
  const left = me ? cfg.voteLimit - me.votes.length : cfg.voteLimit;

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 20,
      display: 'flex', justifyContent: 'center',
      background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      borderTop: '1px solid var(--border-subtle)',
      /* 刘海屏的手势条要让位，否则按钮被压在横条下面点不着 */
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    }}>
      <div style={{
        width: '100%', maxWidth: COL, padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {judgeLink && phase === 'demo' && (
          <a href={`${EVENT_PATH}/judge`} style={{
            display: 'flex', alignItems: 'center', gap: 10, minHeight: 44,
            boxSizing: 'border-box', borderRadius: 12, padding: '10px 14px',
            background: 'var(--tabby-orange-subtle)', border: '1px solid rgba(251,146,60,.35)',
            textDecoration: 'none',
          }}>
            <span style={{ display: 'flex', color: 'var(--tabby-orange-hover)' }}>
              <EIcon name="clipboard" size={18} />
            </span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>
              你是本届评委 · 去打分
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>→</span>
          </a>
        )}

        {(phase === 'signup') && (
          <Button variant="primary" onClick={onIdea} style={{ width: '100%' }}>
            {me?.idea ? '修改创意' : '提交创意'}
          </Button>
        )}

        {phase === 'screening' && (
          <p style={{ margin: 0, textAlign: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
            创意已截止，{fmtHm(cfg.deadlines.screening)} 公布入围名单
          </p>
        )}

        {phase === 'building' && (
          me?.idea?.finalist ? (
            <Button variant="primary" onClick={onWork} style={{ width: '100%' }}>
              {me.work ? '更换作品' : '提交作品'}
            </Button>
          ) : (
            <p style={{ margin: 0, textAlign: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
              入围作者可在 {fmtMd(cfg.deadlines.work)} 前提交作品
            </p>
          )
        )}

        {phase === 'demo' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}>
                {me ? (left > 0 ? `还有 ${left} 票` : `${cfg.voteLimit} 票已投完`) : `每人 ${cfg.voteLimit} 票`}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {fmtHm(cfg.deadlines.vote)} 截止 · 不能投给自己
              </span>
            </div>
            <div style={{ display: 'flex', gap: 5, flex: 'none' }}>
              {Array.from({ length: cfg.voteLimit }, (_, i) => (
                <span key={i} style={{
                  width: 10, height: 10, borderRadius: 100,
                  background: me && i < me.votes.length ? 'var(--tabby-orange)' : 'var(--surface-3)',
                }} />
              ))}
            </div>
            {!me && (
              <Button variant="primary" size="sm" onClick={gotoLogin}>登录后投票</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 底部弹层（提交创意 / 提交作品）────────────────────────────────────

/**
 * 从底部升起的面板。
 *
 * 没用 @ispace/ui 的 Dialog：那个是桌面模态（居中、固定宽度 440）。
 * 手机上表单该贴着拇指从下方升起，而且内容高度不定要能滚。
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
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(0,18,23,.42)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: COL, maxHeight: '92vh',
          background: 'var(--surface-canvas)',
          borderRadius: '18px 18px 0 0',
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-elevated)',
          animation: 'sheetUp .28s cubic-bezier(.16,1,.3,1) both',
        }}
      >
        <style>{'@keyframes sheetUp{from{transform:translateY(16px);opacity:.6}to{transform:none;opacity:1}}'}</style>
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
