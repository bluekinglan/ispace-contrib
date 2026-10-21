import { useEffect, useState } from 'react';
import {
  CURRENT_EVENT_SLUG, EVENT_PATH,
  type EventPhase, type EventResponse,
} from '@ispace/contracts';
import { Button, Icon } from '@ispace/ui';
import { api } from '../api';
import { BitField } from './BitField';
import { EVENT_JUDGES } from './judges';
import { Caret, DOTS_ON_ORANGE, DotMatrix, EventKeyframes } from './visual';

/**
 * 「我的页面」顶部的 1024 腰带。
 *
 * ┌─ 它自己决定要不要出现 ────────────────────────────────────────────┐
 * │ 活动结束（phase='ended'）就整块不渲染——腰带自动下线，不需要有人     │
 * │ 在 11 月初记得回来删掉这段代码。拿不到活动数据也不渲染：首页不该      │
 * │ 因为一个活动接口抽风而多出一块报错。                                │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 文案跟着阶段走，并且**跟着「我」走**：还没交创意写「交创意报名」，交了
 * 写「已交创意『X』」。这一下不额外请求——活动接口本身就带 me 那一块。
 *
 * 版式照设计稿：一条横的，左边一块点阵 1024，中间 tag + 标题 + 一句说明，
 * 右边一颗按钮，整条都可以点。右侧那个出血的巨大 1024 是水印。
 */
/*
  上一次拿到的活动数据，以及点阵入场有没有放过。

  门户改成页面内切换之后，每回到一次探索，腰带就重新挂一次：原来它要等
  接口回来才画，于是每次都先没有、再"啪"地冒出来把整面墙往下推；点阵的
  逐格入场也每次重放一遍。两样叠在一起，看上去就是切菜单时那一下闪。
  所以：数据先用上一次的画（同时照样再问一次），入场只在这次打开门户时放一遍。
*/
let lastEvent: EventResponse | null = null;
let introPlayed = false;

export function EventBanner() {
  const [data, setData] = useState<EventResponse | null>(lastEvent);
  /* 挂载那一刻定下来：这一次要不要放入场。放过之后再挂就是静止的终态 */
  const [still] = useState(introPlayed);

  useEffect(() => {
    /*
      吞掉错误：这是首页上的一块装饰性入口，活动不存在、接口挂了、
      还没跑迁移，都该表现为「没有腰带」，而不是首页上一条报错。
    */
    void api.event(CURRENT_EVENT_SLUG)
      .then((r) => { lastEvent = r; setData(r); })
      .catch(() => { lastEvent = null; setData(null); });
  }, []);

  useEffect(() => { if (data) introPlayed = true; }, [data]);

  if (!data || data.event.phase === 'ended') return null;

  const copy = bannerCopy(data);
  const go = (hash?: string) => { location.href = EVENT_PATH + (hash ?? ''); };

  return (
    <div
      onClick={() => go()}
      style={{
        position: 'relative', overflow: 'hidden',
        /*
          这里的橙是写死的 #fb923c，不走 --tabby-orange。

          改版稿把品牌橙加深成了 #ee5c2a，但 1024 这条腰带在稿上仍是原来的
          浅橙——它是活动自己的颜色，和平台的品牌色是两回事。跟着 token 走
          的话，活动腰带会在改版当天悄悄变色，而设计稿里它没有变。
        */
        background: '#fb923c', borderRadius: 24,
        padding: '22px 28px', marginTop: 'var(--space-8)',
        display: 'flex', alignItems: 'center', gap: 36, flexWrap: 'wrap',
        cursor: 'pointer',
      }}
    >
      {/*
        点阵靠 commit 关键帧逐格入场。腰带挂在「我的页面」上，不经过活动页，
        所以这里要自己挂一份——否则 animation 指向一个不存在的名字，
        整块点阵会直接定在终态，少掉入场那一下。
      */}
      <EventKeyframes />

      {/* 指针扫过腰带时亮起的 0/1。半径比大页面小一圈，稿上是 120。 */}
      <BitField rgb="255,255,255" alpha={0.5} glow="255,255,255" glowAlpha={0.14} radius={120} />

      {/* 出血的巨大 1024。纯装饰，不可选中也不吃点击。 */}
      <span aria-hidden="true" className="mono" style={{
        position: 'absolute', right: -28, top: '50%', transform: 'translateY(-50%)',
        fontWeight: 800, fontSize: 200, lineHeight: 1, letterSpacing: '-.06em',
        /* 同上：水印是腰带自己那块橙的深一档，不跟品牌 token。 */
        color: '#f97316',
        whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
      }}>1024</span>

      {/*
        点阵 1024，和活动详情页 hero 用的是同一个字模与同一套橙底配色——
        腰带是那一页的入口，两处的 1024 应该是同一个东西，不是一个点阵
        加一个排版字。

        格子取 8px：hero 那块是 13px 的主视觉，这里只是腰带上的一个记号，
        照搬会把整条压垮；但再往下到 6px，点阵就细得只剩一片纹理，远看认
        不出是 1024——而认得出才是换它的理由。8px 高 68px，与右边两行文案
        等高。
      */}
      <div style={{ position: 'relative', flex: 'none' }}>
        <DotMatrix size={8} gap={2} radius={2} palette={DOTS_ON_ORANGE} still={still} />
      </div>

      <div style={{
        position: 'relative', flex: 1, minWidth: 260,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/*
            阶段标签后面跟一个终端光标，和活动页标题后面那颗是同一个组件。
            它说明这个阶段是**活的**——报名中就是此刻还能报，不是一块写死的
            状态牌；阶段一翻页，这里的字跟着换，光标继续闪。
          */}
          <span style={{
            background: 'var(--text-heading)', color: '#fff', borderRadius: 100,
            padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          }}>{PHASE_LABEL[data.event.phase]}<Caret color="#fff" /></span>
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-heading)' }}>
            {copy.title}
          </span>
        </div>
        <span style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-heading)' }}>
          {copy.desc}
        </span>
      </div>

      <div style={{ position: 'relative', flex: 'none' }}>
        {/*
          按钮自己带目标小节的锚点，和整条腰带的「进活动页」不是一回事：
          stopPropagation 免得外层再跳一次，把锚点冲掉。
        */}
        <Button
          variant="primary"
          onClick={(e) => { e.stopPropagation(); go(copy.hash); }}
        >{copy.btn}</Button>
      </div>
    </div>
  );
}

/**
 * 侧栏底部那张 1024 卡（改版稿 §侧栏）。
 *
 * 和上面那条腰带是同一个入口的另一个形状：窄处放不下一条横幅，于是点阵
 * 摞成两行、文案压到三行。阶段、日期、按钮文字仍然来自同一个 bannerCopy，
 * 所以两处永远说同一件事——不会出现腰带写「去投票」而侧栏还写「看名单」。
 *
 * 侧栏收起（72px）时不渲染：这张卡没有"只剩一个图标"的形态，硬塞会把
 * 收起后的侧栏撑开。
 */
export function EventSideCard() {
  const [data, setData] = useState<EventResponse | null>(null);

  useEffect(() => {
    void api.event(CURRENT_EVENT_SLUG).then(setData).catch(() => setData(null));
  }, []);

  if (!data || data.event.phase === 'ended') return null;
  const copy = bannerCopy(data);
  const award = data.event.config.deadlines.award;

  return (
    <div
      onClick={() => { location.href = EVENT_PATH + (copy.hash ?? ''); }}
      style={{
        margin: '0 12px 12px', padding: 16, borderRadius: 18,
        background: '#fb923c', color: '#181715', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}
    >
      <EventKeyframes />
      <DotMatrix size={11} gap={3} radius={2} palette={DOTS_ON_ORANGE} stacked />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          fontSize: 22, fontWeight: 900, lineHeight: 1.1,
          letterSpacing: '-.02em', whiteSpace: 'nowrap',
        }}>
          程序员节<Caret color="#181715" />
        </span>
        <span style={{ fontSize: 14, fontWeight: 800 }}>
          AI 创新赛 · {PHASE_LABEL[data.event.phase]}
        </span>
      </span>
      <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'rgba(24,23,21,.78)' }}>
        {md(award)} 上午 现场路演
      </span>
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        height: 36, borderRadius: 10, background: '#181715', color: '#ffffff',
        fontSize: 13, fontWeight: 600,
      }}>
        {copy.btn}<Icon name="chevRight" size={15} />
      </span>
    </div>
  );
}

const PHASE_LABEL: Record<EventPhase, string> = {
  signup: '报名中',
  screening: '创意初筛',
  building: '入围制作',
  demo: '展示答辩',
  result: '结果公布',
  ended: '已结束',
};

/**
 * 每个阶段腰带上写什么。
 *
 * 措辞照设计稿，日期与件数一律从 config/stats 算——稿上是写死的演示数字，
 * 照抄过来就会出现「收到 42 个创意」而实际只有 7 个这种事。
 */
function bannerCopy(data: EventResponse): {
  title: string; desc: string; btn: string; hash?: string;
} {
  const { event, me, stats, finalists, awards } = data;
  const d = event.config.deadlines;
  const idea = me?.idea;

  switch (event.phase) {
    case 'signup':
      return idea
        ? {
            title: `已交创意「${idea.name}」`,
            desc: `${mdhm(d.idea)} 截止前可以改，${hm(d.screening)} 公布入围。`,
            btn: '进入活动页',
          }
        : {
            title: '1024 程序员节 · 交创意报名',
            desc: `1024·AI创新赛现已开放报名，提交创意即可参赛。${mdhm(d.idea)} 截止。`,
            btn: '活动详情',
          };
    case 'screening':
      return {
        title: `评委初筛中 · 今天 ${hm(d.screening)} 公布入围`,
        /* 评委人数走固定名册，与活动页一致；理由见 judges.ts */
        desc: `收到 ${stats.ideaCount} 个创意，${EVENT_JUDGES.length} 位评委投票选出入围名单。`,
        btn: '进入活动页',
      };
    case 'building':
      if (idea?.finalist) {
        return me?.work
          ? {
              title: `已交作品「${me.work.name}」`,
              desc: `${md(d.work)} 截止前都可以换，${md(d.award)} 上午现场路演。`,
              btn: '进入活动页',
            }
          : {
              title: '你的创意入围了',
              desc: `入围即得 ¥200 京东卡。${md(d.work)} 前交作品，${md(d.award)} 上午现场路演。`,
              btn: '提交作品',
            };
      }
      return {
        title: '入围名单公布了',
        desc: `${finalists.length} 个创意正在做，${mdhm(d.voteOpen)} 起可以投人气票，`
          + `${md(d.award)} 上午来${event.venue ? ` ${event.venue.replace(/^上午\s*/, '').split(' · ')[0]} ` : ''}看路演。`,
        btn: '看入围名单',
        hash: `#${SEC_WORKS}`,
      };
    case 'demo':
      return {
        /* startsAt 允许为空（阶段可以被手工钉住），那就不写时间 */
        title: event.startsAt ? `今天 ${hm(event.startsAt)} 现场路演` : '今天现场路演',
        desc: `${finalists.length} 个入围项目依次路演，评委现场打分；`
          + `最佳人气奖投票 ${hm(d.vote)} 截止。`,
        btn: '去投票',
        hash: `#${SEC_WORKS}`,
      };
    case 'result': {
      const first = awards?.[0];
      return {
        title: '获奖名单公布了',
        desc: first
          ? `${first.name}「${first.ideaName}」${first.who}。一二三等奖和最佳人气奖都在活动页。`
          : '一二三等奖和最佳人气奖都在活动页。',
        btn: '看获奖名单',
        hash: `#${SEC_RESULTS}`,
      };
    }
    default:
      return { title: '1024 程序员节', desc: '本届已结束。', btn: '活动详情' };
  }
}

/* 与 Activity 里的 SEC 对应。那边是私有的，这里只用到两个，就地写明。 */
const SEC_WORKS = 'ev-sec-works';
const SEC_RESULTS = 'ev-sec-results';

function parts(iso: string, opts: Intl.DateTimeFormatOptions) {
  const p = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...opts })
    .formatToParts(new Date(iso));
  return (t: string) => p.find((x) => x.type === t)?.value ?? '';
}

/** 10.19 */
function md(iso: string): string {
  const g = parts(iso, { month: '2-digit', day: '2-digit' });
  return `${g('month')}.${g('day')}`;
}

/** 12:00 */
function hm(iso: string): string {
  const g = parts(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${g('hour')}:${g('minute')}`;
}

/** 10.19 12:00 */
function mdhm(iso: string): string {
  return `${md(iso)} ${hm(iso)}`;
}
