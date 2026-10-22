import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  LOTTERY_ALL, LOTTERY_BY_PID, LOTTERY_JACKPOT, LOTTERY_JP_EXCLUDE, LOTTERY_PEOPLE, LOTTERY_PRIZES, LOTTERY_PRIZE_BY_K,
  LOTTERY_REGULAR, LOTTERY_ROUNDS, lotteryRoundTitle, LOTTERY_ROUND_CN,
} from './lottery-data';
import { dots1024, DOTS_ON_SCREEN, Mark } from './visual';
/*
  <particle-text> 和 <confetti-burst> 用的是 effects.ts 里那两个——颁奖那边
  早就移植好并注册了（registerEventEffects，幂等）。这里不要再搬一份：
  自定义元素是全局注册表，同名注册两次直接抛。
*/
import { registerEventEffects } from './effects';

registerEventEffects();

/**
 * 全员抽奖（颁奖大屏的一步）。1920 × 1080，和颁奖共用同一块舞台。
 *
 * ┌─ 它和颁奖不是一回事 ──────────────────────────────────────────────┐
 * │ 颁奖是「念名单」：主持人每按一下走一步，内容是定好的。               │
 * │ 抽奖是**当场摇出来的**：按一下开始转，再按一下停，结果这一刻才产生， │
 * │ 而且要当着所有人的面产生——所以中间那段球体滚动不是装饰，它是「还    │
 * │ 没定」这件事的可见证明。少了它，抽奖和念一份早就写好的名单没区别。   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 五轮普通奖 + 一轮压轴（轮数见 lottery-data 的 LOTTERY_ROUNDS）：
 *   第一~五轮各 17 人，**人人有奖**（85 人），抽过的人不再进下一轮的池子；
 *   压轴从 83 人里重新抽 1 个 1024 红包（甜豆、小爱只参加普通轮），和普通
 *   轮的名额叠加。台上的字照组织者的意思写「全员 85 人」——说的是这场抽奖
 *   的全体，实际摇号的池子才是去掉两人的 83。
 *   代码里不写死轮次号：压轴是 LOTTERY_JACKPOT，普通轮是它之前的那些。
 *
 * 结果写 localStorage。这一点很重要：万一大屏那台机器在抽奖中途刷新了，
 * 已经抽出的轮次不能丢——当众重抽一遍，前面念过的名字就全不算数了。
 */

const W = 1920;
const H = 1080;
/** 球心。偏右，给左边那栏标题和按钮让出位置 */
const CX = 1220;
const CY = 570;
/** 透视焦距。越小越「鼓」，1500 是稿上的手感 */
const FOCAL = 1500;
/*
  v5（和 UI 稿同名）：10.21 普通轮从 4 轮改成 5 轮，轮次号的含义变了（原先
  第 5 轮是压轴，现在是第五轮普通奖）。换键名让旧存档自动作废，免得大屏把
  旧的压轴结果当成第五轮接着走。
*/
const STORE_KEY = 'ispace-1024-lottery-v5';

type Phase = 'ready' | 'rolling' | 'stopping' | 'reveal';
type Win = { pid: number; prize: string };
type Results = Record<number, Win[]>;

/** 一个人在球面上的运动状态。全是可变的，由 rAF 循环逐帧改写，不走 React。 */
interface Node {
  /** 当前方向（单位向量） */
  d: [number, number, number];
  /** 目标方向 */
  t: [number, number, number];
  /** 当前半径系数 */
  rf: number;
  /** 目标半径系数 */
  trf: number;
  vis: number;
  tvis: number;
  /** 呼吸相位，让每个人的浮动不同步 */
  ph: number;
  win: boolean;
  /** 压轴中奖者：独自飞到正中并放大 */
  solo: boolean;
  sb: number;
  el?: HTMLElement;
  flash?: HTMLElement | null;
  sx?: number;
  sy?: number;
  sc?: number;
}

export interface LotteryHandle {
  /**
   * 主操作（主持人按空格 / → / 点屏幕）。
   * 返回 false 表示抽奖已经走完，该把舞台交回典礼流程去切蛋糕。
   */
  primary: () => boolean;
  /** 回退一轮。返回 false 表示已经在第一轮，该退回上一屏。 */
  back: () => boolean;
}

/** 球面上均匀撒点用的黄金角 */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function randUnit(): [number, number, number] {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * 6.2832;
  const r = Math.sqrt(1 - u * u);
  return [r * Math.cos(a), u, r * Math.sin(a)];
}

/** 洗牌。`secure` 时用 crypto——真正决定谁中奖的那一次不能用 Math.random。 */
function shuffle<T>(arr: T[], secure = false): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    let j: number;
    if (secure) {
      const a = new Uint32Array(1);
      window.crypto.getRandomValues(a);
      j = a[0]! % (i + 1);
    } else {
      j = Math.floor(Math.random() * (i + 1));
    }
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

/** 第 r 轮要放出的奖品，按份数摊平成一个数组 */
function expand(r: number): string[] {
  const out: string[] = [];
  LOTTERY_PRIZES.forEach((p) => {
    for (let i = 0; i < p.r[r - 1]!; i += 1) out.push(p.k);
  });
  return out;
}

/**
 * 第 r 轮的候选池。压轴是重来一遍（不扣普通轮中过的人，只去掉
 * LOTTERY_JP_EXCLUDE），普通轮要扣掉已经中过的人。
 */
function poolFor(r: number, res: Results): number[] {
  if (r === LOTTERY_JACKPOT) {
    return LOTTERY_PEOPLE.filter((p) => LOTTERY_JP_EXCLUDE.indexOf(p.nick) < 0).map((p) => p.pid);
  }
  const used: Record<number, 1> = {};
  for (let k = 1; k < r; k += 1) (res[k] ?? []).forEach((x) => { used[x.pid] = 1; });
  return LOTTERY_PEOPLE.filter((p) => !used[p.pid]).map((p) => p.pid);
}

function sortWins(list: Win[]): Win[] {
  return list.slice().sort((a, b) =>
    (LOTTERY_PRIZE_BY_K[a.prize]!.i - LOTTERY_PRIZE_BY_K[b.prize]!.i) || (a.pid - b.pid));
}

/** 第一个还没抽的轮次。刷新后从这里接着走。 */
function firstOpen(res: Results): number {
  for (let r = 1; r <= LOTTERY_JACKPOT; r += 1) if (!res[r]) return r;
  return LOTTERY_JACKPOT;
}

function load(): Results {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { results?: Results } | null;
    if (v && v.results) return v.results;
  } catch { /* 存档坏了就当没抽过，不要因此打不开页面 */ }
  return {};
}

/** 环形进度点：64 颗排成一圈，滚动时像跑马灯扫过 */
const RING = Array.from({ length: 64 }, (_, i) => {
  const a = (i / 64) * Math.PI * 2 - Math.PI / 2;
  return { x: CX + Math.cos(a) * 430, y: CY + Math.sin(a) * 430, rot: (a * 180) / Math.PI + 90 };
});

/** 压轴奖金那四位数字的滚动列 */
const ROLL_COLS = '1024'.split('').map((ch, i) => {
  const t = +ch;
  const L: number[] = [];
  for (let k = 1; k <= 20; k += 1) L.push((t + k) % 10);
  L.push(t);
  return { txt: L.join('\n'), dur: `${(1.2 + i * 0.3).toFixed(2)}s` };
});

export const LotteryStage = forwardRef<LotteryHandle>(
  function LotteryStage(_props, ref) {
    const [results, setResults] = useState<Results>(load);
    const [round, setRound] = useState(() => firstOpen(load()));
    const [phase, setPhase] = useState<Phase>(() => (load()[firstOpen(load())] ? 'reveal' : 'ready'));
    const [fresh, setFresh] = useState(false);
    const [landed, setLanded] = useState(false);
    const [jpGather, setJpGather] = useState(false);
    const [shown, setShown] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [toast, setToast] = useState('');

    const wrap = useRef<HTMLDivElement>(null);
    const chipBox = useRef<HTMLDivElement>(null);
    const ringBox = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const tickNick = useRef<HTMLSpanElement>(null);
    const tickReal = useRef<HTMLSpanElement>(null);

    /*
      循环用的可变状态。全放一个 ref 里而不是 state——它每帧都变，
      进 state 就是每秒 60 次重渲染 84 个节点。
    */
    const S = useRef({
      nodes: {} as Record<number, Node>,
      count: -1, omega: 0.2, rotY: 0, wob: 0.1, head: 0, R: 340,
      tickAt: 0, flashAt: 0, last: 0, tickDone: false,
      pool: [] as number[],
    });
    /** 读最新 state 给 rAF 循环用，免得闭包抓到旧值 */
    const live = useRef({ phase, round, results, landed });
    live.current = { phase, round, results, landed };
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
    const rollAt = useRef(0);
    const stopAt = useRef(0);
    const soloPid = useRef(0);
    const flyFrom = useRef<Record<number, { x: number; y: number; sc: number }> | null>(null);
    const prev = useRef({ phase, round });

    const later = useCallback((ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      timers.current.push(t);
      return t;
    }, []);

    const save = useCallback((res: Results) => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ results: res })); } catch { /* 无痕模式等 */ }
    }, []);

    // ── 球体 ────────────────────────────────────────────────────────

    const bindNodes = useCallback((): boolean => {
      const box = chipBox.current;
      if (!box) return false;
      const s = S.current;
      let added = false;
      s.count = box.children.length;
      for (let i = 0; i < box.children.length; i += 1) {
        const el = box.children[i] as HTMLElement;
        const pid = +(el.getAttribute('data-pid') ?? 0);
        if (!pid) continue;
        let n = s.nodes[pid];
        if (!n) {
          n = s.nodes[pid] = {
            d: randUnit(), t: [0, 0, 1], rf: 3, trf: 1, vis: 0, tvis: 0,
            ph: Math.random() * 6.2832, win: false, solo: false, sb: 0,
          };
          added = true;
        }
        n.el = el;
        n.flash = el.querySelector<HTMLElement>('[data-flash]');
      }
      return added;
    }, []);

    /**
     * 把候选池铺到球面上。
     *
     * 用黄金角撒点而不是按经纬度：经纬度在两极会挤成一团，84 个人里有十几个
     * 叠在一起谁也看不清。黄金角给的是真正均匀的球面分布。
     */
    const layoutPool = useCallback((assemble: boolean) => {
      const s = S.current;
      const { phase: ph, round: r, results: res } = live.current;
      const pool = ph === 'reveal' ? [] : poolFor(r, res);
      s.pool = pool;
      const order = shuffle(pool.slice());
      const N = order.length;
      const inPool: Record<number, 1> = {};
      order.forEach((pid, i) => {
        inPool[pid] = 1;
        const n = s.nodes[pid];
        if (!n) return;
        const y = 1 - ((i + 0.5) * 2) / N;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const th = i * GOLDEN;
        n.t = [Math.cos(th) * rr, y, Math.sin(th) * rr];
        n.trf = 1; n.tvis = 1; n.win = false; n.solo = false; n.sb = 0;
        if (assemble) { n.d = randUnit(); n.rf = 2.4 + Math.random() * 1.4; n.vis = 0; }
      });
      Object.keys(s.nodes).forEach((k) => {
        if (!inPool[+k]) {
          const n = s.nodes[+k]!;
          n.tvis = 0; n.vis = 0; n.win = false; n.solo = false;
        }
      });
    }, []);

    useEffect(() => {
      let raf = 0;
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        const s = S.current;
        const box = chipBox.current;
        if (!box) return;
        const dt = Math.min(0.05, s.last ? (now - s.last) / 1000 : 0.016);
        s.last = now;
        const ph = live.current.phase;
        if (ph === 'reveal') return;
        if (s.count !== box.children.length && bindNodes()) layoutPool(true);
        const rolling = ph === 'rolling';
        const stopping = ph === 'stopping';

        /* 角速度、抖动、半径都用指数趋近，起停才有重量感而不是硬切 */
        s.omega += ((rolling ? 6.4 : 0.2) - s.omega) * Math.min(1, dt * (rolling ? 1.5 : 1.1));
        s.rotY += s.omega * dt;
        s.wob += ((rolling ? 0.42 : 0.1) - s.wob) * Math.min(1, dt * 1.5);
        const rotX = -0.3 + Math.sin(now * 0.0011) * s.wob;
        const cY = Math.cos(s.rotY); const sY = Math.sin(s.rotY);
        const cX = Math.cos(rotX); const sX = Math.sin(rotX);
        /* 人少了球就该小一点，不然最后几个人稀稀拉拉挂在一个大球上 */
        const tR = 220 + 120 * Math.sqrt(Math.max(1, s.pool.length) / 84);
        s.R += (tR - s.R) * Math.min(1, dt * 2);
        const R = s.R;
        const a1 = Math.min(1, dt * 2.4);
        const a2 = Math.min(1, dt * 2.2);
        const a3 = Math.min(1, dt * 2.8);

        for (const k in s.nodes) {
          const n = s.nodes[k]!;
          if (!n.el) continue;
          const st = n.el.style;
          if (n.tvis === 0 && n.vis < 0.01) {
            if (st.visibility !== 'hidden') st.visibility = 'hidden';
            continue;
          }
          const d = n.d; const t = n.t;
          d[0] += (t[0] - d[0]) * a1; d[1] += (t[1] - d[1]) * a1; d[2] += (t[2] - d[2]) * a1;
          const L = Math.hypot(d[0], d[1], d[2]) || 1;
          d[0] /= L; d[1] /= L; d[2] /= L;
          const trf = rolling ? n.trf + 0.08 * Math.sin(now * 0.008 + n.ph) : n.trf;
          n.rf += (trf - n.rf) * a2;
          n.vis += (n.tvis - n.vis) * a3;
          const rr = R * n.rf;
          const x = d[0] * rr; const y = d[1] * rr; const z = d[2] * rr;
          const x1 = x * cY + z * sY; const z1 = z * cY - x * sY;
          const y2 = y * cX - z1 * sX; const z2 = y * sX + z1 * cX;
          const kk = FOCAL / (FOCAL - z2);
          let px = CX + x1 * kk; let py = CY + y2 * kk;
          let dep = (z2 / rr + 1) / 2;
          if (!(dep >= 0)) dep = 0;
          if (dep > 1) dep = 1;
          let sc = kk * (0.58 + 0.42 * dep) * (n.win ? 1.12 : 1);
          /* 背面的人淡下去（dep 平方），否则整个球糊成一片看不出纵深 */
          const op = n.vis * (n.win ? 1 : 0.14 + 0.86 * dep * dep);
          if (n.solo) {
            n.sb += (1 - n.sb) * Math.min(1, dt * 3.2);
            px += (CX - px) * n.sb; py += (CY - py) * n.sb; sc += (2.4 - sc) * n.sb;
          }
          st.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) scale(${sc.toFixed(3)})`;
          st.opacity = op.toFixed(3);
          st.zIndex = String((n.solo ? 4000 : n.win ? 2000 : 0) + Math.round(dep * 1000));
          st.visibility = 'visible';
          n.sx = px; n.sy = py; n.sc = sc;
        }

        /* 滚动时随机闪白边，像相机在人群里扫 */
        if (rolling && now - s.flashAt > 40 && s.pool.length) {
          s.flashAt = now;
          const n = s.nodes[s.pool[Math.floor(Math.random() * s.pool.length)]!];
          n?.flash?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' });
        }

        const ring = ringBox.current;
        if (ring) {
          const N = ring.children.length;
          const tail = rolling ? 16 : 9;
          s.head += dt * (rolling ? 40 : stopping ? 0 : 6);
          const blink = Math.floor(now / 120) % 2 ? 1 : 0.3;
          for (let i = 0; i < N; i += 1) {
            const dd = ((s.head - i) % N + N) % N;
            (ring.children[i] as HTMLElement).style.opacity =
              (stopping ? blink : Math.max(rolling ? 0.16 : 0.1, 1 - dd / tail)).toFixed(2);
          }
        }

        /*
          正中那行名字。压轴停下来时它要越跳越慢最后定在中奖者身上——
          这是「还在抽」到「就是他」之间唯一的过渡，节奏全靠这段间隔。
        */
        const solo = stopping && live.current.round === LOTTERY_JACKPOT && !live.current.landed;
        let tp = 0;
        if (solo && !s.tickDone && now - stopAt.current > 1500) { tp = soloPid.current; s.tickDone = true; }
        /* 普通轮一次抽十几个人，中间跳一个名字没有意义——只在压轴（一次一个）时跳 */
        else if (((rolling && live.current.round === LOTTERY_JACKPOT) || solo) && !s.tickDone && s.pool.length
          && now - s.tickAt > (solo ? 60 + (now - stopAt.current) * 0.22 : 60)) {
          tp = s.pool[Math.floor(Math.random() * s.pool.length)]!;
        }
        if (tp) {
          s.tickAt = now;
          const p = LOTTERY_BY_PID[tp];
          if (p && tickNick.current) tickNick.current.textContent = p.nick;
          if (p && tickReal.current) tickReal.current.textContent = p.real;
        }
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }, [bindNodes, layoutPool]);

    // ── 入场 / 转场 ─────────────────────────────────────────────────

    const startGather = useCallback(() => {
      setJpGather(false);
      later(900, () => setJpGather(true));
    }, [later]);

    /** 揭晓时卡片依次浮上来 */
    const runIntro = useCallback(() => {
      const grid = gridRef.current;
      if (!grid) return;
      Array.prototype.forEach.call(grid.children, (el: HTMLElement, i: number) => {
        el.animate?.([{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }],
          { duration: 500, delay: i * 18, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
      });
    }, []);

    /**
     * 刚抽完那一次：卡片从中奖者在球上的位置飞到名单格子里。
     *
     * 坐标用 offsetLeft 而不是 getBoundingClientRect——舞台整体被 scale 过，
     * rect 拿到的是缩放后的屏幕像素，和球体那边算出来的 1920×1080 舞台坐标
     * 不是一套，混用就会飞错地方。offset 系列本来就是未缩放的布局坐标。
     */
    const runFly = useCallback(() => {
      const grid = gridRef.current;
      if (!grid) return;
      const from = flyFrom.current ?? {};
      const gx = grid.offsetLeft; const gy = grid.offsetTop;
      Array.prototype.forEach.call(grid.children, (el: HTMLElement, i: number) => {
        const pid = +(el.getAttribute('data-pid') ?? 0);
        const cx = gx + el.offsetLeft + el.offsetWidth / 2;
        const cy = gy + el.offsetTop + el.offsetHeight / 2;
        const f = from[pid];
        const fx = f ? f.x : CX;
        const fy = f ? f.y : CY;
        const fs = f ? Math.max(0.12, (72 * f.sc) / el.offsetWidth) : 0.15;
        el.animate?.([
          { transform: `translate(${(fx - cx).toFixed(1)}px,${(fy - cy).toFixed(1)}px) scale(${fs.toFixed(3)})`, opacity: f ? 1 : 0 },
          { transform: 'translate(0px,0px) scale(1)', opacity: 1 },
        ], { duration: 950 + Math.random() * 250, delay: i * 38, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'backwards' });
        const pz = el.querySelector<HTMLElement>('[data-prize]');
        pz?.animate?.([{ opacity: 0, transform: 'translateY(10px) scale(.7)' }, { opacity: 1, transform: 'none' }],
          { duration: 420, delay: 1000 + i * 38, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
      });
    }, []);

    useEffect(() => {
      bindNodes();
      layoutPool(true);
      const t = later(60, () => setShown(true));
      if (phase === 'reveal') { if (round === LOTTERY_JACKPOT) startGather(); else runIntro(); }
      return () => {
        clearTimeout(t);
        timers.current.forEach(clearTimeout);
        timers.current = [];
      };
      // 只在挂载时跑一次：这是「接着上次」的恢复逻辑，不是每次状态变都要重来
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const p = prev.current;
      prev.current = { phase, round };
      if (phase === 'ready' && (p.phase !== 'ready' || p.round !== round)) {
        bindNodes(); layoutPool(true);
      }
      if (phase === 'reveal' && (p.phase !== 'reveal' || p.round !== round)) {
        if (round === LOTTERY_JACKPOT) { flyFrom.current = null; startGather(); }
        else if (flyFrom.current) { runFly(); flyFrom.current = null; }
        else runIntro();
      }
    }, [phase, round, bindNodes, layoutPool, startGather, runFly, runIntro]);

    // ── 抽 ──────────────────────────────────────────────────────────

    const markWinners = useCallback((list: Win[], solo: boolean) => {
      const s = S.current;
      const win: Record<number, 1> = {};
      list.forEach((x) => { win[x.pid] = 1; });
      Object.keys(s.nodes).forEach((k) => {
        const n = s.nodes[+k]!;
        if (n.tvis === 0) return;
        if (win[+k]) { n.trf = solo ? 1 : 1.26; n.tvis = 1; n.win = true; n.solo = solo; n.sb = 0; }
        else { n.trf = 0.74; n.tvis = 0.26; n.win = false; }
      });
    }, []);

    const finishDraw = useCallback(() => {
      const s = S.current;
      const from: Record<number, { x: number; y: number; sc: number }> = {};
      Object.keys(s.nodes).forEach((k) => {
        const n = s.nodes[+k]!;
        if (n.win) from[+k] = { x: n.sx ?? CX, y: n.sy ?? CY, sc: n.sc ?? 1 };
      });
      flyFrom.current = from;
      setPhase('reveal');
      setFresh(true);
    }, []);

    const stopDraw = useCallback(() => {
      const r = live.current.round;
      const res = live.current.results;
      /*
        真正决定结果的两次洗牌都走 crypto：这是当众发奖，不能用一个
        可预测的伪随机数——哪怕没人会去验，自己心里也得过得去。
      */
      const order = shuffle(poolFor(r, res), true);
      const prizes = shuffle(expand(r), true);
      const list: Win[] = order.slice(0, prizes.length).map((pid, i) => ({ pid, prize: prizes[i]! }));
      const next = { ...res, [r]: list };
      save(next);
      stopAt.current = performance.now();
      soloPid.current = list[0]?.pid ?? 0;

      if (r === LOTTERY_JACKPOT) {
        setResults(next); setPhase('stopping'); setLanded(false);
        /* 压轴多留两秒：名字要一个一个慢下来，最后才定住 */
        later(2300, () => { markWinners(list, true); setLanded(true); });
        later(3600, finishDraw);
      } else {
        markWinners(list, false);
        setResults(next); setPhase('stopping');
        later(2000, finishDraw);
      }
    }, [save, later, markWinners, finishDraw]);

    const go = useCallback((r: number) => {
      const s = live.current;
      const busy = s.phase === 'rolling' || s.phase === 'stopping';
      if (r < 1 || r > LOTTERY_JACKPOT || r > firstOpen(s.results) || busy) return;
      setRound(r);
      setPhase(s.results[r] ? 'reveal' : 'ready');
      setFresh(false);
    }, []);

    /**
     * 主操作。返回 false = 抽奖结束，舞台交回典礼。
     *
     * 压轴揭晓之后，**按键**和**点那颗角落按钮**分工不同：按键把舞台交回
     * 典礼去切蛋糕，角落按钮开「中奖名单」弹窗（可复制、可重置）。
     * 主持人手里那一下要推着仪式往前走，不该卡在弹窗上；而名单是散场后
     * 对奖、补发用的，得留个随手能点开的入口。
     */
    const primary = useCallback((): boolean => {
      const { phase: ph, round: r } = live.current;
      const now = performance.now();
      if (ph === 'ready') { rollAt.current = now; S.current.tickDone = false; setPhase('rolling'); return true; }
      /* 700ms 内的第二下当手抖，忽略——不然「开始」和「停」会连在一起 */
      if (ph === 'rolling') { if (now - rollAt.current > 700) stopDraw(); return true; }
      if (ph === 'stopping') return true;
      if (r === LOTTERY_JACKPOT) return false;
      go(r + 1);
      return true;
    }, [stopDraw, go]);

    const back = useCallback((): boolean => {
      const { phase: ph, round: r } = live.current;
      if (ph === 'rolling' || ph === 'stopping') return true;
      if (r <= 1) return false;
      go(r - 1);
      return true;
    }, [go]);

    useImperativeHandle(ref, () => ({ primary, back }), [primary, back]);

    const flash = useCallback((msg: string) => {
      setToast(msg);
      later(1800, () => setToast(''));
    }, [later]);

    const copyList = useCallback(() => {
      const lines: string[] = [];
      let n = 0;
      LOTTERY_ALL.forEach((k) => {
        const list = results[k];
        if (!list) return;
        lines.push(lotteryRoundTitle(k));
        sortWins(list).forEach((x) => {
          const p = LOTTERY_BY_PID[x.pid]!;
          n += 1;
          lines.push(`${p.nick}（${p.real}）\t${LOTTERY_PRIZE_BY_K[x.prize]!.name}`);
        });
        lines.push('');
      });
      const text = lines.join('\n').trim();
      const done = () => flash(n ? `已复制 ${n} 条` : '还没有中奖记录');
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    }, [results, flash]);

    const resetAll = useCallback(() => {
      if (!confirm) { setConfirm(true); later(3000, () => setConfirm(false)); return; }
      timers.current.forEach(clearTimeout);
      timers.current = [];
      try { localStorage.removeItem(STORE_KEY); } catch { /* 同 save */ }
      flyFrom.current = null;
      setResults({}); setRound(1); setPhase('ready');
      setFresh(false); setDrawer(false); setConfirm(false); setLanded(false);
      later(0, () => { bindNodes(); layoutPool(true); });
      flash('已重置，可以重新开始');
    }, [confirm, later, bindNodes, layoutPool, flash]);

    // ── 画 ──────────────────────────────────────────────────────────

    const open = firstOpen(results);
    const cur = results[round] ?? [];
    const isDraw = phase === 'ready' || phase === 'rolling' || phase === 'stopping';
    const isReveal = phase === 'reveal' && round < LOTTERY_JACKPOT;
    const isJackpot = phase === 'reveal' && round === LOTTERY_JACKPOT;
    const total = LOTTERY_REGULAR.reduce((a, k) => a + (results[k]?.length ?? 0), 0);
    const jpEntry = (results[LOTTERY_JACKPOT] ?? [])[0];
    const jpw = jpEntry ? LOTTERY_BY_PID[jpEntry.pid] : null;
    const poolN = poolFor(round, results).length;
    const slots = expand(round).length;

    /* 停下来那一刻给中奖者描橙边，按名次先后依次亮 */
    const winIdx: Record<number, number> = {};
    if (phase === 'stopping' && (round < LOTTERY_JACKPOT || landed)) cur.forEach((x, i) => { winIdx[x.pid] = i; });

    const cta = (() => {
      if (phase === 'ready') return { label: round === LOTTERY_JACKPOT ? '开始压轴抽奖' : '开始抽奖', bg: '#fb923c', fg: '#001217' };
      if (phase === 'rolling') return { label: 'STOP', bg: '#f93920', fg: '#ffffff' };
      if (phase === 'stopping') return { label: '抽取中…', bg: 'rgba(255,255,255,.14)', fg: '#ffffff' };
      if (round === LOTTERY_JACKPOT) return { label: '查看名单', bg: '#001217', fg: '#ffffff' };
      if (round === LOTTERY_ROUNDS) return { label: results[LOTTERY_JACKPOT] ? '查看压轴大奖' : '压轴抽奖', bg: '#fb923c', fg: '#001217' };
      return { label: results[round + 1] ? `查看第${LOTTERY_ROUND_CN[round]}轮` : '下一轮', bg: '#fb923c', fg: '#001217' };
    })();

    return (
      <div ref={wrap} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        <LotteryKeyframes />

        {/* 顶栏：点阵 1024 + 轮次胶囊 + 名单 */}
        <div style={{
          position: 'absolute', left: 96, right: 96, top: 48, zIndex: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div role="img" aria-label="1024" style={{ display: 'grid', gridTemplateColumns: 'repeat(23, 5px)', gap: 1 }}>
              {dots1024(DOTS_ON_SCREEN).map((d, i) => (
                <span key={i} style={{ width: 5, height: 5, borderRadius: 1, background: '#fff', opacity: d.bg === DOTS_ON_SCREEN.off ? 0.2 : 1 }} />
              ))}
            </div>
            <span style={{ width: 1, height: 28, background: 'currentColor', opacity: 0.3 }} />
            <span style={{ fontSize: 24, fontWeight: 700 }}>第 8 届程序员节 · 幸运抽奖</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {LOTTERY_ALL.map((k) => {
              const isCur = k === round;
              const done = !!results[k];
              const ok = k <= open;
              return (
                <span
                  key={k}
                  onClick={(e) => { e.stopPropagation(); go(k); }}
                  style={{
                    height: 44, boxSizing: 'border-box', padding: '0 20px', borderRadius: 100,
                    display: 'flex', alignItems: 'center', fontSize: 20, fontWeight: 700,
                    cursor: ok ? 'pointer' : 'default',
                    background: isCur ? '#fb923c' : done ? 'rgba(255,255,255,.1)' : 'transparent',
                    color: isCur ? '#001217' : ok ? '#ffffff' : 'rgba(255,255,255,.35)',
                    border: `1.5px solid ${isCur ? '#fb923c' : done ? 'transparent' : ok ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.12)'}`,
                    transition: 'background-color .2s ease, color .2s ease',
                  }}
                >{k < LOTTERY_JACKPOT ? `第${LOTTERY_ROUND_CN[k - 1]}轮` : '压轴'}</span>
              );
            })}
            <span style={{ width: 1, height: 28, background: 'rgba(255,255,255,.2)', margin: '0 6px' }} />
            <span
              onClick={(e) => { e.stopPropagation(); setDrawer(true); }}
              style={{
                height: 44, boxSizing: 'border-box', padding: '0 20px', borderRadius: 100,
                display: 'flex', alignItems: 'center', fontSize: 20, fontWeight: 700,
                cursor: 'pointer', color: '#fff', border: '1.5px solid rgba(255,255,255,.35)',
              }}
            >名单</span>
            {/* 右上角整场都是 iSpace，和背景墙、颁奖、切蛋糕一致 */}
            <span style={{ width: 1, height: 28, background: 'rgba(255,255,255,.2)', margin: '0 6px' }} />
            <Mark size={40} tone="orange" />
            <span style={{
              fontFamily: 'var(--font-sans)', fontSize: 28, fontWeight: 800, letterSpacing: '-.03em',
            }}>iSpace</span>
          </div>
        </div>

        {isDraw && <Sphere
          phase={phase}
          shown={shown}
          chipBox={chipBox}
          ringBox={ringBox}
          tickNick={tickNick}
          tickReal={tickReal}
          winIdx={winIdx}
          landed={landed}
          round={round}
        />}

        {isDraw && (
          <div style={{
            position: 'absolute', left: 96, top: 140, bottom: 160, width: 640, zIndex: 10,
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
          }}>
            <span className="mono" style={{
              fontSize: 24, fontWeight: 700, letterSpacing: '.14em', color: '#fb923c',
              animation: 'rise .7s cubic-bezier(.16,1,.3,1) both',
            }}>{round < LOTTERY_JACKPOT ? `ROUND 0${round} / 0${LOTTERY_ROUNDS}` : 'JACKPOT · 全员参与'}</span>
            <span style={{
              marginTop: 14, fontSize: 160, fontWeight: 900, lineHeight: 1,
              letterSpacing: '-.02em', whiteSpace: 'nowrap',
              animation: 'rise .7s cubic-bezier(.16,1,.3,1) .06s both',
            }}>{lotteryRoundTitle(round)}</span>
            <span style={{
              marginTop: 22, fontSize: 32, fontWeight: 700, opacity: 0.85,
              animation: 'rise .7s cubic-bezier(.16,1,.3,1) .12s both',
            }}>{round < LOTTERY_JACKPOT ? `${slots} 个名额 · ${poolN} 人待抽` : `1024红包 · 全员 ${LOTTERY_PEOPLE.length} 人参与`}</span>
            <div style={{ marginTop: 64, display: 'flex', animation: 'rise .7s cubic-bezier(.16,1,.3,1) .18s both' }}>
              <div style={{
                height: 128, minWidth: 460, boxSizing: 'border-box', padding: '0 72px',
                borderRadius: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', background: cta.bg, color: cta.fg,
                boxShadow: '0 16px 40px rgba(0,0,0,.3)',
                transition: 'background-color .25s ease, color .25s ease',
              }}>
                <span style={{ fontSize: 68, fontWeight: 900, letterSpacing: '.04em', whiteSpace: 'nowrap' }}>
                  {cta.label}
                </span>
              </div>
            </div>
          </div>
        )}

        {isReveal && <RevealGrid
          gridRef={gridRef}
          round={round}
          list={sortWins(cur)}
          meta={`${cur.length} 人 · 累计 ${total} / ${LOTTERY_PEOPLE.length}`}
        />}
        {isReveal && fresh && (
          <confetti-burst
            palette="#fb923c,#ffffff,#facc15,#38bdf8,#f472b6,#4ade80"
            style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, pointerEvents: 'none', zIndex: 40 }}
          />
        )}

        {isJackpot && jpw && <Jackpot who={jpw} gather={jpGather} peopleN={LOTTERY_PEOPLE.length} />}

        {/* 操作提示。抽奖这一步的键位和典礼其余部分一致，所以只写它特有的 */}
        <div className="mono" style={{
          position: 'absolute', left: 96, bottom: 74, zIndex: 20,
          display: 'flex', alignItems: 'center', gap: 28,
          fontSize: 18, fontWeight: 600, opacity: 0.45,
        }}>
          <span>
            空格 / → {phase === 'ready' ? '开始'
              : phase === 'rolling' ? '停'
              /* 压轴抽完就没有下一轮了，这一下是出抽奖、进切蛋糕 */
              : isJackpot ? '去切蛋糕'
              : '下一轮'}
          </span>
          <span>← 上一轮</span>
          <span>点「名单」看已抽出的</span>
        </div>

        {!isDraw && (
          <div
            onClick={isJackpot ? (e) => { e.stopPropagation(); setDrawer(true); } : undefined}
            style={{
            position: 'absolute', right: 96, bottom: 48, zIndex: 70,
            height: 80, boxSizing: 'border-box', padding: '0 48px', borderRadius: 100,
            display: 'flex', alignItems: 'center', cursor: 'pointer',
            background: cta.bg, color: cta.fg, boxShadow: '0 12px 32px rgba(0,0,0,.28)',
          }}>
            <span style={{ fontSize: 40, fontWeight: 900, letterSpacing: '.04em', whiteSpace: 'nowrap' }}>
              {cta.label}
            </span>
          </div>
        )}

        {drawer && <WinnerDrawer
          results={results}
          total={total}
          onClose={() => { setDrawer(false); setConfirm(false); }}
          onCopy={copyList}
          onReset={resetAll}
          resetLabel={confirm ? '确认重置' : '重置抽奖'}
        />}

        {toast && (
          <div style={{
            position: 'absolute', left: '50%', bottom: 32, transform: 'translateX(-50%)', zIndex: 1100,
            borderRadius: 100, padding: '10px 18px', background: '#1c1f23', color: '#fff',
            fontSize: 20, fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,.25)',
            animation: 'fadeIn .2s ease both',
          }}>{toast}</div>
        )}
      </div>
    );
  },
);

/** 这一屏独有的关键帧。EventKeyframes 里那几个是典礼共用的，不混在一起。 */
function LotteryKeyframes() {
  return (
    <style>{`
      @keyframes rise { from { opacity: 0; transform: translateY(26px) } to { opacity: 1; transform: none } }
      @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
      @keyframes glow { 0%, 100% { opacity: .5 } 50% { opacity: 1 } }
      @keyframes ringOut { from { transform: scale(.2); opacity: .9 } to { transform: scale(1); opacity: 0 } }
      @keyframes bump { from { transform: scale(.8) } to { transform: scale(1) } }
      @keyframes glowText { 0%, 100% { text-shadow: 0 0 30px rgba(251,146,60,.5) } 50% { text-shadow: 0 0 60px rgba(251,146,60,.9) } }
      /*
        奖金那四位的滚动。方向不能反：每一列是 [t+1 … t+20, t] 共 21 行，
        所以要从第 0 行滚到第 20 行才停在 t 上。写成反的会停在 (t+1)%10——
        四列合起来就是 2135 而不是 1024，而这个数就是奖金本身，不能错。
      */
      @keyframes roll { from { transform: translateY(0) } to { transform: translateY(-20em) } }
      @keyframes spin { to { transform: rotate(360deg) } }
    `}</style>
  );
}

/** 一个人的头像：有照片用照片，没有就用花名首字的色块 */
function Face({ pid, size = 72 }: { pid: number; size?: number }) {
  const p = LOTTERY_BY_PID[pid];
  if (!p) return null;
  const pad = (size * 84) / 72;
  const off = (pad - size) / 2;
  return (
    <span style={{ position: 'relative', width: size, height: size, flex: 'none', borderRadius: '50%', display: 'block' }}>
      {p.img ? (
        <span role="img" aria-label={p.nick} style={{
          display: 'block', width: pad, height: pad, margin: -off,
          backgroundImage: `url("${p.img}")`, backgroundPosition: 'center',
          backgroundSize: 'contain', backgroundRepeat: 'no-repeat',
        }} />
      ) : (
        <span style={{
          width: size, height: size, borderRadius: '50%', background: p.discBg, color: p.discFg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: size * 0.44, fontWeight: 900,
        }}>{p.ini}</span>
      )}
    </span>
  );
}

function Sphere({ phase, shown, chipBox, ringBox, tickNick, tickReal, winIdx, landed, round }: {
  phase: Phase; shown: boolean;
  chipBox: React.RefObject<HTMLDivElement | null>;
  ringBox: React.RefObject<HTMLDivElement | null>;
  tickNick: React.RefObject<HTMLSpanElement | null>;
  tickReal: React.RefObject<HTMLSpanElement | null>;
  winIdx: Record<number, number>;
  landed: boolean; round: number;
}) {
  const rolling = phase === 'rolling';
  const stopping = phase === 'stopping';
  const tickOn = round === LOTTERY_JACKPOT && (rolling || (stopping && !landed));
  return (
    <>
      {rolling && (
        <span aria-hidden="true" style={{
          position: 'absolute', left: CX, top: CY, width: 1040, height: 1040,
          margin: '-520px 0 0 -520px', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(251,146,60,.3), rgba(251,146,60,0))',
          pointerEvents: 'none', animation: 'glow 1.1s ease-in-out infinite',
        }} />
      )}
      {stopping && (
        <span aria-hidden="true" style={{
          position: 'absolute', left: CX, top: CY, width: 1700, height: 1700,
          margin: '-850px 0 0 -850px', borderRadius: '50%', border: '8px solid #fb923c',
          boxSizing: 'border-box', pointerEvents: 'none',
          animation: 'ringOut 1s cubic-bezier(.16,1,.3,1) both',
        }} />
      )}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        opacity: shown ? 1 : 0, transition: 'opacity .6s ease',
      }}>
        <div ref={ringBox} style={{ position: 'absolute', inset: 0 }}>
          {RING.map((d, i) => (
            <span key={i} style={{
              position: 'absolute', left: d.x, top: d.y, width: 12, height: 12,
              margin: '-6px 0 0 -6px', borderRadius: 3, background: '#fb923c',
              transform: `rotate(${d.rot}deg)`,
            }} />
          ))}
        </div>
        <div ref={chipBox} style={{ position: 'absolute', inset: 0 }}>
          {LOTTERY_PEOPLE.map((p) => {
            const w = winIdx[p.pid];
            const on = w != null;
            return (
              <div key={p.pid} data-pid={p.pid} style={{
                position: 'absolute', left: 0, top: 0, width: 160, margin: '-36px 0 0 -80px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                transformOrigin: '80px 36px', willChange: 'transform, opacity',
              }}>
                <span style={{ position: 'relative', width: 72, height: 72, flex: 'none', borderRadius: '50%', display: 'block' }}>
                  <Face pid={p.pid} />
                  <span style={{
                    position: 'absolute', inset: -7, borderRadius: '50%', border: '4px solid #fb923c',
                    boxSizing: 'border-box', opacity: on ? 1 : 0,
                    transition: 'opacity .3s ease', transitionDelay: on ? `${240 + w * 45}ms` : '0ms',
                  }} />
                  <span data-flash="1" style={{
                    position: 'absolute', inset: -7, borderRadius: '50%', border: '4px solid #fff',
                    boxShadow: '0 0 28px 6px rgba(251,146,60,.85)', boxSizing: 'border-box',
                    opacity: 0, pointerEvents: 'none',
                  }} />
                </span>
                <span style={{
                  borderRadius: 100, padding: '4px 12px', fontSize: 20, fontWeight: 800,
                  lineHeight: 1.2, whiteSpace: 'nowrap',
                  background: on ? '#fb923c' : 'rgba(0,18,23,.78)',
                  color: on ? '#001217' : '#ffffff',
                  transition: 'background-color .3s ease, color .3s ease',
                  transitionDelay: on ? `${240 + w * 45}ms` : '0ms',
                }}>{p.nick}</span>
              </div>
            );
          })}
        </div>
        <div style={{
          position: 'absolute', left: CX, top: CY, width: 0, height: 0, zIndex: 2500,
          opacity: tickOn ? 1 : 0, transition: 'opacity .25s ease',
        }}>
          <div style={{
            position: 'absolute', left: -380, top: -150, width: 760, height: 300,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'radial-gradient(closest-side, rgba(0,18,23,.92), rgba(0,18,23,0))',
          }}>
            <span ref={tickNick} style={{
              fontSize: 132, fontWeight: 900, lineHeight: 1, letterSpacing: '-.02em',
              color: '#fff', textShadow: '0 0 40px rgba(251,146,60,.65)', whiteSpace: 'nowrap',
            }} />
            <span ref={tickReal} style={{ fontSize: 32, fontWeight: 700, color: '#fb923c', whiteSpace: 'nowrap' }} />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * 每张普通卡在 12 列网格里的位置（[列, 行]），按这一轮有几张普通卡选一套。
 *
 * 大卡（666 红包）固定占正中 5–9 列、2–4 行，所以第 2、3 行中间那段是留给
 * 它的，普通卡只能贴左右两边——两套框的第 2、3 行因此完全一样。
 */
const FRAMES: Record<number, [string, number][]> = {
  /* 16 张 + 大卡 = 17 人。照稿：第 1、4 行各 4 张、每张 3 列宽。 */
  16: [
    ['1 / 4', 1], ['4 / 7', 1], ['7 / 10', 1], ['10 / 13', 1],
    ['1 / 3', 2], ['3 / 5', 2], ['9 / 11', 2], ['11 / 13', 2],
    ['1 / 3', 3], ['3 / 5', 3], ['9 / 11', 3], ['11 / 13', 3],
    ['1 / 4', 4], ['4 / 7', 4], ['7 / 10', 4], ['10 / 13', 4],
  ],
  /*
    17 张 + 大卡 = 18 人（第三轮）。多出来的那一个加在最上面一排：5 张
    3-2-2-2-3，两头仍是 3 列宽、中间三张 2 列宽，正好 12 列且左右对称。
    其余三行一个没动——多的人只摊在一排上，整屏的节奏不变。
  */
  17: [
    ['1 / 4', 1], ['4 / 6', 1], ['6 / 8', 1], ['8 / 10', 1], ['10 / 13', 1],
    ['1 / 3', 2], ['3 / 5', 2], ['9 / 11', 2], ['11 / 13', 2],
    ['1 / 3', 3], ['3 / 5', 3], ['9 / 11', 3], ['11 / 13', 3],
    ['1 / 4', 4], ['4 / 7', 4], ['7 / 10', 4], ['10 / 13', 4],
  ],
};

function RevealGrid({ gridRef, round, list, meta }: {
  gridRef: React.RefObject<HTMLDivElement | null>;
  round: number; list: Win[]; meta: string;
}) {
  const isHero = (x: Win) => !!LOTTERY_PRIZE_BY_K[x.prize]!.cash && round < LOTTERY_JACKPOT;
  const std = list.filter((x) => !isHero(x));
  /* 没有对应的框就退回自动排：宁可排得松散，也不要有卡片落到格子外面 */
  const frame = std.length < list.length ? FRAMES[std.length] : undefined;
  const stdIdx = new Map(std.map((x, i) => [x.pid, i]));
  return (
    <>
      <div style={{
        position: 'absolute', left: 96, right: 96, top: 140,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24,
        animation: 'rise .6s cubic-bezier(.16,1,.3,1) both',
      }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
          <span style={{ fontSize: 64, fontWeight: 900, lineHeight: 1 }}>{lotteryRoundTitle(round)}</span>
          <span style={{ fontSize: 64, fontWeight: 900, lineHeight: 1, color: '#fb923c' }}>中奖名单</span>
        </span>
        <span className="mono" style={{ fontSize: 24, fontWeight: 700, opacity: 0.75 }}>{meta}</span>
      </div>
      {/*
        照 UI 稿：12 列 × 4 行（一格 = 稿上 6 列里的半格），普通轮的现金大奖
        （666 红包）固定占正中 2×2（第 5–8 列、第 2–3 行），其余卡片默认各占
        2 列自动排。

        普通卡的摆法按张数查 FRAMES：17 人（16 张）是稿上那个框，18 人
        （17 张，第三轮）在最上面一排多放一张。查不到对应的框就退回自动排。

        z-index 压过彩纸（40）：彩纸从卡片后面飘，不糊在名字上。
      */}
      <div ref={gridRef} style={{
        position: 'absolute', left: 96, right: 96, top: 250, height: 674, zIndex: 50,
        display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(4, minmax(0, 1fr))', gap: 16,
      }}>
        {list.map((x) => {
          const p = LOTTERY_BY_PID[x.pid]!;
          const pz = LOTTERY_PRIZE_BY_K[x.prize]!;
          const cash = !!pz.cash;
          if (cash && round < LOTTERY_JACKPOT) return <HeroCard key={x.pid} pid={x.pid} prize={pz.name} />;
          const at = frame?.[stdIdx.get(x.pid)!];
          return (
            <div key={x.pid} data-pid={x.pid} style={{
              gridColumn: at ? at[0] : 'span 2', gridRow: at ? String(at[1]) : 'auto',
              position: 'relative', minWidth: 0, boxSizing: 'border-box', borderRadius: 22,
              padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14,
              background: 'rgba(255,255,255,.06)',
              border: `2px solid ${cash ? 'rgba(251,146,60,.8)' : 'rgba(255,255,255,.1)'}`,
              color: '#fff',
            }}>
              <Face pid={x.pid} />
              <span style={{
                flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'flex-start', gap: 3,
              }}>
                <span style={{
                  maxWidth: '100%', fontSize: 28, fontWeight: 900, lineHeight: 1.1,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{p.nick}</span>
                <span style={{
                  maxWidth: '100%', fontSize: 17, fontWeight: 600,
                  color: 'rgba(255,255,255,.62)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{p.real}</span>
                <span data-prize="1" style={{
                  marginTop: 3, maxWidth: '100%', boxSizing: 'border-box', borderRadius: 100,
                  padding: cash ? '4px 14px' : '4px 0',
                  background: cash ? '#fb923c' : 'transparent',
                  color: cash ? '#001217' : '#fb923c',
                  fontSize: 17, fontWeight: 800, lineHeight: 1.3,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{pz.name}</span>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * 「本轮大奖」：每个普通轮各一个的 666 红包，占名单正中 2×2。
 *
 * 金额和「红包」两个字分开排（稿上一大一小），从奖品名里拆：写死 666 的话
 * 哪天改了金额，大屏上就是错的。
 */
function HeroCard({ pid, prize }: { pid: number; prize: string }) {
  const p = LOTTERY_BY_PID[pid]!;
  const m = /^(\d+)(.*)$/.exec(prize);
  return (
    <div data-pid={pid} style={{
      position: 'relative', gridColumn: '5 / 9', gridRow: '2 / 4', minWidth: 0,
      boxSizing: 'border-box', borderRadius: 32, padding: '24px 28px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 26, textAlign: 'left',
      background: 'radial-gradient(120% 90% at 50% 0%,rgba(255,210,122,.32),rgba(251,146,60,.14) 60%,rgba(251,146,60,.08))',
      border: '3px solid #ffb35c',
      boxShadow: '0 0 0 10px rgba(251,146,60,.16),0 0 120px rgba(251,146,60,.6)',
      color: '#fff',
    }}>
      <span style={{
        position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)',
        height: 40, padding: '0 20px', borderRadius: 100, background: '#fb923c', color: '#001217',
        fontSize: 20, fontWeight: 900, letterSpacing: '.12em',
        display: 'flex', alignItems: 'center', whiteSpace: 'nowrap',
        boxShadow: '0 6px 18px rgba(251,146,60,.5)',
      }}>本轮大奖</span>
      <Face pid={pid} size={150} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
        <span style={{
          maxWidth: '100%', fontSize: 56, fontWeight: 900, lineHeight: 1.05,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{p.nick}</span>
        <span style={{
          marginTop: 4, maxWidth: '100%', fontSize: 26, fontWeight: 600, color: 'rgba(255,255,255,.72)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{p.real}</span>
        <span data-prize="1" style={{
          marginTop: 14, alignSelf: 'flex-start', display: 'flex', alignItems: 'baseline', gap: 8,
          boxSizing: 'border-box', borderRadius: 24, padding: '4px 30px 8px',
          background: 'linear-gradient(180deg,#ffd27a,#fb923c)', color: '#3a1600',
          boxShadow: '0 10px 30px rgba(251,146,60,.55),inset 0 2px 0 rgba(255,255,255,.55)',
          whiteSpace: 'nowrap',
        }}>
          {m ? (
            <>
              <span className="mono" style={{ fontSize: 72, fontWeight: 900, lineHeight: 1, letterSpacing: '-.03em' }}>{m[1]}</span>
              <span style={{ fontSize: 34, fontWeight: 900 }}>{m[2]}</span>
            </>
          ) : (
            <span style={{ fontSize: 34, fontWeight: 900 }}>{prize}</span>
          )}
        </span>
      </span>
    </div>
  );
}

/** 压轴：整屏翻成橙底，名字用粒子聚出来 */
function Jackpot({ who, gather, peopleN }: {
  who: { nick: string; real: string; ini: string; img: string }; gather: boolean; peopleN: number;
}) {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 60,
      backgroundColor: '#fb923c',
      backgroundImage: 'radial-gradient(#f97316 1.5px, transparent 1.5px)',
      backgroundSize: '26px 26px', color: '#001217',
      animation: 'fadeIn .5s ease both',
    }}>
      <span aria-hidden="true" style={{
        position: 'absolute', left: '50%', top: '50%', width: 2400, height: 2400,
        margin: '-1200px 0 0 -1200px', borderRadius: '50%',
        border: '140px solid rgba(255,255,255,.35)', boxSizing: 'border-box', pointerEvents: 'none',
        animation: 'ringOut 1.2s cubic-bezier(.16,1,.3,1) both',
      }} />
      <div style={{
        position: 'absolute', left: 96, top: 120, display: 'flex', alignItems: 'center', gap: 16,
        animation: 'rise .7s cubic-bezier(.16,1,.3,1) .1s both',
      }}>
        <span style={{
          borderRadius: 100, padding: '8px 20px', background: '#001217', color: '#fff',
          fontSize: 28, fontWeight: 900,
        }}>压轴大奖</span>
        <span className="mono" style={{ fontSize: 24, fontWeight: 700, letterSpacing: '.14em' }}>
          JACKPOT · 全员抽奖
        </span>
      </div>

      <particle-text
        text={who.nick}
        initial={who.ini}
        ink="#001217"
        disc="#001217"
        discink="#ffffff"
        img={who.img}
        mode={gather ? 'gather' : 'roam'}
        left="96" top="300" width="1040" height="460"
        style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, pointerEvents: 'none' }}
      />

      <span style={{
        position: 'absolute', left: 96, top: 820, fontSize: 36, fontWeight: 800,
        animation: 'rise .7s cubic-bezier(.16,1,.3,1) 2.1s both',
      }}>恭喜 {who.nick}（{who.real}）</span>

      <span aria-hidden="true" style={{
        position: 'absolute', right: -60, top: 40, width: 980, height: 920, borderRadius: '50%',
        background: 'radial-gradient(closest-side, rgba(255,255,255,.5), rgba(255,255,255,0))',
        pointerEvents: 'none', animation: 'glow 2.4s ease-in-out 2.1s infinite both',
      }} />

      <div style={{
        position: 'absolute', right: 96, top: 200, width: 660, height: 600, boxSizing: 'border-box',
        borderRadius: 40, padding: 6, overflow: 'hidden',
        boxShadow: '0 40px 90px rgba(0,18,23,.4)',
        animation: 'rise .8s cubic-bezier(.16,1,.3,1) 2.1s both',
      }}>
        <span aria-hidden="true" style={{
          position: 'absolute', left: '50%', top: '50%', width: 1200, height: 1200,
          margin: '-600px 0 0 -600px',
          background: 'conic-gradient(#001217 0deg, #ffffff 50deg, #fb923c 90deg, #001217 150deg, #001217 180deg, #ffffff 230deg, #fb923c 270deg, #001217 330deg)',
          animation: 'spin 2.6s linear infinite',
        }} />
        <div style={{
          position: 'relative', height: '100%', boxSizing: 'border-box', borderRadius: 34,
          padding: '44px 52px', background: '#001217', color: '#fff',
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
          <span className="mono" style={{ fontSize: 20, fontWeight: 700, letterSpacing: '.16em', color: '#fb923c' }}>
            PRIZE · 压轴大奖
          </span>
          <div className="mono" style={{
            marginTop: 22, display: 'flex', fontSize: 210, fontWeight: 800, lineHeight: 1,
            letterSpacing: '-.04em', color: '#fb923c', transformOrigin: 'left center',
            animation: 'bump .5s cubic-bezier(.34,1.56,.64,1) 4.3s both, glowText 2.4s ease-in-out 4.3s infinite',
          }}>
            {ROLL_COLS.map((d, i) => (
              <span key={i} style={{ display: 'block', height: '1em', overflow: 'hidden' }}>
                <span style={{
                  display: 'block', whiteSpace: 'pre',
                  animation: `roll ${d.dur} cubic-bezier(.12,.8,.18,1) 2.2s both`,
                }}>{d.txt}</span>
              </span>
            ))}
          </div>
          <span style={{ marginTop: 8, fontSize: 104, fontWeight: 900, lineHeight: 1 }}>红包</span>
          <span style={{
            marginTop: 28, paddingTop: 22, borderTop: '1px solid rgba(255,255,255,.14)',
            fontSize: 24, fontWeight: 600, lineHeight: 1.5, opacity: 0.75,
          }}>全员 {peopleN} 人中抽出</span>
        </div>
      </div>

      <confetti-burst
        palette="#ffffff,#001217,#38bdf8,#f472b6,#facc15,#4ade80,#a78bfa"
        style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, pointerEvents: 'none' }}
      />
    </div>
  );
}

/** 已抽出名单。给组织者核对和存档用，不是给台下看的。 */
function WinnerDrawer({ results, total, onClose, onCopy, onReset, resetLabel }: {
  results: Results; total: number; onClose: () => void;
  onCopy: () => void; onReset: () => void; resetLabel: string;
}) {
  const groups = LOTTERY_ALL.filter((k) => results[k]).map((k) => ({
    title: `${lotteryRoundTitle(k)} · ${results[k]!.length} 人`,
    rows: sortWins(results[k]!).map((x) => {
      const p = LOTTERY_BY_PID[x.pid]!;
      return { who: `${p.nick}（${p.real}）`, prize: LOTTERY_PRIZE_BY_K[x.prize]!.name };
    }),
  }));
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 1000, background: 'rgba(0,18,23,.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 880, maxHeight: 820, boxSizing: 'border-box', borderRadius: 28, padding: 40,
          background: '#fcfcf8', color: '#001217',
          display: 'flex', flexDirection: 'column', gap: 20,
          boxShadow: '0 40px 90px rgba(0,0,0,.45)',
        }}
      >
        <div>
          <div style={{ fontSize: 34, fontWeight: 900 }}>中奖名单</div>
          <div style={{ marginTop: 6, fontSize: 20, color: 'rgba(0,18,23,.6)' }}>
            已抽出 {total} / {LOTTERY_PEOPLE.length} 人{results[LOTTERY_JACKPOT] ? ' · 压轴已抽出' : ''} · 结果保存在这台机器的浏览器里
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {groups.map((g) => (
            <div key={g.title} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '.08em', color: 'rgba(0,18,23,.5)', paddingBottom: 6 }}>
                {g.title}
              </span>
              {g.rows.map((w, i) => (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'baseline',
                  gap: 12, padding: '7px 0', borderTop: '1px solid rgba(0,18,23,.1)', fontSize: 20,
                }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {w.who}
                  </span>
                  <span style={{ whiteSpace: 'nowrap', color: 'rgba(0,18,23,.6)' }}>{w.prize}</span>
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <span style={{ fontSize: 20, color: 'rgba(0,18,23,.5)' }}>还没有开始抽奖</span>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <DrawerButton onClick={onCopy}>复制名单</DrawerButton>
          <DrawerButton onClick={onReset} danger>{resetLabel}</DrawerButton>
          <DrawerButton onClick={onClose}>关闭</DrawerButton>
        </div>
      </div>
    </div>
  );
}

function DrawerButton({ onClick, danger, children }: {
  onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 48, padding: '0 24px', borderRadius: 100, cursor: 'pointer',
        fontSize: 20, fontWeight: 700,
        border: `1.5px solid ${danger ? '#f93920' : 'rgba(0,18,23,.2)'}`,
        background: 'transparent', color: danger ? '#f93920' : '#001217',
      }}
    >{children}</button>
  );
}
