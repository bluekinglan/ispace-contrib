import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * 平台会话。
 *
 * 用无状态 JWT 而非服务端会话表：CLI 与 MCP 都需要携带凭据调用 REST，
 * 无状态令牌让三个入口（浏览器 / CLI / MCP）共用一套鉴权，不必为 CLI
 * 另做一套 token 体系。
 *
 * 无状态的代价本来是「撤销只能等过期」。现在有两条即时失效的路，都靠
 * 鉴权中间件每次查用户行实现，仍然不需要会话表：
 *   users.status='archived'  —— 归档立刻失去全部访问权
 *   users.token_epoch        —— 改密码后 +1，之前签出去的令牌全部作废
 *
 * 剩下的仍然撤不掉的是「单独踢掉某一台设备」：世代号是按人算的，动它会
 * 把这个人所有设备一起踢下线。要做到那个粒度就得记住每个令牌，也就回到
 * 会话表了——目前没有这个需求。
 */

export const sessionClaimsSchema = z.object({
  /** 平台 users.id */
  uid: z.string().uuid(),
  username: z.string(),
  role: z.enum(['employee', 'admin']),
  identity: z.enum(['user', 'developer']),
  /**
   * 签发这一刻的 users.token_epoch。鉴权时与库里的值比，对不上就是
   * 「改密码之后签发的这一代已经换了」，令牌作废。
   *
   * ┌─ 为什么是可选的 ──────────────────────────────────────────────┐
   * │ 写成必填的话，这次上线瞬间所有在用的令牌都 parse 失败——会话    │
   * │ 默认 30 天，等于把全公司一起踢下线，而他们什么也没做错。        │
   * │                                                                │
   * │ 可选 + 读不到当 0，正好对上 token_epoch 的默认值 0：旧令牌继续  │
   * │ 用到自然过期，而从现在起任何一次改密码都会把它们作废。安全性   │
   * │ 没有打折——伪造或篡改 epoch 都要有签名密钥，有密钥的话这套机制  │
   * │ 本来就不设防。                                                 │
   * │                                                                │
   * │ 等最长会话（30 天）过完，在用的令牌就都带 epoch 了，那时可以把  │
   * │ optional 去掉，让缺字段变成一个会报错的 bug 而不是悄悄降级。   │
   * └────────────────────────────────────────────────────────────────┘
   */
  epoch: z.number().int().nonnegative().optional(),
});
export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

const ISSUER = 'ispace';
const AUDIENCE = 'ispace-platform';

export class SessionService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds = 60 * 60 * 12,
  ) {
    if (secret.length < 32) {
      // 短密钥在 HS256 下会显著削弱签名强度，且这类问题上线后极难发现
      throw new Error('SESSION_SECRET 至少需要 32 个字符');
    }
    this.key = new TextEncoder().encode(secret);
  }

  /**
   * 签发会话。
   *
   * ttlSeconds 可以按次覆盖：有效期是管理员在「平台设置」里配的
   * （platform_policy.session_days），而那是个能随时改的值，
   * 不能在构造服务时定死——定死的话改完设置要重启服务才生效，
   * 而"改了没用"是设置类功能最难查的一种坏法。
   *
   * 令牌的 exp 在签发那一刻就写死了，所以改设置只影响之后的登录，
   * 已经登录的人不受影响。这一点在设置页上有说明。
   */
  async issue(claims: SessionClaims, ttlSeconds = this.ttlSeconds): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<SessionClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return sessionClaimsSchema.parse(payload);
    } catch (e) {
      throw new IspaceError(
        ERROR_CODES.UNAUTHENTICATED,
        '登录状态无效或已过期，请重新登录',
        { reason: e instanceof Error ? e.message : String(e) },
      );
    }
  }

  /** 从 Authorization 头或 cookie 取 token。三个入口的携带方式不同。 */
  extract(headers: {
    authorization?: string | undefined;
    cookie?: string | undefined;
  }): string | null {
    const auth = headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);

    const cookie = headers.cookie;
    if (cookie) {
      for (const part of cookie.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
      }
    }
    return null;
  }
}

export const COOKIE_NAME = 'ispace_session';

/**
 * 会话 cookie。
 *
 * SameSite=Lax 而非 Strict：用户的应用页面（/{user}/{app}/）会加载
 * /platform/shell.js，shell.js 需要读登录态渲染 header。Strict 在从外部
 * 链接跳入时不发送 cookie，会让分享出去的页面上 header 显示未登录。
 *
 * 未设 Secure：内网阶段以 HTTP 运行（规格 §12）。上 HTTPS 时必须补上，
 * 否则 cookie 会在明文链路上暴露。
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure = false): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
