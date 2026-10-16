/**
 * 颁奖大屏的三个画布特效：粒子文字、彩带烟花、堆积的彩色雪。
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
 * 三段都移植自设计稿的 particle-text.js / confetti-burst.js /
 * confetti-pile.js，算法未改，只补了类型、显式字段声明与几处注释。
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

// ── confetti-pile ─────────────────────────────────────────────────────

/*
  会堆起来的彩色雪。

  和上面的 confetti-burst 是两件事：burst 的彩带穿过画面就没了，pile 的
  颗粒会落在东西上堆住——点阵的每个方块、字形的每一笔，都是它的地面。
  切蛋糕那一屏要挂十几分钟给大家拍照，堆积能一直长，下雨只是一直重复。

  做法是一个很小的颗粒模拟（圆盘上的位置动力学）：颗粒飘落、与
  [data-solid] 的方块和彼此碰撞、在平缓的面上停住、在陡过休止角的面上
  继续往下滑，比自己宽的缝就漏下去。停稳一段时间的颗粒会「睡着」，被烤
  进一张缓存图层，于是画面上堆了几千颗也只有最上面那层在算。睡着的颗粒
  被砸到、或者底下的颗粒挪开了，会重新醒来——所以堆陡了之后一碰就塌方，
  塌方会顺坡往下跑并往上游啃。

  同样逐行移自设计稿 confetti-pile.js，算法未改，只补类型与注释。
*/

/** 休眠网格的格边长(px)。取 6 ≈ 两倍最大半径，一格里不会挤太多颗粒。 */
const HS = 6;
/** 地形高度图的列宽(px)。只用来快速否掉「上方什么都没有」的颗粒。 */
const RC = 4;
/** 颗粒半径上限，决定各处的邻域取多大。 */
const RMAX = 2.8;
const GRAV = 0.05;
const STEP = 1000 / 60;
const SLEEP_V2 = 0.03 * 0.03;
/** 连续静止这么多帧就睡着。 */
const SLEEP_N = 24;
/** 砸得多重才叫醒底下那颗。 */
const WAKE_V = 0.42;
const MU = 0.2;
const VMAX = 1.5;
/*
  休止角。颗粒是光滑的：新落下的最多停在 32° 的面上，而一旦滑动起来，
  要缓到 22° 才停得住——静摩擦大于动摩擦，塌方因此能一路跑到底。
*/
const TAN_STA = Math.tan((32 * Math.PI) / 180);
const TAN_DYN = Math.tan((22 * Math.PI) / 180);

/** 四个均匀分布之和，近似正态。用来把雪撒得中间密、边上疏。 */
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.73;

/**
 * 0/1 墨迹掩膜的有符号距离场：外正内负，两遍倒角法。
 *
 * 字形当地面用的时候需要它：有了距离场才能就近求出「离笔画边缘多远」
 * 和「法线朝哪」，让颗粒贴着笔画停住，而不是掉进去。
 */
function sdfOf(ink: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  const inn = new Float32Array(n);
  const sdf = new Float32Array(n);
  const pass = (d: Float32Array) => {
    const S = 1.4142;
    let x: number, y: number, i: number, v: number;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; v = d[i]!;
      if (x > 0 && d[i - 1]! + 1 < v) v = d[i - 1]! + 1;
      if (y > 0) {
        if (d[i - w]! + 1 < v) v = d[i - w]! + 1;
        if (x > 0 && d[i - w - 1]! + S < v) v = d[i - w - 1]! + S;
        if (x < w - 1 && d[i - w + 1]! + S < v) v = d[i - w + 1]! + S;
      }
      d[i] = v;
    }
    for (y = h - 1; y >= 0; y--) for (x = w - 1; x >= 0; x--) {
      i = y * w + x; v = d[i]!;
      if (x < w - 1 && d[i + 1]! + 1 < v) v = d[i + 1]! + 1;
      if (y < h - 1) {
        if (d[i + w]! + 1 < v) v = d[i + w]! + 1;
        if (x < w - 1 && d[i + w + 1]! + S < v) v = d[i + w + 1]! + S;
        if (x > 0 && d[i + w - 1]! + S < v) v = d[i + w - 1]! + S;
      }
      d[i] = v;
    }
  };
  for (let k = 0; k < n; k++) { out[k] = ink[k] ? 0 : 1e6; inn[k] = ink[k] ? 1e6 : 0; }
  pass(out); pass(inn);
  for (let k = 0; k < n; k++) sdf[k] = ink[k] ? 0.5 - inn[k]! : out[k]! - 0.5;
  return sdf;
}

interface Grain {
  x: number; y: number; px: number; py: number;
  r: number;
  /** 空气阻力系数。远处的雪飘得慢。 */
  k: number;
  /** 横向摆动的幅度、频率、相位 */
  amp: number; swf: number; sph: number;
  /** 远景：画得更小更淡 */
  far: boolean;
  color: string;
  /** 这一帧没有任何接触 */
  free: boolean;
  /** 接触数 */
  nc: number;
  /** 连续静止帧数 */
  still: number;
  asleep: boolean;
  /** 落在了朝上的平面上（可以无条件停住） */
  fl?: boolean;
  /** 睡着后所在的网格格号 */
  ci?: number;
  /** 醒过一次的颗粒用更小的休止角 */
  woken?: boolean;
  /** 持续接触的帧数 */
  ct?: number;
  /** 正在往哪边滑：-1 左、1 右、0 不滑 */
  slide?: number;
  /** 开始下滑时的位置与帧号，用来判断是不是卡住了 */
  sx0?: number; sy0?: number; st0?: number;
}

/** 超出上限的颗粒不进堆，原地淡出，省得无限涨内存。 */
interface Ghost { x: number; y: number; r: number; color: string; fade: number }
/** 一块实心矩形（[data-solid] 元素的包围盒），画布坐标。 */
interface Solid { x0: number; x1: number; y0: number; y1: number }
/** 一段文字的字形掩膜与它的距离场。 */
interface Mask { x0: number; y0: number; w: number; h: number; ink: Uint8Array; sdf: Float32Array }

class ConfettiPile extends HTMLElement {
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  /** 睡着的颗粒烤在这张离屏图上，每帧只贴一次。 */
  private sc?: HTMLCanvasElement;
  private sctx?: CanvasRenderingContext2D;
  private ro?: ResizeObserver;
  private raf = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private w = 0; private h = 0; private dpr = 1;
  private last = 0; private t0 = 0;
  /** 真实时间与模拟时间的累加器 */
  private acc = 0; private tacc = 0; private tt = 0;

  /** 休眠网格：hw×hh 格，每格一串睡着的颗粒。 */
  private hw = 0; private hh = 0;
  private sgrid: (Grain[] | undefined)[] = [];
  /** 本帧活动颗粒的临时同格索引，用 stamp 作代，省去每帧清空。 */
  private dgrid: (Grain[] | undefined)[] = [];
  private dstamp = new Int32Array(0);
  private stamp = 1;

  /** 每 RC 像素一列：该列里的实心块，以及最高的实心面。 */
  private rcols = 0;
  private rcol: (Solid[] | undefined)[] = [];
  private top = new Float32Array(0);
  private masks: Mask[] = [];

  private awake: Grain[] = [];
  private ghosts: Ghost[] = [];
  /** 本帧要叫醒的颗粒，解算完再统一处理，免得边遍历边改。 */
  private wq: Grain[] = [];
  /** 缓存图层上需要重画的矩形。 */
  private dirt: [number, number, number, number][] = [];
  private count = 0;
  /** 上一次的实心体布局签名，没变就不重建。 */
  private sig = '';

  connectedCallback(): void {
    if (!this.canvas) this.canvas = makeCanvas(this);
    this.timers = []; this.awake = []; this.ghosts = []; this.wq = []; this.dirt = [];
    this.acc = 0; this.tacc = 0; this.tt = 0; this.w = 0; this.h = 0; this.count = 0;
    this.t0 = performance.now(); this.last = this.t0; this.running = true;
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this);
    this.fit();
    /*
      反复重建实心体，而不是只在挂载时算一次：这一屏是翻页翻过来的，
      字体、图片、入场动画都要几百毫秒才落位，早了量到的是错的盒子。
    */
    [60, 700, 1500, 2700, 5000].forEach((ms) => {
      this.timers.push(setTimeout(() => this.buildSolid(), ms));
    });
    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (this.running) { this.sig = ''; this.buildSolid(); }
      });
    }
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(50, now - this.last);
      this.last = now;
      this.tick(dt, now);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  disconnectedCallback(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.ro?.disconnect();
  }

  private num(n: string, d: number): number {
    const v = parseFloat(this.getAttribute(n) ?? '');
    return isNaN(v) ? d : v;
  }

  /** 颜色表。**不能叫 palette**——见文件末尾那段说明。 */
  private colors(): string[] {
    return (this.getAttribute('palette') || '#ffffff,#001217,#f97316')
      .split(',').map((s) => s.trim()).filter(Boolean);
  }

  private fit(): void {
    const w = this.clientWidth, h = this.clientHeight;
    if (!w || !h || (w === this.w && h === this.h)) return;
    const fit = fitCanvas(this, this.canvas!);
    if (!fit) return;
    this.ctx = fit.ctx; this.w = fit.w; this.h = fit.h;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.sc = document.createElement('canvas');
    this.sc.width = this.canvas!.width; this.sc.height = this.canvas!.height;
    this.sctx = this.sc.getContext('2d')!;
    this.hw = Math.ceil(w / HS) + 2; this.hh = Math.ceil(h / HS) + 2;
    this.sgrid = new Array(this.hw * this.hh);
    this.dgrid = new Array(this.hw * this.hh);
    this.dstamp = new Int32Array(this.hw * this.hh);
    this.stamp = 1;
    this.rcols = Math.ceil(w / RC); this.count = 0; this.dirt = []; this.sig = '';
    /* 改了尺寸，堆就没了（缓存图层已失效），只留还在空中飘的 */
    this.awake = this.awake.filter((p) => p.free);
    this.rcol = []; this.top = new Float32Array(this.rcols).fill(h + 100); this.masks = [];
    this.buildSolid();
  }

  /**
   * 把 scope 里每个 [data-solid] 元素变成地面。
   *
   * 值是数字时，按该元素字号的这个比例把顶边往下缩——行盒的顶和字形的顶
   * 差着一截，不缩的话雪会停在字的上方一片空气里。
   * 值是 "text" 时走字形掩膜：雪落在笔画上，从字与字的缝里漏下去。
   */
  private buildSolid(): void {
    if (!this.w) return;
    const scope = this.closest(this.getAttribute('scope') || 'body') ?? document.body;
    const host = this.getBoundingClientRect();
    if (!host.width || !host.height) return;
    const sx = host.width / this.w, sy = host.height / this.h;
    const rects: Solid[] = [], texts: Element[] = [];
    scope.querySelectorAll('[data-solid]').forEach((el) => {
      if (el === this || this.contains(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (el.getAttribute('data-solid') === 'text') { texts.push(el); return; }
      const ins = parseFloat(el.getAttribute('data-solid') ?? '') || 0;
      const fs = ins ? parseFloat(getComputedStyle(el).fontSize) || 0 : 0;
      rects.push({
        x0: (r.left - host.left) / sx, x1: (r.right - host.left) / sx,
        y0: (r.top - host.top) / sy + fs * ins, y1: (r.bottom - host.top) / sy,
      });
    });
    /* 布局没动就别重建：重建会把已经堆好的雪的地形推倒重算 */
    const sig = rects.map((R) => `${Math.round(R.x0)},${Math.round(R.x1)},${Math.round(R.y0)},${Math.round(R.y1)}`).join('|')
      + '#' + texts.map((el) => {
        const r = el.getBoundingClientRect();
        return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${el.textContent}`;
      }).join('|');
    if (sig === this.sig) return;
    this.sig = sig;

    const rcol: (Solid[] | undefined)[] = new Array(this.rcols);
    const top = new Float32Array(this.rcols).fill(this.h + 100);
    let c: number, c1: number, i: number, j: number;
    rects.forEach((R) => {
      for (c = this.rc(R.x0 - RMAX - 1), c1 = this.rc(R.x1 + RMAX + 1); c <= c1; c++) {
        (rcol[c] ??= []).push(R);
        if (R.y0 < top[c]!) top[c] = R.y0;
      }
    });
    const masks = texts.map((el) => this.textMask(el, host, sx, sy)).filter((m): m is Mask => !!m);
    masks.forEach((M) => {
      for (i = 0; i < M.w; i++) {
        for (j = 0; j < M.h && !M.ink[j * M.w + i]; j++) { /* 找这一列最高的墨 */ }
        if (j === M.h) continue;
        for (c = this.rc(M.x0 + i - RMAX - 1), c1 = this.rc(M.x0 + i + RMAX + 2); c <= c1; c++) {
          if (M.y0 + j < top[c]!) top[c] = M.y0 + j;
        }
      }
    });
    this.rcol = rcol; this.top = top; this.masks = masks;
    for (i = 0; i < this.sgrid.length; i++) this.sgrid[i]?.forEach((g) => this.raiseTop(g));
  }

  /**
   * 把一段文字逐字刻成掩膜，再求距离场。
   *
   * 逐字而不是整段 fillText：排版里的字间距、两端对齐都会改变每个字的
   * 实际位置，只有按 Range 量出来的位置画，掩膜才和屏幕上看到的重合。
   */
  private textMask(el: Element, host: DOMRect, sx: number, sy: number): Mask | null {
    const r = el.getBoundingClientRect(), pad = 4;
    const X0 = Math.floor((r.left - host.left) / sx) - pad;
    const Y0 = Math.floor((r.top - host.top) / sy) - pad;
    const W = Math.ceil(r.width / sx) + pad * 2, H = Math.ceil(r.height / sy) + pad * 2;
    if (W < 3 || H < 3 || W * H > 4e6) return null;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#000'; c.textBaseline = 'alphabetic';
    const rg = document.createRange();
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = tw.nextNode())) {
      const data = (node as Text).data;
      const cs = getComputedStyle((node as Text).parentElement!);
      c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      for (let i = 0; i < data.length; i++) {
        const ch = data.charAt(i);
        if (!ch.trim()) continue;
        rg.setStart(node, i); rg.setEnd(node, i + 1);
        const rc = rg.getBoundingClientRect();
        if (!rc.width) continue;
        const m = c.measureText(ch);
        const asc = m.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.88;
        c.fillText(ch, (rc.left - host.left) / sx - X0, (rc.top - host.top) / sy - Y0 + asc);
      }
    }
    const px = c.getImageData(0, 0, W, H).data;
    const ink = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) ink[k] = px[k * 4 + 3]! > 100 ? 1 : 0;
    return { x0: X0, y0: Y0, w: W, h: H, ink, sdf: sdfOf(ink, W, H) };
  }

  /** 距离场的双线性采样。 */
  private sd(M: Mask, x: number, y: number): number {
    const fx = x - 0.5, fy = y - 0.5, w = M.w, s = M.sdf;
    let i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    if (i < 0) { i = 0; tx = 0; } else if (i > w - 2) { i = w - 2; tx = 1; }
    if (j < 0) { j = 0; ty = 0; } else if (j > M.h - 2) { j = M.h - 2; ty = 1; }
    const k = j * w + i;
    return (s[k]! * (1 - tx) + s[k + 1]! * tx) * (1 - ty)
      + (s[k + w]! * (1 - tx) + s[k + w + 1]! * tx) * ty;
  }

  private rc(x: number): number {
    const c = Math.floor(x / RC);
    return c < 0 ? 0 : c >= this.rcols ? this.rcols - 1 : c;
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.floor(x / HS) + 1, cy = Math.floor(y / HS) + 1;
    return cx < 0 || cy < 0 || cx >= this.hw || cy >= this.hh ? -1 : cy * this.hw + cx;
  }

  /** 堆高了就抬高这几列的「最高实心面」，上方的颗粒才知道要开始解算。 */
  private raiseTop(g: Grain): void {
    for (let c = this.rc(g.x - g.r - RMAX - 1), c1 = this.rc(g.x + g.r + RMAX + 1); c <= c1; c++) {
      if (g.y - g.r < this.top[c]!) this.top[c] = g.y - g.r;
    }
  }

  private spawn(now: number): void {
    const depth = rnd(), pal = this.colors(), w = this.w;
    const y = -4 - rnd() * 140, vt = 0.5 + depth * 0.9;
    let x: number;
    /* 一部分雪走缓慢游移的几股，于是堆是一处处长起来的，而不是均匀一层 */
    if (rnd() < 0.45) {
      const k = (rnd() * 3) | 0;
      const period = [38000, 51000, 67000][k]!, phase = [0, 2.1, 4.2][k]!;
      x = w * (0.12 + 0.76 * (0.5 + 0.5 * Math.sin((now / period) * 2 * Math.PI + phase))) + gauss() * 90;
    } else x = rnd() * w;
    x = Math.max(3, Math.min(w - 3, x));
    /* depth 同时决定大小、快慢和浓淡，远近才像一回事 */
    this.awake.push({
      x, y, px: x, py: y - (0.3 + rnd() * 0.3),
      r: 1.4 + depth * 1.4, k: GRAV / vt,
      amp: 0.2 + rnd() * 0.5, swf: 0.0007 + rnd() * 0.0011, sph: rnd() * 6.283,
      far: depth < 0.4, color: pal[(rnd() * pal.length) | 0]!,
      free: true, nc: 0, still: 0, asleep: false,
    });
  }

  /** 接触点上的切向摩擦：按穿透深度给一点阻力，颗粒才会贴着面滑而不是弹开。 */
  private fric(p: Grain, nx: number, ny: number, o: number): void {
    const vx = p.x - p.px, vy = p.y - p.py;
    const vn = vx * nx + vy * ny, tx = vx - vn * nx, ty = vy - vn * ny;
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl < 1e-9) return;
    const c = Math.min(1, (MU * o) / tl);
    p.px += tx * c; p.py += ty * c;
  }

  /** 把一颗颗粒推出所有穿透：睡着的邻居、活动的邻居、实心块、字形。 */
  private solve(p: Grain, first: boolean): void {
    p.fl = false;
    let nc = 0;
    const r = p.r, hw = this.hw;
    const x0 = Math.max(0, Math.floor((p.x - r - RMAX) / HS) + 1);
    const x1 = Math.min(hw - 1, Math.floor((p.x + r + RMAX) / HS) + 1);
    const y0 = Math.max(0, Math.floor((p.y - r - RMAX) / HS) + 1);
    const y1 = Math.min(this.hh - 1, Math.floor((p.y + r + RMAX) / HS) + 1);
    const mv = (p.x - p.px) ** 2 + (p.y - p.py) ** 2 > 0.0025;
    let cx: number, cy: number, k: number, a: Grain[] | undefined, i: number, g: Grain;
    let dx: number, dy: number, rr: number, d2: number, d: number, o: number, nx: number, ny: number;

    for (cy = y0; cy <= y1; cy++) for (cx = x0; cx <= x1; cx++) {
      k = cy * hw + cx; a = this.sgrid[k];
      if (a) for (i = 0; i < a.length; i++) {
        g = a[i]!; dx = p.x - g.x; dy = p.y - g.y; rr = r + g.r; d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 < 1e-10) continue;
        d = Math.sqrt(d2); o = rr - d; nx = dx / d; ny = dy / d;
        /* 砸得够重，或者底下那颗正在挪开：叫醒它 */
        if (first) {
          const vn = -((p.x - p.px) * nx + (p.y - p.py) * ny);
          if ((vn > WAKE_V && rnd() < 0.3) || (mv && ny > 0.3)) this.wq.push(g);
        }
        p.x += nx * o; p.y += ny * o; nc++; this.fric(p, nx, ny, o);
      }
      if (this.dstamp[k] === this.stamp) {
        a = this.dgrid[k]!;
        for (i = 0; i < a.length; i++) {
          g = a[i]!; if (g === p) continue;
          dx = p.x - g.x; dy = p.y - g.y; rr = r + g.r; d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr || d2 < 1e-10) continue;
          d = Math.sqrt(d2); o = (rr - d) * 0.5; nx = dx / d; ny = dy / d;
          p.x += nx * o; p.y += ny * o; g.x -= nx * o; g.y -= ny * o; nc++;
        }
      }
    }

    const L = this.rcol[this.rc(p.x)];
    if (L) for (i = 0; i < L.length; i++) {
      const R = L[i]!;
      const qx = p.x < R.x0 ? R.x0 : p.x > R.x1 ? R.x1 : p.x;
      const qy = p.y < R.y0 ? R.y0 : p.y > R.y1 ? R.y1 : p.y;
      dx = p.x - qx; dy = p.y - qy; d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) { d = Math.sqrt(d2); nx = dx / d; ny = dy / d; o = r - d; }
      else {
        /* 圆心已经在块里了：从最近的那条边推出去 */
        const lf = p.x - R.x0, rt = R.x1 - p.x, tp = p.y - R.y0, bt = R.y1 - p.y;
        const m = Math.min(lf, rt, tp, bt);
        if (m === tp) { nx = 0; ny = -1; o = tp + r; }
        else if (m === lf) { nx = -1; ny = 0; o = lf + r; }
        else if (m === rt) { nx = 1; ny = 0; o = rt + r; }
        else { nx = 0; ny = 1; o = bt + r; }
      }
      p.x += nx * o; p.y += ny * o; nc++; this.fric(p, nx, ny, o);
      if (ny < -0.7) p.fl = true;
    }

    for (i = 0; i < this.masks.length; i++) {
      const M = this.masks[i]!;
      const lx = p.x - M.x0, ly = p.y - M.y0;
      if (lx < 1.5 || ly < 1.5 || lx > M.w - 1.5 || ly > M.h - 1.5) continue;
      d = this.sd(M, lx, ly);
      if (d >= r) continue;
      nx = this.sd(M, lx + 0.7, ly) - this.sd(M, lx - 0.7, ly);
      ny = this.sd(M, lx, ly + 0.7) - this.sd(M, lx, ly - 0.7);
      d2 = Math.sqrt(nx * nx + ny * ny);
      if (d2 < 1e-6) { nx = 0; ny = -1; } else { nx /= d2; ny /= d2; }
      o = r - d; p.x += nx * o; p.y += ny * o; nc++; this.fric(p, nx, ny, o);
      if (ny < -0.35) p.fl = true;
    }
    p.nc = nc; p.free = nc === 0;
  }

  /**
   * x 这一列在 [y0, y1] 之间最高的实心面（块、睡着的颗粒或笔画）。
   * y0 已经被填住时返回 y0-1，整段都空时返回 y1+1。
   */
  private surfaceAt(x: number, y0: number, y1: number): number {
    let best = y1 + 1, t: number;
    const L = this.rcol[this.rc(x)];
    if (L) for (let i = 0; i < L.length; i++) {
      const R = L[i]!;
      if (x >= R.x0 && x <= R.x1 && R.y1 >= y0 && R.y0 <= y1) {
        t = Math.max(R.y0, y0 - 1); if (t < best) best = t;
      }
    }
    const cx0 = Math.max(0, Math.floor((x - RMAX) / HS) + 1);
    const cx1 = Math.min(this.hw - 1, Math.floor((x + RMAX) / HS) + 1);
    const cy0 = Math.max(0, Math.floor((y0 - 2 * RMAX) / HS) + 1);
    const cy1 = Math.min(this.hh - 1, Math.floor((y1 + RMAX) / HS) + 1);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const a = this.sgrid[cy * this.hw + cx];
      if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const g = a[i]!;
        if (Math.abs(g.x - x) > g.r + 0.4 || g.y + g.r < y0 || g.y - g.r > y1) continue;
        t = Math.max(g.y - g.r, y0 - 1); if (t < best) best = t;
      }
    }
    for (let i = 0; i < this.masks.length; i++) {
      const R = this.masks[i]!;
      const cx = Math.floor(x - R.x0);
      if (cx < 0 || cx >= R.w) continue;
      for (let cy = Math.max(0, Math.floor(y0 - 1 - R.y0)), e = Math.min(R.h - 1, Math.floor(y1 - R.y0)); cy <= e; cy++) {
        if (R.ink[cy * R.w + cx]) { t = Math.max(R.y0 + cy, y0 - 1); if (t < best) best = t; break; }
      }
    }
    return best;
  }

  /**
   * 能停住就返回 0，否则返回该往哪边滑（-1 / 1）：旁边的面陡过 tanMax。
   *
   * 探测列被挡住时跳过：颗粒和那一列之间齐腰高处还有东西（一笔画、一个
   * 邻居），说明它根本滚不过去，那边的空当就不算悬崖。
   */
  private steepDir(p: Grain, tanMax: number): number {
    const yt = p.y - p.r, m = [0, 0];
    for (let s = 0; s < 2; s++) {
      let blocked = false;
      for (let dx = 4; dx <= 8 && !blocked; dx += 4) {
        const x = p.x + (s ? dx : -dx);
        if (x < 1 || x > this.w - 1) break;
        if (this.surfaceAt(p.x + (s ? dx - 2 : 2 - dx), p.y - p.r * 0.5, p.y + p.r * 0.5) <= p.y + p.r * 0.5) { blocked = true; break; }
        const sl = (this.surfaceAt(x, yt - 1, yt + dx * tanMax + 10) - yt) / dx;
        if (sl > m[s]!) m[s] = sl;
      }
    }
    if (m[0]! <= tanMax && m[1]! <= tanMax) return 0;
    return m[0]! > m[1]! + 0.05 ? -1 : m[1]! > m[0]! + 0.05 ? 1 : (rnd() < 0.5 ? -1 : 1);
  }

  /** 睡着：从活动表移进网格，并烤进缓存图层。 */
  private sleep(p: Grain): void {
    const ghost = () => this.ghosts.push({ x: p.x, y: p.y, r: p.r, color: p.color, fade: 0 });
    if (this.count >= this.num('cap', 16000)) { ghost(); return; }
    const k = this.cellOf(p.x, p.y);
    if (k < 0) { ghost(); return; }
    p.ci = k; p.asleep = true; p.woken = false; p.ct = 0; p.slide = 0;
    (this.sgrid[k] ??= []).push(p);
    this.count++;
    this.raiseTop(p);
    const ctx = this.sctx!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 0.95; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
  }

  private wake(g: Grain): void {
    if (!g.asleep) return;
    const a = this.sgrid[g.ci!];
    const i = a ? a.indexOf(g) : -1;
    if (i >= 0) { a![i] = a![a!.length - 1]!; a!.pop(); }
    g.asleep = false; g.woken = true; g.ct = 0; g.slide = 0;
    this.count--;
    g.px = g.x; g.py = g.y; g.still = 0; g.free = false; g.nc = 1;
    this.awake.push(g);
    this.dirt.push([g.x - g.r - 1, g.y - g.r - 1, g.x + g.r + 1, g.y + g.r + 1]);
  }

  /** 一个固定步长的模拟步。 */
  private sub(): void {
    const A = this.awake, w = this.w, h = this.h;
    const act: Grain[] = [];
    let i: number, j: number, p: Grain, vx: number, vy: number, s: number, k: number;
    this.tt += STEP; this.stamp++;

    for (i = 0; i < A.length; i++) {
      p = A[i]!; vx = p.x - p.px; vy = p.y - p.py;
      /* 空中：横向摆动 + 空气阻力。接触中：几乎不减速，光滑颗粒。 */
      if (p.free) { vx += (Math.sin(this.tt * p.swf + p.sph) * p.amp - vx) * p.k; vy += GRAV - vy * p.k; }
      else { s = p.nc >= 2 ? 0.92 : 0.97; vx = vx * s + (p.slide ? p.slide * 0.05 : 0); vy = vy * s + GRAV; }
      s = vx * vx + vy * vy;
      if (s > VMAX * VMAX) { s = VMAX / Math.sqrt(s); vx *= s; vy *= s; }
      p.px = p.x; p.py = p.y; p.x += vx; p.y += vy;
      if (p.x < p.r) { p.x = p.r; p.px = p.x; } else if (p.x > w - p.r) { p.x = w - p.r; p.px = p.x; }
      /* 上方什么都没有的颗粒直接跳过解算——绝大多数帧里这是大多数颗粒 */
      if (p.y + p.r >= this.top[this.rc(p.x)]! - 3) {
        act.push(p);
        k = this.cellOf(p.x, p.y);
        if (k >= 0) {
          if (this.dstamp[k] !== this.stamp) { this.dstamp[k] = this.stamp; this.dgrid[k] = [p]; }
          else this.dgrid[k]!.push(p);
        }
      } else { p.free = true; p.nc = 0; }
    }

    for (i = 0; i < act.length; i++) this.solve(act[i]!, true);
    for (i = 0; i < act.length; i++) this.solve(act[i]!, false);
    for (i = 0; i < this.wq.length; i++) this.wake(this.wq[i]!);
    this.wq.length = 0;

    for (i = 0, j = 0; i < A.length; i++) {
      p = A[i]!;
      if (p.y > h + 10) continue;
      vx = p.x - p.px; vy = p.y - p.py;
      if (p.free) { p.ct = 0; p.slide = 0; } else p.ct = (p.ct ?? 0) + 1;
      s = vx * vx + vy * vy;
      if (!p.free && s < SLEEP_V2) p.still++; else p.still = 0;
      /* 正在滑的颗粒每 10 帧回头看一眼，滑到能停的面上就收手 */
      if (p.slide && p.ct! % 10 === 0 && !this.steepDir(p, p.woken ? TAN_DYN : TAN_STA)) p.slide = 0;
      if (p.still > SLEEP_N || (p.ct! > 120 && s < 0.0036 && p.ct! % 6 === 0)) {
        /* 平顶上随便停；停在别的颗粒上则要看坡够不够缓 */
        k = p.fl ? 0 : this.steepDir(p, p.woken ? TAN_DYN : TAN_STA);
        if (!k) { this.sleep(p); continue; }
        if (!p.slide) { p.slide = k; p.sx0 = p.x; p.sy0 = p.y; p.st0 = p.ct; }
        else if (p.ct! - p.st0! > 90) {
          /* 往下推了 1.5 秒还在原地 1px 内：卡住了，让它停 */
          if (Math.abs(p.x - p.sx0!) + Math.abs(p.y - p.sy0!) < 1) { this.sleep(p); continue; }
          p.sx0 = p.x; p.sy0 = p.y; p.st0 = p.ct;
        }
        p.still = 0;
      }
      A[j++] = p;
    }
    A.length = j;
  }

  /** 重画缓存图层的一块（有颗粒被叫醒，原处要擦掉）。 */
  private repaint(x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.sctx!, d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    ctx.globalAlpha = 0.95;
    const cx0 = Math.max(0, Math.floor((x0 - RMAX) / HS) + 1);
    const cx1 = Math.min(this.hw - 1, Math.floor((x1 + RMAX) / HS) + 1);
    const cy0 = Math.max(0, Math.floor((y0 - RMAX) / HS) + 1);
    const cy1 = Math.min(this.hh - 1, Math.floor((y1 + RMAX) / HS) + 1);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const a = this.sgrid[cy * this.hw + cx];
      if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const g = a[i]!;
        ctx.fillStyle = g.color;
        ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 6.2832); ctx.fill();
      }
    }
    ctx.restore();
  }

  private tick(dt: number, now: number): void {
    if (!this.w) return;
    const rate = this.num('rate', 180), dur = this.num('duration', Infinity);
    this.tacc += dt;
    /*
      按模拟步数撒雪，不按真实时间：掉帧的时候，一帧里补不完的模拟步会被
      丢掉（下面 n < 2），要是还照真实时间撒，雪量就会比模拟推进得多，
      越卡越多。最多追两步也是为此——宁可慢一点，不要雪崩式堆积。
    */
    let n = 0;
    while (this.tacc >= STEP && n < 2) {
      if (now - this.t0 < dur) {
        this.acc += (rate * STEP) / 1000;
        while (this.acc >= 1) { this.acc--; this.spawn(now); }
      }
      this.sub();
      this.tacc -= STEP; n++;
    }
    if (this.tacc > STEP) this.tacc = 0;

    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      this.ghosts[i]!.fade += dt;
      if (this.ghosts[i]!.fade > 500) this.ghosts.splice(i, 1);
    }
    const D = this.dirt;
    /* 脏块太多就整张重画，一块块补反而更慢 */
    if (D.length > 60) this.repaint(0, 0, this.w, this.h);
    else for (let i = 0; i < D.length; i++) this.repaint(D[i]![0], D[i]![1], D[i]![2], D[i]![3]);
    this.dirt = [];
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const d = this.dpr, A = this.awake;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
    ctx.drawImage(this.sc!, 0, 0);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    /* 按「远近 + 颜色」分组，一组一次 fill：几千个 arc 分开画会卡 */
    const groups: Record<string, Grain[]> = {};
    for (let i = 0; i < A.length; i++) {
      const p = A[i]!;
      const key = (p.free && p.far ? 'f' : 'n') + p.color;
      (groups[key] ??= []).push(p);
    }
    for (const key in groups) {
      const L = groups[key]!;
      ctx.globalAlpha = key.charAt(0) === 'f' ? 0.6 : 0.95;
      ctx.fillStyle = key.slice(1);
      ctx.beginPath();
      for (let j = 0; j < L.length; j++) {
        const p = L[j]!;
        ctx.moveTo(p.x + p.r, p.y);
        ctx.arc(p.x, p.y, p.r, 0, 6.2832);
      }
      ctx.fill();
    }
    for (let i = 0; i < this.ghosts.length; i++) {
      const p = this.ghosts[i]!;
      ctx.globalAlpha = 0.95 * Math.max(0, 1 - p.fade / 500);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
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
  if (!customElements.get('confetti-pile')) customElements.define('confetti-pile', ConfettiPile);
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
      'confetti-pile': {
        key?: string | number;
        /** 逗号分隔的颜色表 */
        palette?: string;
        /**
         * 在哪一棵子树里找 [data-solid]。CSS 选择器，从本元素往上 closest()，
         * 省略则取 body。大屏传 '#award-screen'：只有那一屏的东西算地面。
         */
        scope?: string;
        /** 每秒落多少颗，默认 180 */
        rate?: string;
        /** 堆里最多留多少颗，超了的落地即淡出，默认 16000 */
        cap?: string;
        /** 下多久(ms)后停，默认一直下 */
        duration?: string;
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
