import { useEffect, useState } from 'react';
import { CURRENT_EVENT_SLUG, type EventResponse } from '@ispace/contracts';
import { api } from '../api';
import {
  BinaryTen, Caret, DOTS_ON_SCREEN, DotMatrix, EventKeyframes, Mark,
} from './visual';

/**
 * 会议室大屏背景墙（/1024/screen）。
 *
 * 1920 × 1080 横屏，投在三楼大会议室那块屏上当背景。不是一个「页面」——
 * 它是一张会动的海报：没有导航、没有按钮、没有滚动，打开就是全屏。
 *
 * ┌─ 为什么不直接导出一张 PNG ────────────────────────────────────────┐
 * │ 因为底部那行字要跟着活动走：报名期写「还有 N 天截止交创意」，当天   │
 * │ 写「8 个入围项目现场路演」，颁完奖写冠军是谁。做成页面，主持人把    │
 * │ 浏览器全屏一放就不用再管；做成图片，每换一个阶段就要重新导一张。    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 等比缩放：固定 1920×1080 画布 + transform: scale，让它在任何分辨率的
 * 屏幕上都保持设计稿的比例与留白。会议室那块屏多半不是正好 1080p，
 * 而按百分比重排会把 168px 的大字挤成另一个样子。
 */

const W = 1920;
const H = 1080;

/** 大屏上的深色，不走 token：这一页是独立的一张海报，不跟随平台主题。 */
const INK = '#1c1f23';

export function Screen() {
  const [data, setData] = useState<EventResponse | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    /*
      活动当天这一页会在屏上挂一整天，中间会经历「路演中 → 已颁奖」。
      每分钟拉一次，主持人不用记得去刷新。一天 ~600 次请求，可以忽略。
    */
    const pull = () => { void api.event(CURRENT_EVENT_SLUG).then(setData).catch(() => undefined); };
    pull();
    const t = setInterval(pull, 60_000);
    return () => clearInterval(t);
  }, []);

  /* 背景墙铺满整个视口，四周的黑边由 body 背景补齐 */
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = '#000';
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.background = prev; document.body.style.overflow = ''; };
  }, []);

  const ev = data?.event;
  const cfg = ev?.config;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <EventKeyframes />
      {/*
        定位方式是刻意的：画布比视口大，用 flex/grid 居中一个超尺寸子元素，
        各浏览器对「两边都溢出」的处理并不一致，实测会偏到一边去。
        绝对定位到中心点再 translate(-50%,-50%) 则与尺寸无关，缩放前后
        中心始终是视口中心。
      */}
      <div style={{
        position: 'absolute', left: '50%', top: '50%',
        width: W, height: H,
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: 'center',
        boxSizing: 'border-box',
        padding: '80px 96px',
        backgroundColor: '#fb923c',
        backgroundImage: 'radial-gradient(#f97316 1.5px, transparent 1.5px)',
        backgroundSize: '26px 26px',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        fontFamily: 'var(--font-sans)', color: INK,
      }}>
        {/* 出血的巨大 1024 与圆环，纯装饰 */}
        <span aria-hidden="true" className="mono" style={{
          position: 'absolute', right: -70, bottom: -230, fontWeight: 800, fontSize: 1180,
          lineHeight: 1, letterSpacing: '-.08em', color: 'rgba(249,115,22,.35)',
          whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
        }}>1024</span>
        <span aria-hidden="true" style={{
          position: 'absolute', left: -200, top: 540, width: 640, height: 640,
          borderRadius: '50%', border: '16px solid rgba(249,115,22,.35)',
          boxSizing: 'border-box', pointerEvents: 'none',
        }} />

        {/* 顶部：届次 + iSpace 字标 */}
        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 24,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            {/*
              公司标识。放在白底卡片里，因为它是深色图，直接压在橙底上会糊。
              onError 隐藏自己：少一张图不该让背景墙顶上留个破图图标——
              这块屏会在会议室里挂一整天，没人会盯着它救场。
            */}
            <div style={{
              background: '#fff', borderRadius: 16, padding: '10px 18px',
              display: 'flex', alignItems: 'center',
            }}>
              <img
                src="/event-logo.png"
                alt=""
                onError={(e) => { e.currentTarget.parentElement!.style.display = 'none'; }}
                style={{ height: 48, width: 'auto', display: 'block' }}
              />
            </div>
            <span className="mono" style={{
              background: INK, color: '#fff', borderRadius: 100,
              padding: '10px 22px', fontSize: 24, fontWeight: 700,
            }}>{ev?.edition ?? '第 8 届 · 2026'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Mark size={44} tone="dark" />
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 32 }}>iSpace</span>
          </div>
        </div>

        {/* 中部：点阵 1024 + 标题 */}
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 40 }}>
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
              }}>
                {ev?.title ?? '程序员节'}<Caret color={INK} />
              </span>
            </div>
          </div>
          <span style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.2 }}>
            {ev?.subtitle ?? '灵感上线・AI 不设限'}
          </span>
        </div>

        {/* 底部：跟着阶段走的一行 */}
        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 32,
        }}>
          <span style={{ fontSize: 36, fontWeight: 700 }}>{headline(data)}</span>
          <span className="mono" style={{ fontSize: 36, fontWeight: 700, whiteSpace: 'nowrap' }}>
            {cfg ? `${monthDay(cfg.deadlines.award)} · ${ev?.venue ?? ''}` : '10.23 · 三楼大会议室'}
          </span>
        </div>
      </div>
    </div>
  );
}

function monthDay(iso: string): string {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('month')}.${get('day')}`;
}

/**
 * 底部那行字。活动当天这块屏一直亮着，这一行是它唯一会变的地方。
 *
 * 数据还没到位时给设计稿上那句静态文案——大屏上宁可显示一句笼统但正确的
 * 话，也不能闪一下空白。
 */
function headline(data: EventResponse | null): string {
  if (!data) return '1024·AI创新赛 · 8 个入围项目现场路演';
  const { event, stats, finalists, awards } = data;
  switch (event.phase) {
    case 'signup': {
      const days = Math.max(0, Math.ceil(
        (Date.parse(event.config.deadlines.idea) - Date.parse(event.now)) / 86_400_000,
      ));
      return days > 0
        ? `1024·AI创新赛 · 交创意报名中，还有 ${days} 天`
        : '1024·AI创新赛 · 今天截止交创意';
    }
    case 'screening':
      return `1024·AI创新赛 · ${stats.ideaCount} 个创意参赛，评委初筛中`;
    case 'building':
      return `1024·AI创新赛 · ${finalists.length} 个项目入围，备战路演`;
    case 'demo':
      return `1024·AI创新赛 · ${finalists.length} 个入围项目现场路演`;
    case 'result': {
      const first = awards?.[0];
      return first
        ? `1024·AI创新赛 · ${first.name}「${first.ideaName}」${first.who}`
        : '1024·AI创新赛 · 颁奖完成';
    }
    default:
      return '1024·AI创新赛 · 明年见';
  }
}
