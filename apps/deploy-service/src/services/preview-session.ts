import { randomBytes } from 'node:crypto';

/**
 * 预览会话（见 docs/specs/2026-10-20-preview-runtime.md §4）。
 *
 * 一个预览会话 = 「某个人，在接下来这段时间里，可以看自己工作区里的东西」。
 * 它带两样东西：
 *   id    —— 出现在预览地址里，决定伺服哪个人的工作区
 *   token —— 交给沙箱里的页面，让它能带身份取数（§5.2）
 *
 * ┌─ 为什么 id 和 token 是两样东西 ──────────────────────────────────────┐
 * │ id 在地址栏里，会进浏览器历史、会被截图、复制给同事看一眼就出去了。  │
 * │ 所以光有 id 什么也做不了——走 id 的那条路每次都还要 requireAuth 再   │
 * │ 查一遍归属（routes/preview.ts）。                                    │
 * │                                                                      │
 * │ token 则是真凭据：沙箱页面拿它调取数端点时没有 cookie 可带。它只经   │
 * │ postMessage 递进页面、不出现在任何地址里，而且只读、只限本人、只走   │
 * │ 白名单那几条路径。                                                    │
 * └──────────────────────────────────────────────────────────────────────┘
 */

/** 硬上限：无论多活跃，一个预览最多活这么久。 */
export const PREVIEW_MAX_MS = 60 * 60 * 1000;
/** 空闲上限：这么久没人请求就回收。创建屏是人盯着看的场景，人走了就不该留着。 */
export const PREVIEW_IDLE_MS = 15 * 60 * 1000;

export interface PreviewSession {
  id: string;
  token: string;
  userId: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * 预览会话表。
 *
 * NOTE(多实例)：和 Agent 会话、待确认 token 一样存在内存里
 * （见 routes/agent.ts 的同名 NOTE）。横向扩容时三者要一起外置，
 * 否则用户的下一个请求打到另一个实例就找不到会话了。
 */
export class PreviewSessions {
  private readonly byId = new Map<string, PreviewSession>();
  /** token → id。取数端点按 token 找人，不能 O(n) 扫。 */
  private readonly byToken = new Map<string, string>();
  /** userId → id。一人同时只有一个预览，见 open 的说明。 */
  private readonly byUser = new Map<string, string>();

  /** 时钟注入，单测里才能不靠真等 60 分钟去验过期。 */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 开一个预览。**同一个人原有的那个会被立刻作废。**
   *
   * 不复用旧会话是有意的：页面重新加载就该换一把新钥匙，旧的当场失效。
   * 代价是同一个人开两个创建屏时，老的那个会停止工作——而「每人同时
   * 1 个预览」本来就是约定的配额（方案 §6.7），表现一致，不算意外。
   */
  open(userId: string, username: string): PreviewSession {
    this.prune();
    const prev = this.byUser.get(userId);
    if (prev) this.drop(prev);

    const s: PreviewSession = {
      /*
        24 字节 = 192 位熵。比原先的 16 字节长，是因为 **id 现在就是凭据**
        ——文件请求不再要 cookie（见 routes/preview.ts 文件头）。它要像会话
        令牌一样猜不出来，而不只是"不容易撞上"。
      */
      id: randomBytes(24).toString('base64url'),
      token: randomBytes(32).toString('base64url'),
      userId,
      username,
      createdAt: this.now(),
      lastSeenAt: this.now(),
    };
    this.byId.set(s.id, s);
    this.byToken.set(s.token, s.id);
    this.byUser.set(userId, s.id);
    return s;
  }

  /** 按 id 取。过期的当作不存在——顺手清掉，不留在表里。 */
  get(id: string): PreviewSession | null {
    const s = this.byId.get(id);
    if (!s) return null;
    if (this.expired(s)) { this.drop(id); return null; }
    return s;
  }

  /** 按 token 取。取数端点唯一的入口。 */
  byAccessToken(token: string): PreviewSession | null {
    const id = this.byToken.get(token);
    return id ? this.get(id) : null;
  }

  /** 每次请求都刷一下，空闲计时从最后一次请求算起。 */
  touch(s: PreviewSession): void {
    s.lastSeenAt = this.now();
  }

  /**
   * 这个人此刻有没有一块活着的预览。
   *
   * 给系统提示用：有预览才告诉模型「用户正看着，你每写完一个文件它就刷新」。
   * 查真实状态而不是收前端的声明——那句话对没有预览的会话就是假话。
   */
  hasFor(userId: string): boolean {
    return this.sessionFor(userId) !== null;
  }

  /** 同上，但把会话本身给出来——调用方要用 username 去看工作区里是什么。 */
  sessionFor(userId: string): PreviewSession | null {
    const id = this.byUser.get(userId);
    return id === undefined ? null : this.get(id);
  }

  /**
   * 主动释放（创建屏卸载时 sendBeacon 打过来）。
   *
   * 只是加速，不能依赖：浏览器崩溃、断网时这一下发不出来，
   * 真正兜底的是 prune 的两条超时。
   */
  release(id: string, userId: string): boolean {
    const s = this.byId.get(id);
    if (!s || s.userId !== userId) return false;
    this.drop(id);
    return true;
  }

  /** 清掉所有超时的。由 routes/preview.ts 的定时器按周期调。 */
  prune(): number {
    let n = 0;
    for (const [id, s] of this.byId) {
      if (this.expired(s)) { this.drop(id); n += 1; }
    }
    return n;
  }

  get size(): number {
    return this.byId.size;
  }

  /** 这个会话还剩多久到硬上限。前端据此知道什么时候该重开。 */
  expiresAt(s: PreviewSession): number {
    return s.createdAt + PREVIEW_MAX_MS;
  }

  private expired(s: PreviewSession): boolean {
    const t = this.now();
    return t - s.createdAt > PREVIEW_MAX_MS || t - s.lastSeenAt > PREVIEW_IDLE_MS;
  }

  private drop(id: string): void {
    const s = this.byId.get(id);
    if (!s) return;
    this.byId.delete(id);
    this.byToken.delete(s.token);
    if (this.byUser.get(s.userId) === id) this.byUser.delete(s.userId);
  }
}
