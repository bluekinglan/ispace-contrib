/**
 * 颁奖大屏的背景音乐。
 *
 * 一屏对应一段「音乐提示」（cue），翻页时切 cue，切的时候淡入淡出：
 *
 *   theme   开场、议程、流程介绍    《Heroic Age》循环
 *   roll    每个奖的铺垫页          合成的军鼓滚奏，越滚越响
 *   fanfare 揭晓那一下              镲一声 +《Fanfare for Space》，放一遍
 *   party   总览、抽奖、切蛋糕      《Winner Winner!》循环
 *
 * 曲子都是 Kevin MacLeod（incompetech.com）的，CC-BY 4.0——可以商用，但必须
 * 署名，署名在总览页右下角。换曲子时那行署名要跟着改。
 *
 * 浏览器不允许页面没被碰过就出声。投屏时主持人第一次按翻页键之前，这里
 * 的 play() 会被拒，所以 kick() 让任何一次按键或点击都重试一下当前的 cue。
 */

export type Cue = 'theme' | 'roll' | 'fanfare' | 'party' | null;

const TRACKS = {
  theme: { src: '/award-music/heroic-age.mp3', vol: 0.55, loop: true },
  fanfare: { src: '/award-music/fanfare-for-space.mp3', vol: 0.9, loop: false },
  party: { src: '/award-music/winner-winner.mp3', vol: 0.5, loop: true },
} as const;
type Track = keyof typeof TRACKS;

/** 淡入淡出的时长（毫秒）。翻页之间主持人一般会停顿，0.8 秒不会抢话 */
const FADE_MS = 800;

export class AwardAudio {
  private els = new Map<Track, HTMLAudioElement>();
  private fades = new Map<Track, number>();
  private cue: Cue = null;
  private muted = false;
  private ctx: AudioContext | null = null;
  private roll: { stop: (crash: boolean) => void } | null = null;

  constructor() {
    for (const [k, t] of Object.entries(TRACKS) as [Track, (typeof TRACKS)[Track]][]) {
      const a = new Audio(t.src);
      a.preload = 'auto';
      a.loop = t.loop;
      a.volume = 0;
      this.els.set(k, a);
    }
  }

  isMuted(): boolean { return this.muted; }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.muted) {
      for (const k of this.els.keys()) this.fadeTo(k, 0);
      this.roll?.stop(false); this.roll = null;
    } else {
      this.apply(this.cue, null);
    }
    return this.muted;
  }

  /** 翻到新的一屏 */
  set(cue: Cue): void {
    if (cue === this.cue) return;
    const prev = this.cue;
    this.cue = cue;
    if (!this.muted) this.apply(cue, prev);
  }

  /** 用户碰了一下页面：之前因为自动播放限制没放出来的，现在补上 */
  kick(): void {
    if (this.muted || !this.cue) return;
    void this.ctx?.resume();
    const t = this.trackOf(this.cue);
    const a = t ? this.els.get(t) : null;
    if (a && a.paused && !(t === 'fanfare' && a.ended)) {
      if (t === 'fanfare') a.currentTime = 0;
      this.fadeTo(t!, TRACKS[t!].vol);
    }
    if (this.cue === 'roll' && !this.roll) this.roll = this.startRoll();
  }

  dispose(): void {
    for (const [k, a] of this.els) { window.clearInterval(this.fades.get(k)); a.pause(); a.src = ''; }
    this.roll?.stop(false);
    void this.ctx?.close();
  }

  private trackOf(cue: Cue): Track | null {
    return cue === 'theme' || cue === 'fanfare' || cue === 'party' ? cue : null;
  }

  private apply(cue: Cue, prev: Cue): void {
    const want = this.trackOf(cue);
    for (const k of this.els.keys()) if (k !== want) this.fadeTo(k, 0);

    if (cue === 'roll') {
      if (!this.roll) this.roll = this.startRoll();
    } else if (this.roll) {
      // 从铺垫翻到揭晓，鼓点收在一声镲上；往别处翻就直接停
      this.roll.stop(cue === 'fanfare');
      this.roll = null;
    }

    if (!want) return;
    const a = this.els.get(want)!;
    // 号角每次揭晓都从头吹；主题曲和庆祝曲接着上次停下的地方放，不每次重来
    if (want === 'fanfare' && prev !== 'fanfare') a.currentTime = 0;
    this.fadeTo(want, TRACKS[want].vol);
  }

  private fadeTo(k: Track, target: number): void {
    const a = this.els.get(k)!;
    window.clearInterval(this.fades.get(k));
    if (target > 0 && a.paused) {
      a.play().catch(() => undefined); // 被自动播放策略拒了就等 kick()
    }
    const from = a.volume;
    const t0 = performance.now();
    const id = window.setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / FADE_MS);
      a.volume = Math.max(0, Math.min(1, from + (target - from) * p));
      if (p >= 1) {
        window.clearInterval(id);
        if (target === 0) a.pause();
      }
    }, 40);
    this.fades.set(k, id);
  }

  private audio(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    void this.ctx.resume();
    return this.ctx;
  }

  /**
   * 军鼓滚奏：白噪声过带通，一下一下地打，间隔越来越密、声音越来越大，
   * 8 秒后滚到最密最响并一直滚着，等主持人按下揭晓。
   *
   * 不用录好的鼓点文件：铺垫页停多久完全看主持人，录音放完了就露馅，
   * 合成的可以无限滚。
   */
  private startRoll(): { stop: (crash: boolean) => void } {
    const ctx = this.audio();
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 0.25);
    const noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const hit = (at: number, level: number, dur = 0.09) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + dur);
      src.connect(bp).connect(g).connect(out);
      src.start(at, Math.random() * 0.1, dur + 0.02);
    };

    const RAMP = 8;
    const start = ctx.currentTime + 0.05;
    let next = start;
    let stopped = false;
    // 每 100ms 往前排 300ms 的鼓点，后台标签页里 setInterval 变慢也不断档
    const pump = () => {
      const horizon = ctx.currentTime + 0.3;
      while (next < horizon) {
        const p = Math.min(1, (next - start) / RAMP);
        hit(next, 0.06 + 0.34 * p * p);
        next += 0.16 - 0.105 * p; // 一秒约 6 下 → 18 下
      }
    };
    pump();
    const id = window.setInterval(pump, 100);

    return {
      stop: (crash) => {
        if (stopped) return;
        stopped = true;
        window.clearInterval(id);
        const now = ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(0, now + 0.05);
        window.setTimeout(() => out.disconnect(), 400);
        if (crash) this.crash();
      },
    };
  }

  /** 一声镲 + 一记底鼓，滚奏收尾、号角进来之前那一下 */
  private crash(): void {
    const ctx = this.audio();
    const now = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 5000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
    src.connect(hp).connect(g).connect(ctx.destination);
    src.start(now);

    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.9, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc.connect(og).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.45);
  }
}
