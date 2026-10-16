import { describe, expect, it } from 'vitest';
import { SessionService } from '@ispace/auth';
import type { Sql } from '@ispace/db';
import { buildServer } from '../server.js';

/**
 * 改密码之后，之前签出去的会话令牌作废。
 *
 * ┌─ 为什么端到端起整个服务，而不是单测一个比较函数 ──────────────────┐
 * │ 这件事的全部内容就是"鉴权那一步真的会拒"。把比较抽成函数来测，测   │
 * │ 的是我自己写的两行，而真正会出错的是接线——签发时忘了带 epoch、    │
 * │ 比较放在了 status 检查之前、个人访问令牌被误伤。这些都只有走完整  │
 * │ 条 requireAuth 才看得见。                                          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 用假 sql 而不是真库：这里要验的是鉴权的分支，不是 SQL 写得对不对。
 */

const SECRET = 'test-secret-at-least-32-characters-long!!';
const UID = '00000000-0000-4000-8000-000000000001';

/**
 * 把一个标签模板函数伪装成 Sql。
 *
 * 除了查询本身还要补 end()：app.close() 会调它关连接池，不补的话每个用例
 * 都在 finally 里炸，而断言其实已经跑过了——看起来像"全挂"，实则是收尾挂。
 */
function asSql(fn: (parts: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>): Sql {
  return Object.assign(fn, {
    end: async () => undefined,
    json: (v: unknown) => v,
  }) as unknown as Sql;
}

/** 库里那个人的样子。tokenEpoch 由每个用例指定。 */
function fakeSql(tokenEpoch: number, status = 'active'): Sql {
  return asSql(async (parts: TemplateStringsArray) => {
    const q = parts.join('?');
    /*
      认 token_epoch 而不是认 'FROM ispace.users'：findUserForAuth 的表名
      是一个嵌套的 sql 片段，作为**值**插进来，所以不出现在模板字面量里，
      parts 拼出来是 `SELECT ?, u.token_epoch FROM ? WHERE u.id = ?`。
      按表名匹配会一条都对不上，而且表现为"账号不可用"，很难联想到是假
      sql 没匹配上。
    */
    if (q.includes('token_epoch') || q.includes('FROM ispace.users')) {
      return [{
        id: UID, sso_subject: 'sso', username: 'lixiao', display_name: '李骁',
        email: 'lixiao@example.com', role: 'employee', identity: 'developer',
        status, created_at: new Date(), archived_at: null,
        avatar_etag: null, token_epoch: tokenEpoch,
      }];
    }
    if (q.includes('FROM ispace.quotas')) {
      return [{
        user_id: UID, storage_bytes_used: '0', storage_bytes_limit: '0',
        db_rows_used: 0, db_rows_limit: 0, app_count: 0, app_limit: 0,
      }];
    }
    return [];
  });
}

/**
 * 用真的 SessionService 签，而不是自己拼一个 JWT：签发那一侧也在被测的
 * 范围里——epoch 没被写进 claims 的话，这里就该跟着失败。
 */
async function token(epoch: number | undefined): Promise<string> {
  const base = {
    uid: UID, username: 'lixiao', role: 'employee', identity: 'developer',
  } as const;
  return new SessionService(SECRET).issue(
    epoch === undefined ? base : { ...base, epoch },
  );
}

async function hit(tokenEpoch: number, claimEpoch: number | undefined, status?: string) {
  process.env.SESSION_SECRET = SECRET;
  process.env.LOG_LEVEL = 'silent';
  const app = await buildServer({ sql: fakeSql(tokenEpoch, status), skipMigrations: true });
  try {
    return await app.inject({
      url: '/deploy/api/me',
      headers: { authorization: `Bearer ${await token(claimEpoch)}` },
    });
  } finally {
    await app.close();
  }
}

describe('会话令牌的世代号', () => {
  it('世代号一致就放行', async () => {
    expect((await hit(3, 3)).statusCode).toBe(200);
  });

  it('令牌比库里旧就拒——这是"改密码踢下线"的全部实现', async () => {
    const res = await hit(4, 3);
    expect(res.statusCode).toBe(401);
    // 文案要指向"重新登录"，而不是笼统的账号不可用：这两种情况下
    // 用户该做的事完全不同（一个重新登录就好，一个得去找管理员）
    expect(res.json().message).toContain('重新登录');
  });

  it('令牌比库里新也拒，不只拒旧的', async () => {
    // 正常流程产生不了这种令牌，真出现了说明库被回滚过或令牌被伪造，
    // 两种都不该放行。写成 `claim < db` 就会在这里漏掉。
    expect((await hit(1, 5)).statusCode).toBe(401);
  });

  it('不带 epoch 的旧令牌按第 0 代算：库里还是 0 就放行', async () => {
    // 上线那一刻在用的令牌都不带 epoch。它们应该继续用到自然过期，
    // 而不是让全公司在部署那一秒一起掉线。
    expect((await hit(0, undefined)).statusCode).toBe(200);
  });

  it('不带 epoch 的旧令牌，库里已经 +1 过就拒', async () => {
    // 也就是说：上线后第一次改密码，照样能把上线前签的令牌踢掉。
    expect((await hit(1, undefined)).statusCode).toBe(401);
  });

  it('世代号对，但账号被归档了，仍然拒', async () => {
    // 顺序不能反：先放行了再看状态，等于归档用户还能摸一下接口。
    expect((await hit(2, 2, 'archived')).statusCode).toBe(401);
  });
});

describe('个人访问令牌（isp_）不受影响', () => {
  /*
    那套是给 CI 和 MCP 用的，本来就能在控制台逐个撤销，和密码没有关系。
    改个密码把同事 CI 里的令牌一起弄失效，既不是他要的，也会让人完全
    摸不着头脑——所以 requireAuth 里只对会话令牌比世代号。
  */
  it('库里世代号涨了，isp_ 令牌照常工作', async () => {
    process.env.SESSION_SECRET = SECRET;
    process.env.LOG_LEVEL = 'silent';
    const base = fakeSql(9) as unknown as (
      p: TemplateStringsArray, ...v: unknown[]
    ) => Promise<unknown[]>;
    const sql = asSql(async (parts: TemplateStringsArray) => {
      // 访问令牌查表：命中就当这个令牌有效
      if (parts.join('?').includes('FROM ispace.access_tokens')) {
        return [{ user_id: UID, id: 'tok' }];
      }
      return base(parts);
    });

    const app = await buildServer({ sql, skipMigrations: true });
    try {
      const res = await app.inject({
        url: '/deploy/api/me',
        headers: { authorization: 'Bearer isp_whatever' },
      });
      // 世代号是 9，而这条路根本不带 epoch——不该因此被拒
      expect(res.statusCode).not.toBe(401);
    } finally {
      await app.close();
    }
  });
});
