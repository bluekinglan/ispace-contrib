import { useEffect, useState } from 'react';
import {
  CURRENT_EVENT_SLUG, EVENT_PATH,
  type EventPhase, type EventResponse,
} from '@ispace/contracts';
import { Button } from '@ispace/ui';
import { api } from '../api';
import { AsciiBits, EventKeyframes } from './visual';

/**
 * 「我的页面」顶部的 1024 横幅。
 *
 * ┌─ 它自己决定要不要出现 ────────────────────────────────────────────┐
 * │ 活动结束（phase='ended'）就整块不渲染——横幅自动下线，不需要有人     │
 * │ 在 11 月初记得回来删掉这段代码。拿不到活动数据也不渲染：首页不该      │
 * │ 因为一个活动接口抽风而多出一块报错。                                │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 文案跟着阶段走，并且**跟着「我」走**：还没交创意写「交创意报名」，交了
 * 写「已交创意『X』」。这一下不额外请求——活动接口本身就带 me 那一块。
 */
export function EventBanner() {
  const [data, setData] = useState<EventResponse | null>(null);

  useEffect(() => {
    /*
      吞掉错误：这是首页上的一块装饰性入口，活动不存在、接口挂了、
      还没跑迁移，都该表现为「没有横幅」，而不是首页上一条报错。
    */
    void api.event(CURRENT_EVENT_SLUG).then(setData).catch(() => setData(null));
  }, []);

  if (!data || data.event.phase === 'ended') return null;

  const { event, me, stats, finalists } = data;
  const copy = bannerCopy(event.phase, data);

  return (
    <div style={{
      position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-16)',
      backgroundColor: 'var(--tabby-orange)',
      backgroundImage: 'radial-gradient(var(--tabby-orange-hover) 1.2px, transparent 1.2px)',
      backgroundSize: '20px 20px',
      padding: 'var(--space-12) var(--space-12) var(--space-10)',
      marginTop: 'var(--space-12)',
      display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
    }}>
      <EventKeyframes />
      <span aria-hidden="true" className="mono" style={{
        position: 'absolute', right: -24, bottom: -58, fontWeight: 800, fontSize: 150,
        lineHeight: 1, letterSpacing: '-.06em', color: 'var(--tabby-orange-hover)',
        whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
      }}>1024</span>

      <div style={{
        position: 'relative', display: 'flex', alignItems: 'flex-start',
        gap: 'var(--space-6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', flex: 1, minWidth: 0 }}>
          <span className="mono" style={{
            fontWeight: 800, fontSize: 34, lineHeight: 0.9, letterSpacing: '-.04em',
            color: 'var(--text-heading)',
          }}>1024</span>
          <span style={{
            background: 'var(--text-heading)', color: '#fff', borderRadius: 100,
            padding: '3px 9px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          }}>{PHASE_LABEL[event.phase]}</span>
        </div>
        <AsciiBits color="var(--text-heading)" />
      </div>

      <span style={{
        position: 'relative', fontSize: 'var(--text-card-title)',
        fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)',
      }}>{copy.title}</span>
      <span style={{
        position: 'relative', maxWidth: 420, fontSize: 'var(--text-sm)',
        lineHeight: 1.6, color: 'var(--text-heading)',
      }}>{copy.desc}</span>

      <div style={{
        position: 'relative', display: 'flex', alignItems: 'center',
        gap: 'var(--space-6)', paddingTop: 'var(--space-2)',
      }}>
        <Button variant="primary" size="sm" onClick={() => { location.href = EVENT_PATH; }}>
          活动详情
        </Button>
        {(me?.isJudge || me?.isAdmin) && finalists.length > 0 && (
          <a href={`${EVENT_PATH}/judge`} style={{
            fontSize: 'var(--text-sm)', fontWeight: 600,
            color: 'var(--text-heading)', textDecoration: 'underline',
          }}>去打分</a>
        )}
        <span style={{ flex: 1 }} />
        <span className="mono" style={{
          fontSize: 'var(--text-xs)', color: 'var(--text-heading)', opacity: 0.66,
        }}>
          {event.phase === 'signup' ? `${stats.ideaCount} 个创意` : `${finalists.length} 个入围`}
        </span>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<EventPhase, string> = {
  signup: '报名中',
  screening: '评委初筛',
  building: '入围制作',
  demo: '今天路演',
  result: '已公布',
  ended: '已结束',
};

function bannerCopy(phase: EventPhase, data: EventResponse): { title: string; desc: string } {
  const { event, me, finalists, awards } = data;
  const d = event.config.deadlines;
  const idea = me?.idea;

  switch (phase) {
    case 'signup':
      return idea
        ? {
            title: `已交创意「${idea.name}」`,
            desc: `${md(d.idea)} 12:00 截止前可以改，当天下午公布入围名单。`,
          }
        : {
            title: '1024 程序员节 · 交创意报名',
            desc: `1024·AI创新赛现已开放报名，提交创意即可参赛。${md(d.idea)} 截止。`,
          };
    case 'screening':
      return {
        title: '创意已截止，评委初筛中',
        desc: `${md(d.screening)} 公布入围名单，入围即得 ¥200 京东卡。`,
      };
    case 'building':
      return idea?.finalist
        ? {
            title: `「${idea.name}」入围了`,
            desc: `${md(d.work)} 前提交作品，${md(d.award)} 上午现场路演。`,
          }
        : {
            title: `${finalists.length} 个项目入围`,
            desc: `${md(d.award)} 上午现场路演，全员扫码投票选最佳人气奖。`,
          };
    case 'demo':
      return {
        title: '今天路演，扫码投票',
        desc: `${finalists.length} 个入围项目现场演示，每人 ${event.config.voteLimit} 票选最佳人气奖。`,
      };
    case 'result': {
      const first = awards?.[0];
      return {
        title: first ? `${first.name}：${first.ideaName}` : '获奖名单已公布',
        desc: first ? `${first.who} · ${first.money}。点开看完整获奖名单。` : '点开看完整获奖名单。',
      };
    }
    default:
      return { title: '1024 程序员节', desc: '本届已结束。' };
  }
}

function md(iso: string): string {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('month')}.${get('day')}`;
}
