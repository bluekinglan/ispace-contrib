import type { FastifyRequest } from 'fastify';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { findUserForAuth, type Sql } from '@ispace/db';
import type { PreviewSessions } from './preview-session.js';

/**
 * 预览取数的身份解析（方案 §5.2）。
 *
 * ┌─ 这个函数存在的全部意义：**只认 Bearer，一眼都不看 cookie** ────────┐
 * │ 预览取数端点要为 opaque origin 开 CORS（沙箱页面的 Origin 是 null）。│
 * │ 而 `Origin: null` 不是"我们的预览"的标识——任何网站开一个沙箱 iframe │
 * │ 都能发出这样的请求。所以这条路上一旦还认 cookie，就等于把用户的平台 │
 * │ 会话交给了任意外站。                                                 │
 * │                                                                      │
 * │ 它和平台的 requireAuth 是两套**不相交**的凭据：                      │
 * │   - 预览令牌不是 JWT 也不是 isp_ 开头的访问令牌，拿去 requireAuth    │
 * │     会验签失败（401）——所以它偷不了正门。                           │
 * │   - 会话 JWT 不在预览令牌表里，拿到这里也查不到（401）——所以正门的  │
 * │     凭据也开不了这扇侧门。                                           │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 仍然每次查库：令牌签发后这个人可能已被停用。和 requireAuth 的理由一样
 * ——无状态令牌的即时冻结只能靠这一次查询。
 */
export function makePreviewAuth(
  sessions: PreviewSessions,
  sql: Sql,
): (req: FastifyRequest) => Promise<User> {
  return async (req) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && /^Bearer\s+/i.test(header)
      ? header.replace(/^Bearer\s+/i, '').trim()
      : '';
    const s = token ? sessions.byAccessToken(token) : null;
    if (!s) {
      throw new IspaceError(
        ERROR_CODES.UNAUTHENTICATED,
        '预览取数令牌无效或已过期。刷新创建页重开一个预览即可。',
      );
    }
    sessions.touch(s);

    const found = await findUserForAuth(sql, s.userId);
    if (!found || found.user.status !== 'active') {
      throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '账号不可用');
    }
    return found.user;
  };
}
