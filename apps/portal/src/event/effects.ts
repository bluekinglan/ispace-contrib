/**
 * 颁奖大屏的两个画布特效：粒子文字与彩带烟花。
 *
 * ┌─ 为什么是自定义元素而不是 React 组件 ──────────────────────────────┐
 * │ 两段都是逐帧 canvas 动画：自己管 requestAnimationFrame、自己持有    │
 * │ 几千个粒子的可变状态、每帧原地改坐标。把它们写成 React 组件，       │
 * │ 这些状态还是得整个塞进 ref 里绕开渲染，徒增一层而不会更清晰。      │
 * │                                                                    │
 * │ 更重要的是：动画参数（缓动、延迟、重力、抖动）是设计稿调出来的，     │
 * │ 逐行搬过来能保证投到会议室那块屏上和设计稿一模一样。重写成          │
 * │ React 惯用法只会在没有收益的地方引入偏差。                          │
 * │                                                                    │
 * │ 下面的 React 包装器只做一件事：把 props 映射成属性。               │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 移植自设计稿的 particle-text.js / confetti-burst.js，算法未改，
 * 只补了类型、显式字段声明与几处注释。
 */

// ── 共用 ──────────────────────────────────────────────────────────────

const rnd = Math.random;

/** 画布按设备像素比放大，否则 1920 宽的大屏上点阵会糊。上限 2 够用。 */
function fitCanvas(el: HTMLElement, canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D; w: number; h: number;
} | null {
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function makeCanvas(host: HTMLElement): HTMLCanvasElement {
  host.style.display = 'block';
  host.style.width = '100%';
  host.style.height = '100%';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  host.appendChild(canvas);
  return canvas;
}

// ── particle-text ─────────────────────────────────────────────────────

const EASE_OUT = (t: number) => 1 - (1 - t) ** 3;
const EASE_IO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const FONT = '"Noto Sans SC", Manrope, sans-serif';
/** 改动其中任何一个都要重新铺点，mode 除外（它只切换运动目标）。 */
const SHAPE = ['text', 'initial', 'img', 'ink', 'disc', 'discink', 'left', 'top', 'width', 'height'];

const IMG_CACHE: Record<string, Promise<HTMLImageElement | null>> = {};
function loadImg(src: string): Promise<HTMLImageElement | null> {
  if (!IMG_CACHE[src]) {
    IMG_CACHE[src] = new Promise((res) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    });
  }
  return IMG_CACHE[src]!;
}

/** 量化到 8 级，让相邻像素更容易合并成同色批次（draw 里按颜色分批填充）。 */
const q = (v: number) => Math.max(0, Math.min(255, ((v + 4) >> 3) << 3));

/** 照片点阵：提一点饱和与对比，否则缩成点之后看着发灰。 */
function tone(r: number, g: number, b: number): string {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const f = (v: number) => {
    let x = l + (v - l) * 1.3;
    x = (x - 128) * 1.18 + 122;
    return q(x);
  };
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

interface Particle {
  tx: number; ty: number; s: number; col: string;
  x: number; y: number; vx: number; vy: number;
  ph: number; d: number; fx: number; fy: number;
  gx?: number; gy?: number;
  /** 三分之一的粒子常驻，组成游走时那层稀疏底噪；其余随聚拢淡入。 */
  bgOn: boolean;
}

class ParticleText extends HTMLElement {
  static get observedAttributes() { return SHAPE.concat(['mode']); }

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private ro?: ResizeObserver;
  private raf = 0;
  private key: string | null = null;
  private P: Particle[] = [];
  private bx = 0; private bw = 1;
  private w = 0; private h = 0;
  private last = 0; private t = 0; private t0 = 0;
  /** 当前运动状态。**不能叫 mode**——见文件末尾那段说明。 */
  private flow: 'roam' | 'gather' = 'roam';
  /** 正从聚拢散开（而不是一开始就在游走）。两者的淡出不一样。 */
  private dispersing = false;

  connectedCallback(): void {
    if (!this.canvas) this.canvas = makeCanvas(this);
    this.ro = new ResizeObserver(() => this.setup());
    this.ro.observe(this);
    this.setup();
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.key = null;
  }

  attributeChangedCallback(n: string): void {
    if (!this.isConnected) return;
    if (n === 'mode') this.setMode(this.getAttribute('mode'));
    else this.setup();
  }

  private num(n: string, d: number): number {
    const v = parseFloat(this.getAttribute(n) ?? '');
    return Number.isNaN(v) ? d : v;
  }

  private setup(): void {
    const w = this.clientWidth;
    const h = this.clientHeight;
    if (!w || !h) return;
    // 尺寸或任一造型属性变了才重新铺点——重铺要重新采样几千个像素，不便宜
    const key = [String(w), String(h), ...SHAPE.map((a) => String(this.getAttribute(a)))].join('|');
    if (key === this.key) return;
    this.key = key;
    /*
      等字体就位再取像素。不等的话首屏会按回退字体铺点，字体一到位
      点阵和真正的字形就对不上了——而这块屏是拿来投影的，没有第二次机会。
    */
    const fonts = document.fonts?.load
      ? Promise.all([
          document.fonts.load('700 100px "Noto Sans SC"'),
          document.fonts.load('800 100px Manrope'),
        ]).catch(() => undefined)
      : Promise.resolve(undefined);
    const src = this.getAttribute('img');
    void Promise.all([fonts, src ? loadImg(src) : null]).then((r) => {
      if (this.key === key && this.isConnected) this.build(w, h, r[1] ?? null);
    });
  }

  private build(w: number, h: number, img: HTMLImageElement | null): void {
    const text = this.getAttribute('text') || '';
    const initial = this.getAttribute('initial') || text.charAt(0);
    const ink = this.getAttribute('ink') || '#001217';
    const disc = this.getAttribute('disc') || '#f97316';
    const discInk = this.getAttribute('discink') || '#ffffff';
    const bx = this.num('left', 0);
    const by = this.num('top', 0);
    const bw = this.num('width', w);
    const bh = this.num('height', h);

    // 先把「头像 + 名字」正常画到一张离屏画布上，再把它的像素采样成点
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const c = off.getContext('2d')!;
    const R = Math.min(bh * 0.32, 150);
    const cx = bx + R + 8;
    const cy = by + bh / 2;

    if (img) {
      c.save();
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
      const sc = Math.max((2 * R) / img.width, (2 * R) / img.height);
      const dw = img.width * sc; const dh = img.height * sc;
      c.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
      c.restore();
    } else {
      c.fillStyle = disc;
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
      c.fillStyle = discInk;
      c.font = `900 ${Math.round(R * 1.05)}px ${FONT}`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(initial, cx, cy + R * 0.06);
    }

    const x0 = cx + R + 56;
    const avail = bx + bw - x0 - 8;
    const len = Math.max(1, text.length);
    const fs = Math.floor(Math.min(bh * 0.52, (avail / len) * 0.96));
    c.fillStyle = ink;
    c.font = `900 ${fs}px ${FONT}`;
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(text, x0, cy + fs * 0.06);

    const data = c.getImageData(0, 0, w, h).data;
    const inDisc = (x: number, y: number) => {
      const dx = x - cx; const dy = y - cy;
      return dx * dx + dy * dy <= R * R;
    };

    /*
      采样密度自适应：先按 step=5 铺，点数超过 cap 就放粗一档重来。
      上限是为了帧率——两万个点在会议室那台机器上会掉帧。
    */
    let step = 5; let fine = 3;
    const cap = img ? 16000 : 9000;
    let pts: { tx: number; ty: number; s: number; col: string }[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      pts = [];
      for (let y = step / 2; y < h; y += step) {
        for (let x = step / 2; x < w; x += step) {
          if (img && inDisc(x, y)) continue;
          const i = ((y | 0) * w + (x | 0)) * 4;
          if (data[i + 3]! < 110) continue;
          pts.push({ tx: x, ty: y, s: step * 0.7, col: `rgb(${data[i]},${data[i + 1]},${data[i + 2]})` });
        }
      }
      // 头像区单独用更细的网格：那是照片，粗了就认不出人
      if (img) {
        for (let y = cy - R; y <= cy + R; y += fine) {
          for (let x = cx - R; x <= cx + R; x += fine) {
            if (!inDisc(x, y)) continue;
            const i = ((y | 0) * w + (x | 0)) * 4;
            if (data[i + 3]! < 110) continue;
            pts.push({ tx: x, ty: y, s: fine * 0.96, col: tone(data[i]!, data[i + 1]!, data[i + 2]!) });
          }
        }
      }
      if (pts.length <= cap) break;
      step += 1; fine += 1;
    }

    const P: Particle[] = pts.map((p) => {
      const a = rnd() * Math.PI * 2;
      const sp = 0.05 + rnd() * 0.12;
      return {
        tx: p.tx, ty: p.ty, s: p.s, col: p.col,
        x: rnd() * w, y: rnd() * h,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        ph: rnd() * Math.PI * 2,
        // 从左到右依次归位，看起来像字一个个写出来
        d: ((p.tx - bx) / bw) * 520 + rnd() * 320,
        fx: 0, fy: 0, bgOn: false,
      };
    });
    // 按颜色排序：draw 里同色连成一批 fill，几千个点才画得动
    P.sort((a, b) => (a.col < b.col ? -1 : a.col > b.col ? 1 : 0));
    // 每三个挑一个当常驻底噪，排序之后挑才保证各色均匀
    for (let k = 0; k < P.length; k += 1) P[k]!.bgOn = k % 3 === 0;

    this.P = P; this.bx = bx; this.bw = bw; this.dispersing = false;
    const fit = fitCanvas(this, this.canvas!);
    if (!fit) return;
    this.ctx = fit.ctx; this.w = fit.w; this.h = fit.h;
    this.last = performance.now();
    this.flow = 'roam'; this.t = 0; this.t0 = 0;
    if ((this.getAttribute('mode') || 'roam') === 'gather') this.setMode('gather');

    cancelAnimationFrame(this.raf);
    const loop = (now: number) => {
      const dt = Math.min(40, now - this.last);
      this.last = now; this.t += dt;
      this.tick(dt); this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private setMode(m: string | null): void {
    const next = m === 'gather' ? 'gather' : 'roam';
    if (!this.P.length || next === this.flow) return;
    this.flow = next;
    this.t0 = this.t;
    this.dispersing = next === 'roam';
    for (const p of this.P) {
      p.fx = p.x; p.fy = p.y;
      if (next === 'roam') {
        const a = rnd() * Math.PI * 2;
        const r = 120 + rnd() * Math.max(this.w, this.h) * 0.6;
        p.gx = p.x + Math.cos(a) * r;
        p.gy = p.y + Math.sin(a) * r;
        p.d = rnd() * 260;
      } else {
        p.d = ((p.tx - this.bx) / this.bw) * 520 + rnd() * 320;
      }
    }
  }

  private tick(dt: number): void {
    const f = dt / 16.67;
    const { P, w, h } = this;
    const m = 30;
    const since = this.t - (this.t0 || 0);
    for (const p of P) {
      if (this.flow === 'gather') {
        const ta = since - p.d;
        if (ta <= 0) { p.x += p.vx * f; p.y += p.vy * f; continue; }
        if (ta < 1400) {
          const e = EASE_IO(ta / 1400);
          p.x = p.fx + (p.tx - p.fx) * e;
          p.y = p.fy + (p.ty - p.fy) * e;
        } else {
          // 到位之后留一点呼吸，免得字死在那儿像张图片
          const e = (ta - 1400) * 0.0022 + p.ph;
          p.x = p.tx + Math.sin(e) * 0.6;
          p.y = p.ty + Math.cos(e * 1.3) * 0.6;
        }
      } else {
        const ta = since - p.d;
        if (this.t0 && ta < 900 && ta > 0 && p.gx != null) {
          const e = EASE_OUT(ta / 900);
          p.x = p.fx + (p.gx - p.fx) * e;
          p.y = p.fy + (p.gy! - p.fy) * e;
        } else {
          p.x += p.vx * f + Math.sin(this.t * 0.0004 + p.ph) * 0.1 * f;
          p.y += p.vy * f + Math.cos(this.t * 0.0003 + p.ph * 1.7) * 0.1 * f;
        }
        // 环绕出界，粒子场看起来是无边的
        if (p.x < -m) p.x += w + 2 * m; else if (p.x > w + m) p.x -= w + 2 * m;
        if (p.y < -m) p.y += h + 2 * m; else if (p.y > h + m) p.y -= h + 2 * m;
      }
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    const since = this.t - (this.t0 || 0);
    const gather = this.flow === 'gather';
    /*
      两层透明度：
        k     —— 常驻那三分之一（bgOn），游走时只剩 .2，是一层若有若无的底噪
        kRest —— 其余粒子，聚拢开始后才淡入，散开时先淡出
      名字因此读得出来是「聚起来」的，而不是一直摆在那里只是动了动。
    */
    const k = gather ? Math.min(1, 0.2 + (since / 1400) * 0.8)
      : this.dispersing ? Math.max(0.2, 1 - (since / 900) * 0.8)
      : 0.2;
    const kRest = gather ? k * Math.min(1, since / 400)
      : this.dispersing ? Math.max(0, k * (1 - since / 500))
      : 0;

    for (let pass = 0; pass < 2; pass += 1) {
      const a = pass === 0 ? k : kRest;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      let col: string | null = null;
      for (const p of this.P) {
        if ((pass === 0) !== p.bgOn) continue;
        if (p.col !== col) { col = p.col; ctx.fillStyle = col; }
        // 方块而不是圆点：和标题那块点阵是同一种颗粒
        ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
      }
    }
    ctx.globalAlpha = 1;
  }
}

// ── confetti-burst ────────────────────────────────────────────────────

interface Flake {
  x: number; y: number; vx: number; vy: number; w: number; h: number;
  rot: number; vr: number; wob: number; ws: number; col: string;
  life: number; ttl: number; round: boolean;
  /** true = 从天上飘下来的那种（drop 造的），走另一套运动与画法 */
  drift?: boolean;
  sway?: number; sph?: number; swf?: number; tilt?: number; ts?: number;
  size?: number; r?: number; alpha?: number;
}
interface Spark {
  x: number; y: number; px: number; py: number; vx: number; vy: number;
  col: string; life: number; ttl: number; r: number;
}
interface Rocket { x: number; y: number; vy: number; ty: number; col: string }

class ConfettiBurst extends HTMLElement {
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private ro?: ResizeObserver;
  private raf = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private w = 0; private h = 0; private last = 0; private start0 = 0;
  private parts: Flake[] = [];
  private sparks: Spark[] = [];
  private rockets: Rocket[] = [];

  connectedCallback(): void {
    if (!this.canvas) this.canvas = makeCanvas(this);
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this);
    this.fit();
    this.start();
  }

  disconnectedCallback(): void {
    this.stop();
    this.ro?.disconnect();
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.running = false;
  }

  private fit(): void {
    const fit = fitCanvas(this, this.canvas!);
    if (!fit) return;
    this.ctx = fit.ctx; this.w = fit.w; this.h = fit.h;
  }

  /** 颜色表。**不能叫 palette**——见文件末尾那段说明。 */
  private colors(): string[] {
    return (this.getAttribute('palette') || '#ffffff,#001217,#f97316,#fcfcf8,#ffedd5')
      .split(',').map((s) => s.trim()).filter(Boolean);
  }

  private pick(): string {
    const p = this.colors();
    return p[(rnd() * p.length) | 0]!;
  }

  private start(): void {
    this.stop();
    this.running = true;
    this.timers = [];
    this.parts = []; this.sparks = []; this.rockets = [];
    this.last = performance.now();
    this.start0 = this.last;

    /*
      两种用法：
        mode="rain"  —— 只下彩带，不放炮不放烟花，而且不停。切蛋糕那一屏用它，
                        要的是持续的气氛，不是一次性的爆点。
        默认          —— 礼炮 + 烟花 + 八秒的彩带雨，给一等奖揭晓那一下。
    */
    const rainOnly = this.getAttribute('mode') === 'rain';
    const dur = rainOnly ? Infinity : 8000;

    const at = (ms: number, fn: () => void) => {
      this.timers.push(setTimeout(() => { if (this.running) fn(); }, ms));
    };

    const rain = () => {
      if (!this.running || performance.now() - this.start0 > dur) return;
      this.drop(rainOnly ? 6 : 9);
      this.timers.push(setTimeout(rain, 200));
    };
    at(rainOnly ? 0 : 600, rain);

    if (!rainOnly) {
      // 左下、右下两门礼炮，再在中间来一发并同时放三朵烟花
      at(150, () => this.cannon(-10, this.h + 10, -Math.PI / 3.4, 150));
      at(380, () => this.cannon(this.w + 10, this.h + 10, -Math.PI + Math.PI / 3.4, 150));
      at(1900, () => { this.cannon(this.w * 0.5, this.h + 10, -Math.PI / 2, 110, 1.15); this.burstAll(); });
      [250, 600, 950, 1300, 1700, 2100, 2500, 2950, 3400, 3900, 4400, 4900, 5500, 6100, 6700, 7300, 7800]
        .forEach((ms) => at(ms, () => { this.rocket(); if (rnd() < 0.5) this.rocket(); }));
    }

    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(40, now - this.last);
      this.last = now;
      this.step(dt); this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private cannon(x: number, y: number, angle: number, count: number, power?: number): void {
    const k = power || 1;
    for (let i = 0; i < count; i += 1) {
      const sp = (16 + rnd() * 18) * k;
      const a = angle + (rnd() - 0.5) * 0.95;
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        w: 7 + rnd() * 9, h: 4 + rnd() * 7,
        rot: rnd() * Math.PI, vr: (rnd() - 0.5) * 0.35,
        wob: rnd() * Math.PI * 2, ws: 0.08 + rnd() * 0.1,
        col: this.pick(), life: 0, ttl: 3400 + rnd() * 2000, round: rnd() < 0.25,
      });
    }
  }

  /**
   * 从画面上方撒一把飘落的彩带。
   *
   * depth 同时决定大小、速度和透明度——远的小、慢、淡，近的大、快、实。
   * 这一项让一层平面的纸片看起来有前后，是「下雪」和「贴图」的差别。
   */
  private drop(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const depth = rnd();
      const S = 7 + depth * 9;
      this.parts.push({
        x: rnd() * this.w, y: -30 - rnd() * 120,
        vx: 0, vy: 0.9 + depth * 1.5, w: S, h: S,
        rot: 0, vr: 0,
        sway: 0.6 + rnd() * 0.8, sph: rnd() * Math.PI * 2, swf: 0.002 + rnd() * 0.0015,
        wob: rnd() * Math.PI * 2, ws: 0.09 + rnd() * 0.08,
        tilt: rnd() * Math.PI, ts: 0.06 + rnd() * 0.07,
        size: S, r: S * (0.3 + rnd() * 0.25), alpha: 0.55 + depth * 0.45,
        col: this.pick(), life: 0, ttl: 12000, round: false, drift: true,
      });
    }
  }

  private rocket(): void {
    this.rockets.push({
      x: this.w * 0.08 + rnd() * this.w * 0.84,
      y: this.h + 10,
      vy: -(13 + rnd() * 4),
      ty: this.h * 0.12 + rnd() * this.h * 0.4,
      col: this.spark(),
    });
  }

  private spark(): string {
    return `hsl(${(rnd() * 360) | 0},95%,${58 + rnd() * 14}%)`;
  }

  private burstAll(): void {
    [0.2, 0.5, 0.8].forEach((f, i) => {
      this.explode(this.w * f, this.h * (0.22 + i * 0.06), this.spark(), 90);
    });
  }

  private explode(x: number, y: number, col: string, n: number): void {
    const ring = rnd() < 0.4;
    const multi = rnd() < 0.45;
    const col2 = this.spark();
    for (let i = 0; i < n; i += 1) {
      const a = ring ? (i / n) * Math.PI * 2 : rnd() * Math.PI * 2;
      const sp = ring ? 6.5 + rnd() * 0.8 : 1.5 + rnd() ** 0.6 * 8.5;
      this.sparks.push({
        x, y, px: x, py: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        col: i % 6 === 0 ? '#ffffff' : (multi && i % 2 ? col2 : col),
        life: 0, ttl: 900 + rnd() * 900, r: 1.6 + rnd() * 1.6,
      });
    }
  }

  private step(dt: number): void {
    const f = dt / 16.67;
    for (let i = this.parts.length - 1; i >= 0; i -= 1) {
      const p = this.parts[i]!;
      if (p.drift) {
        // 飘落的那批不受重力，只是匀速下落 + 左右摆
        p.x += Math.sin(p.life * p.swf! + p.sph!) * p.sway! * f;
        p.y += p.vy * f;
        p.wob += p.ws * f;
        p.tilt! += p.ts! * f;
        p.life += dt;
        if (p.y > this.h + 40) this.parts.splice(i, 1);
        continue;
      }
      p.vy += 0.42 * f;
      p.vx *= 0.975 ** f; p.vy *= 0.985 ** f;
      p.x += p.vx * f + Math.sin(p.wob) * 0.6;
      p.y += p.vy * f;
      p.rot += p.vr * f; p.wob += p.ws * f; p.life += dt;
      if (p.life > p.ttl || p.y > this.h + 40) this.parts.splice(i, 1);
    }
    for (let i = this.rockets.length - 1; i >= 0; i -= 1) {
      const p = this.rockets[i]!;
      p.y += p.vy * f; p.vy += 0.14 * f;
      // 到顶或升势耗尽就炸
      if (p.y <= p.ty || p.vy >= -1) {
        this.explode(p.x, p.y, p.col, 70 + ((rnd() * 40) | 0));
        this.rockets.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i -= 1) {
      const p = this.sparks[i]!;
      p.px = p.x; p.py = p.y;
      p.vy += 0.07 * f;
      p.vx *= 0.955 ** f; p.vy *= 0.955 ** f;
      p.x += p.vx * f; p.y += p.vy * f; p.life += dt;
      if (p.life > p.ttl) this.sparks.splice(i, 1);
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);

    for (const p of this.rockets) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = p.col; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + (rnd() - 0.5) * 2, p.y + 22);
      ctx.stroke();
    }
    ctx.lineCap = 'round';
    // 火花画成上一帧到这一帧的线段，自带拖尾
    for (const p of this.sparks) {
      const a = 1 - p.life / p.ttl;
      ctx.globalAlpha = Math.max(0, Math.min(1, a * 1.3));
      ctx.strokeStyle = p.col;
      ctx.lineWidth = p.r * 2 * (0.4 + 0.6 * a);
      ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    for (const p of this.parts) {
      const rem = p.ttl - p.life;
      ctx.fillStyle = p.col;
      if (p.drift) {
        /*
          翻滚的纸片：用 tilt 和 wob 把一个四边形剪切成随机的梯形。
          比「矩形加 scaleY」更像真的——真纸片翻面时两条边不会同时收窄。
        */
        ctx.globalAlpha = p.alpha!;
        const wx = p.x + p.size! * Math.cos(p.wob);
        const wy = p.y + p.size! * Math.sin(p.wob);
        const tc = Math.cos(p.tilt!) * p.r!;
        const tsn = Math.sin(p.tilt!) * p.r!;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y); ctx.lineTo(wx, p.y + tsn);
        ctx.lineTo(wx + tc, wy + tsn); ctx.lineTo(p.x + tc, wy);
        ctx.closePath(); ctx.fill();
        continue;
      }
      ctx.globalAlpha = rem < 700 ? Math.max(0, rem / 700) : 1;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      // 按摆动相位压扁，纸片翻面的样子
      ctx.scale(1, Math.max(0.15, Math.abs(Math.cos(p.wob))));
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.h * 0.7, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * 注册。幂等——模块可能被多次 import，而 define 同名元素第二次会抛。
 * 在模块顶层调用而不是组件里：自定义元素是全局注册表，和 React 树无关。
 */
export function registerEventEffects(): void {
  if (typeof window === 'undefined' || !window.customElements) return;
  if (!customElements.get('particle-text')) customElements.define('particle-text', ParticleText);
  if (!customElements.get('confetti-burst')) customElements.define('confetti-burst', ConfettiBurst);
}

/**
 * 让 TSX 认识这两个标签。
 *
 * 属性全部声明成 string：自定义元素的属性本来就只有字符串，React 会原样
 * setAttribute。写成 number 会让调用处误以为能传数字，而 `left={96}` 和
 * `left="96"` 在这里是同一回事——都变成字符串 "96"。
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'particle-text': {
        key?: string | number;
        text?: string;
        initial?: string;
        ink?: string;
        disc?: string;
        discink?: string;
        img?: string;
        /** roam = 游走（名字读不出），gather = 聚拢成字 */
        mode?: 'roam' | 'gather';
        left?: string;
        top?: string;
        width?: string;
        height?: string;
        style?: import('react').CSSProperties;
      };
      'confetti-burst': {
        key?: string | number;
        /** 逗号分隔的颜色表 */
        palette?: string;
        /** 'rain' = 只下彩带、不停；省略 = 礼炮 + 烟花 + 八秒彩带雨 */
        mode?: 'rain';
        style?: import('react').CSSProperties;
      };
    }
  }
}

/*
  ⚠️ 自定义元素的「属性名不能和成员名撞车」。

  React 给自定义元素传值时会先看这个名字是不是元素实例上已有的属性
  （`'mode' in el`）：是，就赋值 `el.mode = 'gather'`；不是，才
  `setAttribute('mode', 'gather')`。而 attributeChangedCallback 只在后者触发。

  所以把内部状态命名成 `mode`，结果是：React 一路安静地改字段，
  observedAttributes 形同虚设，揭晓动画永远不播——没有报错，就是不动。
  confetti 的 `palette()` 更糟：方法会被字符串覆盖，下一次调用直接 TypeError。

  两者都实测踩过。内部成员一律避开对外属性名（flow / colors），
  新加属性时也照此办理。
*/
