import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Sql } from '@ispace/db';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerSocialRoutes } from '../routes/social.js';

/**
 * 社交面（喜欢、评论、关注、动态、兴趣）走真实 Postgres + 真实接口。
 *
 * 这一组要钉的是**可见性与幂等**，不是「能插进去」：
 *   - 看不见的页面不能喜欢、不能评论，而且回 404 不回 403
 *     （403 等于告诉对方这个 id 存在，这些接口能被拿着 id 遍历）
 *   - 连点两次心不会变成 2，取消两次不会变成 -1
 *   - 计数列（apps.like_count/comment_count）与明细表始终一致
 *   - 「关注」feed 只给我关注的人，不含自己
 *   - 只能附自己的页面发帖
 *
 *   ISPACE_TEST_PG='postgres://postgres:pgtest@127.0.0.1:55432/postgres' \
 *     pnpm --filter @ispace/deploy-service test
 *
 * ⚠️ 它会 DROP SCHEMA ispace CASCADE。只指向一次性的测试库，别指生产。
 */

const DSN = process.env.ISPACE_TEST_PG;
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../../../packages/db/migrations');
const AS = (username: string) => ({ 'x-test-user': username });

function parseDsn(dsn: string) {
  const u = new URL(dsn);
  return {
    host: u.hostname, port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), max: 4,
  };
}

describe.skipIf(!DSN)('喜欢 / 评论 / 关注 / 动态（真实 Postgres）', () => {
  let sql: Sql;
  let app: ReturnType<typeof Fastify>;
  const users = new Map<string, User>();
  /** pub 全公司可见；priv 仅作者自己；shd 定向分享给 fan */
  const appIds: Record<'pub' | 'priv' | 'shd', string> = {} as never;

  const findUser = (req: FastifyRequest): User | null => {
    const name = req.headers['x-test-user'] as string | undefined;
    return name ? users.get(name) ?? null : null;
  };
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/deploy/api${url}`, headers });
  const send = (
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method, url: `/deploy/api${url}`, headers,
      ...(payload === undefined ? {} : { payload }),
    });

  const counts = async (id: string) =>
    (await sql<{ like_count: number; comment_count: number }[]>`
      SELECT like_count, comment_count FROM ispace.apps WHERE id = ${id}
    `)[0]!;

  beforeAll(async () => {
    sql = createDb(parseDsn(DSN!));
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    await runMigrations(sql, MIGRATIONS);

    for (const [username, role] of [
      ['author', 'employee'], ['fan', 'employee'], ['stranger', 'employee'], ['boss', 'admin'],
    ] as const) {
      const rows = await sql<User[]>`
        INSERT INTO ispace.users (sso_subject, username, display_name, role)
        VALUES (${username}, ${username}, ${username}, ${role})
        RETURNING id, username, display_name AS "displayName", role, status
      `;
      users.set(username, rows[0]!);
    }

    const mk = async (slug: string, visibility: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO ispace.apps (owner_id, slug, name, icon_letter, status, visibility, category)
        VALUES (${users.get('author')!.id}, ${slug}, ${slug}, '排', 'running', ${visibility},
                '团队协作')
        RETURNING id
      `;
      return row!.id;
    };
    appIds.pub = await mk('paiban', 'public');
    appIds.priv = await mk('peixun', 'private');
    appIds.shd = await mk('baifang', 'shared');
    await sql`
      INSERT INTO ispace.shares (app_id, from_user_id, to_user_id, status)
      VALUES (${appIds.shd}, ${users.get('author')!.id}, ${users.get('fan')!.id}, 'accepted')
    `;
    await sql`
      INSERT INTO ispace.marketplace_listings (app_id, published_by)
      VALUES (${appIds.pub}, ${users.get('author')!.id})
    `;

    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const maybe = err as { validation?: unknown; issues?: unknown; message?: string };
      if (maybe.validation || maybe.issues) {
        return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT, message: maybe.message ?? '入参不合法' });
      }
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerSocialRoutes(app, {
      sql,
      requireAuth: async (req) => {
        const u = findUser(req);
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return u;
      },
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
  });

  // ── 喜欢 ──────────────────────────────────────────────────────────
  it('连点两次心只算一次，取消两次也不会变成负数', async () => {
    const one = await send('POST', `/apps/${appIds.pub}/like`, undefined, AS('fan'));
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ liked: true, likeCount: 1 });

    const again = await send('POST', `/apps/${appIds.pub}/like`, undefined, AS('fan'));
    expect(again.json()).toMatchObject({ liked: true, likeCount: 1 });
    expect((await counts(appIds.pub)).like_count).toBe(1);

    expect((await send('DELETE', `/apps/${appIds.pub}/like`, undefined, AS('fan'))).json())
      .toMatchObject({ liked: false, likeCount: 0 });
    expect((await send('DELETE', `/apps/${appIds.pub}/like`, undefined, AS('fan'))).json())
      .toMatchObject({ liked: false, likeCount: 0 });
    expect((await counts(appIds.pub)).like_count).toBe(0);
  });

  it('看不见的页面喜欢不了，而且回 404 不回 403', async () => {
    const r = await send('POST', `/apps/${appIds.priv}/like`, undefined, AS('stranger'));
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('定向分享给我的页面，我能喜欢；没分享到的人不能', async () => {
    expect((await send('POST', `/apps/${appIds.shd}/like`, undefined, AS('fan'))).statusCode).toBe(200);
    expect((await send('POST', `/apps/${appIds.shd}/like`, undefined, AS('stranger'))).statusCode).toBe(404);
  });

  // ── 评论 ──────────────────────────────────────────────────────────
  it('评论能写能读，计数跟着明细走', async () => {
    const posted = await send('POST', `/apps/${appIds.pub}/comments`, { body: '换班要两边点头这个太实用了' }, AS('fan'));
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toMatchObject({ commentCount: 1 });
    expect(posted.json().comment).toMatchObject({ mine: true, author: { username: 'fan' } });

    const list = await get(`/apps/${appIds.pub}/comments`, AS('stranger'));
    expect(list.json().comments).toHaveLength(1);
    // 别人的评论上不该出现「删除」入口
    expect(list.json().comments[0].mine).toBe(false);
    expect((await counts(appIds.pub)).comment_count).toBe(1);
  });

  it('空白评论被挡在库外', async () => {
    const r = await send('POST', `/apps/${appIds.pub}/comments`, { body: '   ' }, AS('fan'));
    expect(r.statusCode).toBe(422);
  });

  it('页面作者能删自己页面下别人的评论，路人不能', async () => {
    const posted = await send('POST', `/apps/${appIds.pub}/comments`, { body: '这条会被作者删掉' }, AS('fan'));
    const id = posted.json().comment.id as string;

    expect((await send('DELETE', `/comments/${id}`, undefined, AS('stranger'))).statusCode).toBe(403);
    const gone = await send('DELETE', `/comments/${id}`, undefined, AS('author'));
    expect(gone.statusCode).toBe(200);
    expect(gone.json().commentCount).toBe(1);
  });

  it('评论能点赞，点两次只算一次；热门按赞数排在前', async () => {
    const hot = await send('POST', `/apps/${appIds.pub}/comments`, { body: '这条会被点赞' }, AS('author'));
    const id = hot.json().comment.id as string;
    expect(hot.json().comment).toMatchObject({ likeCount: 0, liked: false });

    expect((await send('POST', `/comments/${id}/like`, undefined, AS('fan'))).json())
      .toMatchObject({ liked: true, likeCount: 1 });
    expect((await send('POST', `/comments/${id}/like`, undefined, AS('fan'))).json())
      .toMatchObject({ liked: true, likeCount: 1 });

    const byHot = await get(`/apps/${appIds.pub}/comments?sort=hot`, AS('fan'));
    expect(byHot.json().comments[0]).toMatchObject({ id, likeCount: 1, liked: true });

    // 最新那一栏仍按时间，刚写的这条也恰好排第一
    const byNew = await get(`/apps/${appIds.pub}/comments?sort=new`, AS('stranger'));
    expect(byNew.json().comments[0].id).toBe(id);
    expect(byNew.json().comments[0].liked).toBe(false);

    expect((await send('DELETE', `/comments/${id}/like`, undefined, AS('fan'))).json())
      .toMatchObject({ liked: false, likeCount: 0 });
  });

  it('看不见的页面下的评论也点不了赞', async () => {
    const mine = await send('POST', `/apps/${appIds.priv}/comments`, { body: '自己页面下的' }, AS('author'));
    const id = mine.json().comment.id as string;
    expect((await send('POST', `/comments/${id}/like`, undefined, AS('stranger'))).statusCode).toBe(404);
  });

  // ── 关注与作者主页 ────────────────────────────────────────────────
  it('作者主页只列公开作品，关注数跟着关注走', async () => {
    const before = await get('/authors/author', AS('fan'));
    expect(before.statusCode).toBe(200);
    expect(before.json().apps).toHaveLength(1);
    expect(before.json().apps[0].slug).toBe('paiban');
    /*
      列名要和 /marketplace 对得上——作者页和探索页是同一张卡片组件。
      少过一次 app_id，整屏白屏（卡片按它取底色）。
    */
    expect(before.json().apps[0]).toMatchObject({
      app_id: appIds.pub, owner_username: 'author', liked: false, mine: false,
    });
    expect(before.json().apps[0].id).not.toBe(appIds.pub);
    expect(before.json().profile).toMatchObject({ self: false, following: false });
    expect(before.json().profile.stats).toMatchObject({ publicApps: 1, followers: 0 });

    expect((await send('POST', '/authors/author/follow', undefined, AS('fan'))).json())
      .toMatchObject({ following: true });
    // 重复关注不该把粉丝数刷成 2
    await send('POST', '/authors/author/follow', undefined, AS('fan'));

    const after = await get('/authors/author', AS('fan'));
    expect(after.json().profile).toMatchObject({ following: true });
    expect(after.json().profile.stats.followers).toBe(1);

    const own = await get('/authors/author', AS('author'));
    expect(own.json().profile.self).toBe(true);
  });

  it('关注不了自己', async () => {
    const r = await send('POST', '/authors/author/follow', undefined, AS('author'));
    expect(r.statusCode).toBe(422);
  });

  // ── 动态 ──────────────────────────────────────────────────────────
  it('发帖只能附自己的页面', async () => {
    const mine = await send('POST', '/posts', { body: '排班终于不用在群里吵了', appId: appIds.pub }, AS('author'));
    expect(mine.statusCode).toBe(200);

    const theirs = await send('POST', '/posts', { body: '替他宣传一下', appId: appIds.pub }, AS('fan'));
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().code).toBe(ERROR_CODES.NOT_OWNER);
  });

  it('「关注」feed 只给我关注的人，不含自己', async () => {
    await send('POST', '/posts', { body: '我自己发的一条' }, AS('fan'));

    const rec = await get('/posts?feed=recommend', AS('fan'));
    expect(rec.json().posts.length).toBeGreaterThanOrEqual(2);

    // fan 在上面已经关注了 author，所以这里应当只剩 author 那条
    const fol = await get('/posts?feed=following', AS('fan'));
    expect(fol.json().posts.map((p: { author: { username: string } }) => p.author.username))
      .toEqual(['author']);
    expect(fol.json().posts[0].app).toMatchObject({ slug: 'paiban', owner: 'author' });
  });

  it('动态的喜欢与评论计数物化在 posts 上', async () => {
    const created = await send('POST', '/posts', { body: '来数一下' }, AS('author'));
    const id = created.json().id as string;

    expect((await send('POST', `/posts/${id}/like`, undefined, AS('fan'))).json())
      .toMatchObject({ liked: true, likeCount: 1 });
    expect((await send('POST', `/posts/${id}/comments`, { body: '+1' }, AS('fan'))).json())
      .toMatchObject({ commentCount: 1 });

    const [row] = await sql<{ like_count: number; comment_count: number }[]>`
      SELECT like_count, comment_count FROM ispace.posts WHERE id = ${id}
    `;
    expect(row).toMatchObject({ like_count: 1, comment_count: 1 });

    // 作者删帖，附带的喜欢与评论随之级联掉，不留孤儿
    expect((await send('DELETE', `/posts/${id}`, undefined, AS('author'))).statusCode).toBe(200);
    expect(await sql`SELECT 1 FROM ispace.post_likes WHERE post_id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM ispace.post_comments WHERE post_id = ${id}`).toHaveLength(0);
  });

  it('删不了别人的帖', async () => {
    const created = await send('POST', '/posts', { body: '别动我' }, AS('author'));
    const id = created.json().id as string;
    expect((await send('DELETE', `/posts/${id}`, undefined, AS('fan'))).statusCode).toBe(404);
    // 管理员可以
    expect((await send('DELETE', `/posts/${id}`, undefined, AS('boss'))).statusCode).toBe(200);
  });

  // ── 兴趣 ──────────────────────────────────────────────────────────
  it('兴趣最多三个，重复提交结果一样', async () => {
    const ok = await send('PUT', '/me/interests', { interests: ['工作提效', '团队协作'] }, AS('fan'));
    expect(ok.json().interests).toEqual(['工作提效', '团队协作']);
    await send('PUT', '/me/interests', { interests: ['工作提效', '团队协作'] }, AS('fan'));
    const [row] = await sql<{ interests: string[] }[]>`
      SELECT interests FROM ispace.users WHERE id = ${users.get('fan')!.id}
    `;
    expect(row!.interests).toEqual(['工作提效', '团队协作']);

    const tooMany = await send(
      'PUT', '/me/interests',
      { interests: ['工作提效', '团队协作', '生活', '学习'] }, AS('fan'),
    );
    expect(tooMany.statusCode).toBe(422);

    // 不在分类表里的词不收——它会被探索页的分类条永远筛不到
    expect((await send('PUT', '/me/interests', { interests: ['摸鱼'] }, AS('fan'))).statusCode).toBe(422);
  });
});
