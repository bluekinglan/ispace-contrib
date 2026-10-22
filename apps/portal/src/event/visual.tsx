import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * 1024 活动页的视觉零件：点阵标题、二进制装饰、图标。
 *
 * 为什么图标不进 @ispace/ui 的 Icon：那一套是平台骨架在用的十来个（导航、
 * 搜索、关闭），加进二十多个只在一年一次的活动页里出现的图标，等于让所有
 * 页面都背着它们。形状仍然照设计稿的 path 搬，与 ui/icons.tsx 同一个做法。
 */

/**
 * 活动页用到的关键帧。
 *
 * 不并进 @ispace/ui 的 GlobalKeyframes：那三个是平台组件（对话框、骨架屏）
 * 在用的，而这三个只服务于 1024 的视觉——点阵逐格亮起、终端光标闪烁、
 * 加载转圈。活动过去了整块可以删掉，不必回去翻共享文件。
 */
export function EventKeyframes() {
  return (
    <style>{`
      @keyframes blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
      @keyframes commit { from { opacity: 0; transform: scale(.3) } to { opacity: 1; transform: scale(1) } }
      @keyframes spin { to { transform: rotate(360deg) } }
      @keyframes awardRise { from { opacity: 0; transform: translateY(40px) } to { opacity: 1; transform: none } }
    `}</style>
  );
}

// ── 点阵 1024 ─────────────────────────────────────────────────────────

/**
 * 5×7 的数字字模。设计稿里那块「1024」点阵标题就是按它点亮的。
 *
 * 注意 0 的中间那道对角线（`#..##` / `#.#.#` / `##..#`）：这是刻意的，
 * 让 0 不至于在点阵下和 O 混在一起，也是老式点阵屏的味道。
 */
const GLYPHS: Record<string, string[]> = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
};

export interface Dot {
  bg: string;
  delay: string;
}

/** 点阵的列数：四个字各 5 列，字间 1 列空隙 = 5×4 + 3。 */
export const DOT_COLS = 23;

/**
 * 把「1024」摊成一串按行优先排列的格子。
 *
 * `palette` 给的是点亮格子的三档深浅——设计稿用一个与坐标相关的伪随机值
 * 在三档里挑，让点阵看着像一面有层次的提交墙而不是一块纯色。随机数故意
 * 用 `(r*31 + c*17) % 7` 这样的确定式：每次渲染结果一致，不会在 React
 * 重渲染时闪成另一个花色。
 */
export function dots1024(palette: { on: [string, string, string]; off: string }): Dot[] {
  const cols: (boolean[] | null)[] = [];
  '1024'.split('').forEach((ch, i) => {
    if (i) cols.push(null);
    for (let c = 0; c < 5; c += 1) {
      cols.push(GLYPHS[ch]!.map((row) => row[c] === '#'));
    }
  });

  const out: Dot[] = [];
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < cols.length; c += 1) {
      const on = cols[c]?.[r] ?? false;
      const s = (r * 31 + c * 17) % 7;
      out.push({
        bg: on ? (s < 3 ? palette.on[0] : s < 5 ? palette.on[1] : palette.on[2]) : palette.off,
        delay: `${c * 40 + r * 12}ms`,
      });
    }
  }
  return out;
}

/**
 * 「1024」摞成两行两列，给窄处用（改版稿侧栏那张卡）。
 *
 * 13 列 = 1 + 5 + 1 + 5 + 1：两个字各 5 列，左右和中间各留一列空。上下也
 * 各留一行空，否则贴着卡片圆角会显得点阵被切了一刀。
 *
 * 与横版共用字模和那套确定式深浅，所以两处的 1024 是同一个东西——侧栏那张
 * 卡是探索页那条腰带的另一个形状，不是另一个记号。
 */
export const DOT_COLS_STACKED = 13;

export function dots1024Stacked(palette: { on: [string, string, string]; off: string }): Dot[] {
  const lines: (boolean[] | null)[] = [];
  for (const pair of [['1', '0'], ['2', '4']]) {
    const rows: boolean[][] = [];
    for (let r = 0; r < 7; r += 1) {
      const row: boolean[] = [false];
      for (const ch of pair) {
        for (let c = 0; c < 5; c += 1) row.push(GLYPHS[ch]![r]![c] === '#');
        row.push(false);
      }
      rows.push(row);
    }
    if (lines.length) lines.push(null);
    lines.push(...rows);
  }

  const grid: (boolean[] | null)[] = [null, ...lines, null];
  const out: Dot[] = [];
  grid.forEach((row, r) => {
    for (let c = 0; c < DOT_COLS_STACKED; c += 1) {
      const on = row?.[c] ?? false;
      const s = (r * 31 + c * 17) % 7;
      out.push({
        bg: on ? (s < 3 ? palette.on[0] : s < 5 ? palette.on[1] : palette.on[2]) : palette.off,
        delay: `${c * 40 + r * 12}ms`,
      });
    }
  });
  return out;
}

/**
 * 深色点阵（橙底上用），移动端活动页的配色。
 *
 * 墨色跟着改版稿换成了带褐的 #181715 一族——1024 的橙底没变，但底上的
 * 深色若还是原来带蓝的 #001217，两种"黑"同屏会显出一层脏。
 */
export const DOTS_ON_ORANGE = {
  on: ['#0d0c0b', '#181715', 'rgba(24,23,21,.84)'] as [string, string, string],
  off: 'rgba(24,23,21,.18)',
};

/** 大屏背景墙的配色：同样是橙底，但格子大、对比略低。 */
export const DOTS_ON_SCREEN = {
  on: ['#0d0d10', '#1c1f23', 'rgba(28,31,35,.84)'] as [string, string, string],
  off: 'rgba(28,31,35,.18)',
};

export function DotMatrix({ size, gap, palette, radius, solid = false, stacked = false, still = false }: {
  size: number;
  gap: number;
  palette: { on: [string, string, string]; off: string };
  radius: number;
  /** 让每个方块都成为 confetti-pile 的地面，雪会一格一格堆在上面。 */
  solid?: boolean;
  /** 两行两列的摞法，给侧栏这种窄处用。 */
  stacked?: boolean;
  /** 不放逐格入场，直接是终态。入场已经放过一遍、又被重新挂上时用。 */
  still?: boolean;
}) {
  return (
    <div
      role="img"
      aria-label="1024"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${stacked ? DOT_COLS_STACKED : DOT_COLS}, ${size}px)`,
        gap,
      }}
    >
      {(stacked ? dots1024Stacked(palette) : dots1024(palette)).map((d, i) => (
        <span
          key={i}
          data-solid={solid ? '0' : undefined}
          style={{
            width: size, height: size, borderRadius: radius, background: d.bg,
            ...(still ? {} : {
              animation: 'commit .45s cubic-bezier(.16,1,.3,1) both',
              animationDelay: d.delay,
            }),
          }}
        />
      ))}
    </div>
  );
}

// ── 二进制装饰 ────────────────────────────────────────────────────────

/**
 * 「1024 = 2¹⁰」：一个实心格 + 十个空心格，正好是 10000000000₂。
 *
 * 这不是随便摆的装饰——它就是 1024 这个数本身，所以格子数不能改。
 */
export function BinaryTen({ size, gap, color }: { size: number; gap: number; color: string }) {
  return (
    <span style={{ display: 'flex', gap, flex: 'none' }} aria-hidden="true">
      {Array.from({ length: 11 }, (_, i) => (
        <span
          key={i}
          style={{
            width: size, height: size, borderRadius: size / 4, boxSizing: 'border-box',
            background: i === 0 ? color : 'transparent',
            border: i === 0 ? undefined : `1.5px solid ${color}`,
          }}
        />
      ))}
    </span>
  );
}

/** 闪烁的终端光标。跟在「程序员节」后面。 */
/**
 * 标题末尾那个闪烁的光标。
 *
 * 尺寸没照抄设计稿的 `height:1em; vertical-align:-.12em`——那是按设计工具
 * 里的字体算的。我们这边中文落到 PingFang SC，汉字墨迹并不占满 1em：
 * 46px 下实测字形是基线上 38.1px、基线下 5.1px，而 1em 的光标是上 40.5、
 * 下 5.5，于是顶部多出 2.4px、底部只多 0.5px，看上去就是「光标偏上」。
 *
 * 这里按实测把它收成 .94em 并下移到 -.11em，上下沿与汉字对齐。用 em 而不是
 * px，三处调用（活动页 46px、背景墙 168px、颁奖屏 180px）按比例一致。
 */
export function Caret({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block', width: '.4em', height: '.94em', background: color,
        borderRadius: '.05em', marginLeft: '.1em', verticalAlign: '-.11em',
        animation: 'blink 1.1s step-end infinite',
      }}
    />
  );
}

/** iSpace 的方块字标。深色版给大屏用，橙色版给活动页用。 */
export function Mark({ size, tone = 'orange', solid = false }: {
  size: number; tone?: 'orange' | 'dark';
  /** 当 confetti-pile 的地面。 */
  solid?: boolean;
}) {
  const bg = tone === 'dark' ? '#1c1f23' : '#fb923c';
  return (
    <svg viewBox="0 0 1024 1024" data-solid={solid ? '0' : undefined} style={{ width: size, height: size, flex: 'none', borderRadius: size * 0.27 }} aria-hidden="true">
      <rect width="1024" height="1024" rx="276" fill={bg} />
      <path d="M216 304Q216 280 239 272L464 208Q488 201 488 226V766Q488 787 468 794L239 858Q216 865 216 840Z" fill="#ffffff" />
      <path d="M280 350L424 309V711L280 752Z" fill={bg} />
      <path d="M536 226Q536 201 560 208L785 272Q808 280 808 304V840Q808 865 785 858L556 794Q536 787 536 766Z" fill="#ffffff" />
      <path d="M600 309L744 350V752L600 711Z" fill={bg} />
    </svg>
  );
}

// ── 图标 ──────────────────────────────────────────────────────────────

export type EventIconName =
  | 'idea' | 'users' | 'code' | 'presentation' | 'mic' | 'ticket' | 'qr'
  | 'coffee' | 'gift' | 'trophy' | 'medal' | 'award' | 'heart' | 'cake'
  | 'flag' | 'mail' | 'utensils' | 'calendar' | 'pin' | 'card' | 'zap'
  | 'check' | 'x' | 'back' | 'upload' | 'settings' | 'clipboard' | 'lock' | 'ext';

type Shape = { d: string } | { c: [number, number, number] } | { r: [number, number, number, number, number] };

const P: Record<EventIconName, Shape[]> = {
  idea: [{ d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5' }, { d: 'M9 18h6' }, { d: 'M10 22h4' }],
  users: [{ d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }, { c: [9, 7, 4] }, { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }, { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
  code: [{ d: 'm16 18 6-6-6-6' }, { d: 'm8 6-6 6 6 6' }],
  presentation: [{ d: 'M2 3h20' }, { d: 'M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3' }, { d: 'm7 21 5-5 5 5' }],
  mic: [{ d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }, { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }, { d: 'M12 19v3' }],
  ticket: [{ d: 'M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z' }, { d: 'M13 5v2' }, { d: 'M13 17v2' }, { d: 'M13 11v2' }],
  qr: [{ d: 'M4 3h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }, { d: 'M17 3h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }, { d: 'M4 16h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z' }, { d: 'M21 16h-3a2 2 0 0 0-2 2v3' }, { d: 'M21 21v.01' }, { d: 'M12 7v3a2 2 0 0 1-2 2H7' }, { d: 'M3 12h.01' }, { d: 'M12 3h.01' }, { d: 'M12 16v.01' }, { d: 'M16 12h1' }, { d: 'M21 12v.01' }, { d: 'M12 21v-1' }],
  coffee: [{ d: 'M10 2v2' }, { d: 'M14 2v2' }, { d: 'M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1' }, { d: 'M6 2v2' }],
  gift: [{ r: [3, 8, 18, 4, 1] }, { d: 'M12 8v13' }, { d: 'M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7' }, { d: 'M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5' }],
  trophy: [{ d: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6' }, { d: 'M18 9h1.5a2.5 2.5 0 0 0 0-5H18' }, { d: 'M4 22h16' }, { d: 'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22' }, { d: 'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22' }, { d: 'M18 2H6v7a6 6 0 0 0 12 0V2Z' }],
  medal: [{ d: 'M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15' }, { d: 'M11 12 5.12 2.2' }, { d: 'm13 12 5.88-9.8' }, { d: 'M8 7h8' }, { c: [12, 17, 5] }, { d: 'M12 18v-2h-.5' }],
  award: [{ d: 'm15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526' }, { c: [12, 8, 6] }],
  heart: [{ d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z' }],
  cake: [{ d: 'M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8' }, { d: 'M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1' }, { d: 'M2 21h20' }, { d: 'M7 8v3' }, { d: 'M12 8v3' }, { d: 'M17 8v3' }, { d: 'M7 4h.01' }, { d: 'M12 4h.01' }, { d: 'M17 4h.01' }],
  flag: [{ d: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z' }, { d: 'M4 22v-7' }],
  mail: [{ r: [2, 4, 20, 16, 2] }, { d: 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7' }],
  utensils: [{ d: 'M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2' }, { d: 'M7 2v20' }, { d: 'M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7' }],
  calendar: [{ r: [3, 4, 18, 18, 2] }, { d: 'M16 2v4' }, { d: 'M8 2v4' }, { d: 'M3 10h18' }],
  pin: [{ d: 'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0' }, { c: [12, 10, 3] }],
  card: [{ r: [2, 5, 20, 14, 2] }, { d: 'M2 10h20' }],
  zap: [{ d: 'M13 2 3 14h7l-1 8 10-12h-7z' }],
  check: [{ d: 'M20 6 9 17l-5-5' }],
  x: [{ d: 'M18 6 6 18M6 6l12 12' }],
  back: [{ d: 'M19 12H5M12 19l-7-7 7-7' }],
  upload: [{ d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }, { d: 'm17 8-5-5-5 5' }, { d: 'M12 3v12' }],
  settings: [{ c: [12, 12, 3] }, { d: 'M12 3v2.5M12 18.5V21M4.5 7.5l2.2 1.3M17.3 15.2l2.2 1.3M4.5 16.5l2.2-1.3M17.3 8.8l2.2-1.3' }],
  clipboard: [{ r: [8, 2, 8, 4, 1] }, { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }, { d: 'M9 13h6' }, { d: 'M9 17h4' }],
  lock: [{ r: [5, 11, 14, 10, 2] }, { d: 'M8 11V7a4 4 0 0 1 8 0v4' }],
  ext: [{ d: 'M15 3h6v6' }, { d: 'M10 14 21 3' }, { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
};

export function EIcon({ name, size = 16, style }: { name: EventIconName; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={{ flex: 'none', ...style }}
    >
      {P[name].map((s, i) =>
        'd' in s ? <path key={i} d={s.d} />
        : 'c' in s ? <circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} />
        : <rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} />,
      )}
    </svg>
  );
}

/**
 * 小节标题。居中：编号 + 中文标题一行，底下一行英文副标题。
 *
 * `side` 是右侧那个贴边的小槽（入围进度之类）。它绝对定位在标题行右端，
 * 到 720px 以下回到标题下方正常流——窄屏上贴边放不下。
 */
export function SectionHead({ no, title, en, note, side }: {
  no: string;
  title: string;
  en: string;
  note?: ReactNode;
  side?: ReactNode;
}) {
  return (
    <div className="ev-section-head">
      <div className="ev-section-heading">
        <div className="ev-section-primary">
          <span className="ev-section-number">{no}</span>
          <span className="ev-section-title">{title}</span>
        </div>
        <span className="ev-section-en">{en}</span>
        {note ? <span className="ev-section-note">{note}</span> : null}
      </div>
      {side ? <div className="ev-section-side">{side}</div> : null}
    </div>
  );
}

// ── 作品附件 ──────────────────────────────────────────────────────────

/** 按后缀认类型。地址是服务端拼的 `…/files/{uuid}.{ext}`，后缀可信。 */
function fileKind(url: string): 'image' | 'video' | 'other' {
  const ext = (url.split('?')[0] ?? '').toLowerCase().slice(-4);
  if (ext === '.png' || ext === '.jpg' || ext === 'jpeg' || ext === 'webp' || ext === '.gif') return 'image';
  if (ext === '.mp4' || ext === '.mov') return 'video';
  return 'other';
}

/**
 * 附件查看器：点开一张之后能左右翻。
 *
 * 为什么要它：卡片上只摆得下一张封面（卡是定高的），多出来的收成一个
 * 「+N」。没有这个查看器，那个数字就只是个数字——点开永远是第一张，剩下
 * 几张没有任何入口。有人一口气传了 5 张，而评委和投票的人要看的恰恰是
 * 那几张。
 *
 * 不做成新标签页：翻页要回退再点下一张，五张图点十次。
 */
function FileViewer({ files, at, onAt, onClose }: {
  files: { name: string; url: string }[];
  at: number;
  onAt: (i: number) => void;
  onClose: () => void;
}) {
  const n = files.length;
  const cur = files[at];

  /* 左右翻页与 Esc。循环而不是到头停住——五张图来回比对时不用管在哪一端。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (n < 2) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); onAt((at + 1) % n); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); onAt((at - 1 + n) % n); }
    };
    document.addEventListener('keydown', onKey);
    /* 打开期间锁住背后的滚动，否则滚轮会在底下那一页上跑 */
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [at, n, onAt, onClose]);

  if (!cur) return null;
  const kind = fileKind(cur.url);
  const arrow = (dir: -1 | 1, label: string) => (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onAt((at + dir + n) % n); }}
      style={{
        position: 'absolute', top: '50%', transform: 'translateY(-50%)',
        [dir < 0 ? 'left' : 'right']: 'max(12px, 3vw)',
        width: 48, height: 48, borderRadius: 100, cursor: 'pointer',
        border: '1px solid rgba(255,255,255,.28)', background: 'rgba(0,18,23,.6)',
        color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, lineHeight: 1,
      }}
    >{dir < 0 ? '‹' : '›'}</button>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={cur.name}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,8,11,.92)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 'max(16px, 4vh) 72px',
        boxSizing: 'border-box',
      }}
    >
      {/* 顶栏：第几张、文件名、下载、关闭 */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 18px', color: 'rgba(255,255,255,.88)', fontSize: 13,
      }}>
        {n > 1 && <span className="mono" style={{ fontWeight: 700 }}>{at + 1} / {n}</span>}
        <span style={{
          flex: 1, minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.8,
        }}>{cur.name}</span>
        <a
          href={cur.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ color: 'var(--tabby-orange)', textDecoration: 'none', whiteSpace: 'nowrap' }}
        >原图</a>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          style={{
            width: 30, height: 30, borderRadius: 100, cursor: 'pointer', flex: 'none',
            border: '1px solid rgba(255,255,255,.28)', background: 'transparent',
            color: '#fff', fontSize: 16, lineHeight: 1,
          }}
        >×</button>
      </div>

      {/* 点图本身不关闭，只有点背景才关 */}
      <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '100%', display: 'flex' }}>
        {kind === 'image' && (
          <img
            src={cur.url}
            alt={cur.name}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}
          />
        )}
        {kind === 'video' && (
          /* 这里才自动播：全屏看的时候一次只有一个视频在解码 */
          <video src={cur.url} controls autoPlay style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} />
        )}
        {kind === 'other' && (
          <a href={cur.url} target="_blank" rel="noreferrer" style={{
            padding: '14px 20px', borderRadius: 12, color: '#fff',
            border: '1px solid rgba(255,255,255,.28)', textDecoration: 'none',
          }}>打开 {cur.name}</a>
        )}
      </div>

      {n > 1 && arrow(-1, '上一张')}
      {n > 1 && arrow(1, '下一张')}
    </div>
  );
}

/**
 * 作品的照片 / 视频缩略图。
 *
 * 硬件作品（kind='other'）没有可点开的链接，它的全部内容就是这几个文件。
 * 在补上这个之前，活动页和评委页都只显示一个作品名——大家照着名字投票，
 * 评委照着名字打分。
 *
 * 视频不在卡片上自动播：一屏十几张卡同时解码会把大屏拖垮，而且活动页在
 * 手机上也会被看。点一下在新标签打开，交给浏览器自己的播放器。
 */
export function WorkFiles({
  files, size = 56, dark = true, cover = false, coverHeight = 96, only = false,
}: {
  files: { name: string; url: string }[];
  size?: number;
  /** 深色卡片上用浅边框，浅色页面上用深边框 */
  dark?: boolean;
  /**
   * 把第一张图铺成整条宽图。
   *
   * 投票的人是靠看来决定投谁的，而硬件作品那张图就是作品本身——缩成一个
   * 小方块等于只告诉人「这儿有东西可点」。其余文件仍然排成小格跟在后面。
   */
  cover?: boolean;
  /** 宽图的高度。活动页的卡是定高的所以压得矮，评委页可以给足。 */
  coverHeight?: number;
  /**
   * 只放封面，其余文件收成封面右下角的一个数字。
   *
   * 活动页那张卡是定高 252px 的，封面之外再排一行小格就会把底下的作者和
   * 「投一票」挤出卡外——有人一口气传了 5 张，实测就是这样裁没的。密集的
   * 卡墙上一张封面足够，想看全的点开。评委页不定高，不要开这个。
   */
  only?: boolean;
}) {
  /* null = 没打开。索引是「在 files 里的第几个」，翻页就在整份 files 上走 */
  const [open, setOpen] = useState<number | null>(null);
  if (files.length === 0) return null;
  const border = dark ? 'rgba(255,255,255,.18)' : 'var(--border-subtle)';
  const fg = dark ? 'rgba(255,255,255,.72)' : 'var(--text-secondary)';
  /*
    左键点开查看器，而不是跳新标签——五张图要来回比对，走新标签得回退再点，
    点十次。按住 cmd / ctrl 或中键仍然照常在新标签打开，那是浏览器的约定，
    不该因为加了个查看器就没了。
  */
  const openAt = (i: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setOpen(i);
  };
  const lead = cover && files[0] && fileKind(files[0].url) === 'image' ? files[0] : null;
  const rest = only && lead ? [] : lead ? files.slice(1) : files;
  const more = only && lead ? files.length - 1 : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {lead && (
        <a
          href={lead.url}
          target="_blank"
          rel="noreferrer"
          title={lead.name}
          onClick={openAt(0)}
          style={{
            /*
              固定高度而不是 aspect-ratio：卡片是定高的（.ev-work-card 252px），
              由介绍那一块吸收伸缩。按比例算出来的高度不肯收缩，会把底下的作者
              和「投一票」整条挤出卡外——卡片 overflow:hidden，挤出去就是没了。
            */
            position: 'relative', display: 'block', width: '100%', height: coverHeight,
            flex: 'none', borderRadius: 12, border: `1px solid ${border}`,
            boxSizing: 'border-box', background: `center/cover url("${lead.url}")`,
          }}
        >
          {more > 0 && (
            <span style={{
              position: 'absolute', right: 6, bottom: 6, borderRadius: 100,
              padding: '2px 8px', background: 'rgba(0,18,23,.72)', color: '#fff',
              fontSize: 11, fontWeight: 700,
            }}>+{more}</span>
          )}
        </a>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {rest.map((f, k) => {
        const kind = fileKind(f.url);
        /* rest 可能掐掉了首图，索引要换算回整份 files 的下标 */
        const idx = lead ? k + 1 : k;
        return (
          <a
            key={f.url}
            href={f.url}
            target="_blank"
            rel="noreferrer"
            title={f.name}
            onClick={openAt(idx)}
            style={{
              position: 'relative', width: size, height: size, flex: 'none',
              borderRadius: 10, overflow: 'hidden', boxSizing: 'border-box',
              border: `1px solid ${border}`, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: kind === 'image' ? `center/cover url("${f.url}")` : 'transparent',
              color: fg, textDecoration: 'none',
            }}
          >
            {/* 视频和 PDF 没有缩略图，用图标顶上，别留一个空框 */}
            {kind !== 'image' && (
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <EIcon name={kind === 'video' ? 'presentation' : 'clipboard'} size={18} />
                <span style={{ fontSize: 9, fontWeight: 600 }}>
                  {kind === 'video' ? '视频' : '文件'}
                </span>
              </span>
            )}
          </a>
        );
      })}
      </div>
      {open !== null && (
        <FileViewer files={files} at={open} onAt={setOpen} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
