import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Sql } from '@ispace/db';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerEventRoutes } from '../routes/events.js';

/**
 * 没入围的创意也能交作品、参与最佳人气奖（真实 Postgres，走接口）。
 *
 * 组织者 10.19 晚改的规则：初筛只取 8 个，其余人照样可以把东西做出来交上
 * 来——不路演、评委不打分、没有入围奖，只和入围作品一起竞逐人气奖。
 *
 * 结算那一层（computeAwards 认不认它们）在 event-awards-integration 里；
 * 这里钉接口：交得进去、对外列得出来、投得进去，而没交作品的依旧投不了。
 *
 *   ISPACE_TEST_PG='postgres://postgres:pgtest@127.0.0.1:55432/postgres' \
 *     pnpm --filter @ispace/deploy-service test
 *
 * ⚠️ 它会 DROP SCHEMA ispace CASCADE。只指向一次性的测试库，别指生产。
 */

const DSN = process.env.ISPACE_TEST_PG;
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../../../packages/db/migrations');
const SLUG = '1024-2026';
const AS = (username: string) => ({ 'x-test-user': username });

function parseDsn(dsn: string) {
  const u = new URL(dsn);
  return {
    host: u.hostname, port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), max: 4,
  };
}

describe.skipIf(!DSN)('没入围也能交作品、参与人气奖（真实 Postgres）', () => {
  let sql: Sql;
  let app: ReturnType<typeof Fastify>;
  const users = new Map<string, User>();
  /** fin 入围；open 没入围、会交作品；idle 没入围、不交 */
  const idea: Record<'fin' | 'open' | 'idle', string> = {} as never;

  const findUser = (req: FastifyRequest): User | null => {
    const name = req.headers['x-test-user'] as string | undefined;
    return name ? users.get(name) ?? null : null;
  };
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/deploy/api${url}`, headers });
  const send = (method: 'PUT' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/deploy/api${url}`, headers, ...(payload === undefined ? {} : { payload }) });

  beforeAll(async () => {
    sql = createDb(parseDsn(DSN!));
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    await runMigrations(sql, MIGRATIONS);

    for (const [username, role] of [
      ['admin', 'admin'], ['authorfin', 'employee'], ['authoropen', 'employee'],
      ['authoridle', 'employee'], ['voter', 'employee'],
    ] as const) {
      const rows = await sql<User[]>`
        INSERT INTO ispace.users (sso_subject, username, display_name, role)
        VALUES (${username}, ${username}, ${username}, ${role})
        RETURNING id, username, display_name AS "displayName", role, status
      `;
      users.set(username, rows[0]!);
    }
    const [ev] = await sql<{ id: string }[]>`SELECT id FROM ispace.events WHERE slug = ${SLUG}`;
    for (const k of ['fin', 'open', 'idle'] as const) {
      const fin = k === 'fin';
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO ispace.event_ideas (event_id, user_id, name, problem, plan, finalist, finalist_no)
        VALUES (${ev!.id}, ${users.get(`author${k}`)!.id}, ${`创意${k}`}, 'p', 'p',
                ${fin}, ${fin ? '01' : null})
        RETURNING id
      `;
      idea[k] = row!.id;
    }

    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const maybe = err as { validation?: unknown; issues?: unknown; message?: string };
      if (maybe.validation || maybe.issues) {
        return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT, message: maybe.message ?? '入参不合法' });
      }
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerEventRoutes(app, {
      sql,
      requireAuth: async (req) => {
        const u = findUser(req);
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return u;
      },
      optionalAuth: async (req) => findUser(req),
      requireAdmin: async (req) => {
        const u = findUser(req);
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        if (u.role !== 'admin') throw new IspaceError(ERROR_CODES.FORBIDDEN, '需要管理员权限');
        return u;
      },
      filesRoot: '/tmp/ispace-test-event-files',
    });
    await app.ready();

    /*
      钉在入围制作阶段，交作品截止挪到明天、投票窗口开着——种子里是本届
      真实日期，不挪的话测试跑在哪天就决定了它红不红。
    */
    const cur = (await get(`/events/${SLUG}`)).json() as { event: { config: Record<string, unknown> } };
    const now = Date.now();
    const config = {
      ...cur.event.config,
      deadlines: {
        ...(cur.event.config.deadlines as Record<string, string>),
        work: new Date(now + 24 * 3600_000).toISOString(),
        voteOpen: new Date(now - 30 * 60_000).toISOString(),
        vote: new Date(now + 30 * 60_000).toISOString(),
      },
    };
    expect((await send('PATCH', `/events/${SLUG}`, { config, phase: 'building' }, AS('admin'))).statusCode).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
  });

  it('没入围的能交作品', async () => {
    const r = await send('PUT', `/events/${SLUG}/work`, {
      kind: 'other', name: '没入围也做完了', files: [{ name: 'p.jpg', size: 100, url: '/x' }],
    }, AS('authoropen'));
    expect(r.statusCode, r.body).toBe(200);
  });

  it('对外：它在 openWorks 里，不在入围名单里，也不算进「入围交了几件」', async () => {
    const pub = (await get(`/events/${SLUG}`)).json();
    expect(pub.finalists.map((f: { ideaId: string }) => f.ideaId)).toEqual([idea.fin]);
    expect(pub.openWorks).toHaveLength(1);
    expect(pub.openWorks[0]).toMatchObject({ ideaId: idea.open, name: '没入围也做完了' });
    expect(pub.openWorks[0]).not.toHaveProperty('no');
    // 入围的那个还没交，进度条是 0/1，不能被没入围的作品顶成 1/1
    expect(pub.stats.workCount).toBe(0);
  });

  it('没入围也没交作品的，依旧不公开', async () => {
    const pub = (await get(`/events/${SLUG}`)).json();
    const all = [...pub.finalists, ...pub.openWorks].map((f: { ideaId: string }) => f.ideaId);
    expect(all).not.toContain(idea.idle);
  });

  it('交了作品的能被投，没交的投不了', async () => {
    const ok = await send('POST', `/events/${SLUG}/votes/${idea.open}`, undefined, AS('voter'));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().voted).toBe(true);

    const no = await send('POST', `/events/${SLUG}/votes/${idea.idle}`, undefined, AS('voter'));
    expect(no.statusCode).toBe(404);
  });

  it('作者自己的状态：没入围、作品已交', async () => {
    const me = (await get(`/events/${SLUG}`, AS('authoropen'))).json().me;
    expect(me.idea.finalist).toBe(false);
    expect(me.work.name).toBe('没入围也做完了');
  });
});
