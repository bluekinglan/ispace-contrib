import { useEffect, useRef } from 'react';

/**
 * 跟着指针亮起来的 0/1 比特场。
 *
 * 铺在 hero、内容区和首页腰带上的一层 canvas：鼠标走到哪，那一圈的 0/1
 * 就亮起来，离开后慢慢熄掉。设计稿里三处都挂了这一层，截图上 hero 右上角
 * 那些若隐若现的 0/1 就是它。
 *
 * ┌─ 几个不显眼但要紧的点 ────────────────────────────────────────────┐
 * │ · pointer 事件挂在**父元素**上，不在 canvas 上：canvas 自己是        │
 * │   pointer-events:none，否则它会把底下按钮的点击全吃掉。             │
 * │ · 不在动的时候不跑 rAF。热度全部衰减到 0 就停，鼠标再进来才重启——    │
 * │   这一页会在大屏上挂一整天，空转的 rAF 没有理由一直烧 CPU。          │
 * │ · prefers-reduced-motion 直接不启动。                               │
 * │ · 画布按 devicePixelRatio 放大后再 setTransform 缩回来，否则高清屏    │
 * │   上字是糊的。                                                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 父元素必须是 position:relative（canvas 用 inset:0 铺满它）。
 */
export function BitField({ rgb, alpha, glow, glowAlpha, radius = 150 }: {
  /** 字的颜色，"R,G,B" */
  rgb: string;
  /** 字最亮时的透明度 */
  alpha: number;
  /** 光晕颜色，"R,G,B" */
  glow: string;
  /** 光晕透明度 */
  glowAlpha: number;
  /** 影响半径（px） */
  radius?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    const host = cv?.parentElement;
    const ctx = cv?.getContext('2d');
    if (!cv || !host || !ctx) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    /* 字格：14×18 正好排得下 12px 的等宽数字 */
    const CW = 14;
    const CH = 18;
    const R = radius;

    let raf = 0;
    let running = false;
    let inside = false;
    let mx = -999;
    let my = -999;
    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    let heat = new Float32Array(0);
    let bit = new Uint8Array(0);

    const size = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      w = r.width; h = r.height;
      cols = Math.ceil(w / CW); rows = Math.ceil(h / CH);
      heat = new Float32Array(cols * rows);
      bit = new Uint8Array(cols * rows);
      for (let i = 0; i < bit.length; i += 1) bit[i] = Math.random() < 0.5 ? 1 : 0;
    };

    const tick = () => {
      ctx.clearRect(0, 0, w, h);

      if (inside) {
        const g = ctx.createRadialGradient(mx, my, 0, mx, my, R * 1.4);
        g.addColorStop(0, `rgba(${glow},${glowAlpha})`);
        g.addColorStop(1, `rgba(${glow},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(mx - R * 1.4, my - R * 1.4, R * 2.8, R * 2.8);

        /* 只遍历光圈覆盖到的格子，不是整块画布 */
        const c0 = Math.max(0, Math.floor((mx - R) / CW));
        const c1 = Math.min(cols - 1, Math.ceil((mx + R) / CW));
        const r0 = Math.max(0, Math.floor((my - R) / CH));
        const r1 = Math.min(rows - 1, Math.ceil((my + R) / CH));
        for (let y = r0; y <= r1; y += 1) {
          for (let x = c0; x <= c1; x += 1) {
            const dx = x * CW + CW / 2 - mx;
            const dy = y * CH + CH / 2 - my;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d >= R) continue;
            const p = 1 - d / R;
            const i = y * cols + x;
            const v = p * p;
            if (v > heat[i]!) heat[i] = v;
            /* 越靠近指针，0/1 翻面越频繁——看上去像在跳动 */
            if (Math.random() < 0.06 * p) bit[i]! ^= 1;
          }
        }
      }

      ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let alive = false;
      for (let i = 0; i < heat.length; i += 1) {
        const v = heat[i]!;
        if (v < 0.015) { heat[i] = 0; continue; }
        alive = true;
        ctx.fillStyle = `rgba(${rgb},${(v * alpha).toFixed(3)})`;
        ctx.fillText(
          bit[i] ? '1' : '0',
          (i % cols) * CW + CW / 2,
          ((i / cols) | 0) * CH + CH / 2,
        );
        heat[i] = v * 0.95;
      }

      /* 全暗了就停：鼠标不在上面时没有理由继续排 rAF */
      if (alive || inside) raf = requestAnimationFrame(tick);
      else running = false;
    };

    const run = () => { if (!running) { running = true; raf = requestAnimationFrame(tick); } };
    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      inside = true; run();
    };
    const onLeave = () => { inside = false; run(); };

    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    size();

    return () => {
      cancelAnimationFrame(raf);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      ro.disconnect();
    };
  }, [rgb, alpha, glow, glowAlpha, radius]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
}
