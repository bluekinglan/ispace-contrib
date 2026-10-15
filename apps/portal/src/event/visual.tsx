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

/** 深色点阵（橙底上用），移动端活动页的配色。 */
export const DOTS_ON_ORANGE = {
  on: ['#000a0d', '#001217', 'rgba(0,18,23,.84)'] as [string, string, string],
  off: 'rgba(0,18,23,.18)',
};

/** 大屏背景墙的配色：同样是橙底，但格子大、对比略低。 */
export const DOTS_ON_SCREEN = {
  on: ['#0d0d10', '#1c1f23', 'rgba(28,31,35,.84)'] as [string, string, string],
  off: 'rgba(28,31,35,.18)',
};

export function DotMatrix({ size, gap, palette, radius }: {
  size: number;
  gap: number;
  palette: { on: [string, string, string]; off: string };
  radius: number;
}) {
  return (
    <div
      role="img"
      aria-label="1024"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${DOT_COLS}, ${size}px)`,
        gap,
      }}
    >
      {dots1024(palette).map((d, i) => (
        <span
          key={i}
          style={{
            width: size, height: size, borderRadius: radius, background: d.bg,
            animation: 'commit .45s cubic-bezier(.16,1,.3,1) both',
            animationDelay: d.delay,
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

/** 「1024」四个字符的 ASCII 位图，8 列 × 4 行。右上角那块小方阵。 */
export function AsciiBits({ color }: { color: string }) {
  const bits = '1024'
    .split('')
    .map((ch) => ch.charCodeAt(0).toString(2).padStart(8, '0'))
    .join('')
    .split('');
  return (
    <div
      aria-hidden="true"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 9px)', gap: 3, paddingTop: 2 }}
    >
      {bits.map((b, i) => (
        <span
          key={i}
          style={{
            width: 9, height: 9, borderRadius: 2, boxSizing: 'border-box',
            border: `1.5px solid ${color}`,
            background: b === '1' ? color : 'transparent',
            animation: 'commit .5s cubic-bezier(.16,1,.3,1) both',
            animationDelay: `${i * 45}ms`,
          }}
        />
      ))}
    </div>
  );
}

/** 闪烁的终端光标。跟在「程序员节」后面。 */
export function Caret({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block', width: '.4em', height: '.82em', background: color,
        borderRadius: '.05em', marginLeft: '.1em', verticalAlign: '-.01em',
        animation: 'blink 1.1s step-end infinite',
      }}
    />
  );
}

/** iSpace 的方块字标。深色版给大屏用，橙色版给活动页用。 */
export function Mark({ size, tone = 'orange' }: { size: number; tone?: 'orange' | 'dark' }) {
  const bg = tone === 'dark' ? '#1c1f23' : '#fb923c';
  return (
    <svg viewBox="0 0 1024 1024" style={{ width: size, height: size, flex: 'none', borderRadius: size * 0.27 }} aria-hidden="true">
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

/** 小节标题：橙色 0x 编号 + 标题。活动页每一段都用它开头。 */
export function SectionHead({ no, title, sub }: { no: string; title: string; sub?: ReactNode }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="mono" style={{
          background: 'var(--tabby-orange)', color: 'var(--text-heading)',
          borderRadius: 6, padding: '2px 7px', fontSize: 11, fontWeight: 700,
        }}>{no}</span>
        <span style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-heading)' }}>{title}</span>
      </div>
      {sub ? (
        <span style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>{sub}</span>
      ) : null}
    </>
  );
}
