import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Sql } from '@ispace/db';
import { applyAutoFinalists } from '../services/event-finalists.js';

/**
 * 20:00 自动定入围名单（真实 Postgres）。
 *
 * 这件事一年只跑一次，跑的那一下就是名单本身——写错了没有补救的机会，所以
 * 写库那一段（抢标记、不覆盖人工名单、同票装不下就不写）在真库上钉住。
 * 排名规则本身另有 screening-rank.test.ts。
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
const SHUT = '2026-10-19T20:00:00+08:00';
const BEFORE = new Date('2026-10-19T19:59:00+08:00');
const AFTER = new Date('2026-10-19T20:00:30+08:00');

function parseDsn(dsn: string) {
  const u = new URL(dsn);
  return {
    host: u.hostname, port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), max: 4,
  };
}

describe.skipIf(!DSN)('自动定入围名单（真实 Postgres）', () => {
  let sql: Sql;
  let eventId: string;
  let judges: string[] = [];

  beforeAll(async () => {
    sql = createDb(parseDsn(DSN!));
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    await runMigrations(sql, MIGRATIONS);
    const [ev] = await sql<{ id: string }[]>`SELECT id FROM ispace.events WHERE slug = ${SLUG}`;
    eventId = ev!.id;
    judges = [];
    for (let j = 0; j < 8; j += 1) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO ispace.users (sso_subject, username, display_name, role)
        VALUES (${`judge${j}`}, ${`judge${j}`}, ${`评委${j}`}, 'employee') RETURNING id
      `;
      judges.push(u!.id);
    }
  });

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  /** 每个用例从干净状态开始：清创意、清标记、名额 8、截止 20:00 */
  beforeEach(async () => {
    await sql`DELETE FROM ispace.event_ideas WHERE event_id = ${eventId}`;
    await sql`DELETE FROM ispace.users WHERE username LIKE 'author%'`;
    await sql`
      UPDATE ispace.events
         SET config = (config - 'finalistsAutoAt')
                      || jsonb_build_object('screeningSlots', 8)
                      || jsonb_build_object('deadlines',
                           coalesce(config->'deadlines', '{}'::jsonb)
                           || jsonb_build_object('screeningVote', ${SHUT}::text))
       WHERE id = ${eventId}
    `;
  });

  /** 按给定票数造创意：votes[i] 是第 i 个创意得几票，提交时间按 i 先后 */
  const seed = async (votes: number[]): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < votes.length; i += 1) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO ispace.users (sso_subject, username, display_name, role)
        VALUES (${`author${i}`}, ${`author${i}`}, ${`作者${i}`}, 'employee') RETURNING id
      `;
      const [idea] = await sql<{ id: string }[]>`
        INSERT INTO ispace.event_ideas (event_id, user_id, name, problem, plan, created_at)
        VALUES (${eventId}, ${u!.id}, ${`创意${i}`}, 'p', 'p',
                ${new Date(Date.UTC(2026, 9, 18, 0, i))})
        RETURNING id
      `;
      for (let j = 0; j < votes[i]!; j += 1) {
        await sql`
          INSERT INTO ispace.event_screening_votes (event_id, idea_id, judge_id)
          VALUES (${eventId}, ${idea!.id}, ${judges[j]!})
        `;
      }
      ids.push(idea!.id);
    }
    return ids;
  };

  const finalists = () => sql<{ id: string; no: string }[]>`
    SELECT id, finalist_no AS no FROM ispace.event_ideas
     WHERE event_id = ${eventId} AND finalist ORDER BY finalist_no
  `;

  it('没到 20:00 什么都不做', async () => {
    await seed([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(await applyAutoFinalists(sql, SLUG, BEFORE)).toEqual({ done: false, reason: 'not-yet' });
    expect(await finalists()).toHaveLength(0);
  });

  it('到点后写入前 8，编号按名次 01–08', async () => {
    const ids = await seed([1, 8, 7, 6, 5, 4, 3, 2, 0]); // 第 0 个只有 1 票，排第 8
    const r = await applyAutoFinalists(sql, SLUG, AFTER);
    expect(r).toEqual({ done: true, written: 8, tie: false });
    const f = await finalists();
    expect(f.map((x) => x.no)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    // 01 是 8 票的那个，08 是 1 票的那个；0 票的出局
    expect(f[0]!.id).toBe(ids[1]);
    expect(f[7]!.id).toBe(ids[0]);
    expect(f.some((x) => x.id === ids[8])).toBe(false);
  });

  it('只跑一次：跑过之后再触发不会改名单', async () => {
    await seed([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    await applyAutoFinalists(sql, SLUG, AFTER);
    // 组织者在控制台把 08 去掉了
    await sql`
      UPDATE ispace.event_ideas SET finalist = false, finalist_no = NULL
       WHERE event_id = ${eventId} AND finalist_no = '08'
    `;
    expect(await applyAutoFinalists(sql, SLUG, AFTER)).toEqual({ done: false, reason: 'already' });
    expect(await finalists()).toHaveLength(7);
  });

  it('两个并列第 8：扩到 9 个', async () => {
    await seed([8, 7, 6, 5, 4, 3, 2, 1, 1, 0]);
    expect(await applyAutoFinalists(sql, SLUG, AFTER)).toEqual({ done: true, written: 9, tie: false });
    expect((await finalists()).map((x) => x.no).at(-1)).toBe('09');
  });

  it('三个并列第 8：扩到 9 个也装不下，一个都不写，留给人定', async () => {
    await seed([8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 0]);
    expect(await applyAutoFinalists(sql, SLUG, AFTER)).toEqual({
      done: true, written: 0, tie: true, pending: 3,
    });
    expect(await finalists()).toHaveLength(0);
    // 标记已打：不会每 30 秒再算一遍、在日志里刷屏
    expect(await applyAutoFinalists(sql, SLUG, AFTER)).toEqual({ done: false, reason: 'already' });
  });

  it('到点时全员零票：不会把 17 个全判进去', async () => {
    await seed(Array(17).fill(0));
    const r = await applyAutoFinalists(sql, SLUG, AFTER);
    expect(r).toMatchObject({ done: true, written: 0, tie: true });
    expect(await finalists()).toHaveLength(0);
  });

  it('到点前已经有人工设定的入围：原样保留', async () => {
    const ids = await seed([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    await sql`
      UPDATE ispace.event_ideas SET finalist = true, finalist_no = '01'
       WHERE id = ${ids[8]!}
    `;
    expect(await applyAutoFinalists(sql, SLUG, AFTER)).toEqual({ done: true, kept: 1 });
    const f = await finalists();
    expect(f).toHaveLength(1);
    expect(f[0]!.id).toBe(ids[8]);
  });

  it('两处同时触发也只写一次', async () => {
    await seed([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const [a, b] = await Promise.all([
      applyAutoFinalists(sql, SLUG, AFTER),
      applyAutoFinalists(sql, SLUG, AFTER),
    ]);
    const written = [a, b].filter((r) => r.done && 'written' in r && r.written === 8);
    expect(written).toHaveLength(1);
    expect(await finalists()).toHaveLength(8);
  });
});
