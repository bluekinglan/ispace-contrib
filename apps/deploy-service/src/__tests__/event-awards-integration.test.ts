import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Sql } from '@ispace/db';
import { computeAwards, type EventRow } from '../routes/events.js';

/**
 * 最佳人气奖与一二三等奖互斥（真实 Postgres）。
 *
 * 规则：票王如果已经拿了一二三等奖，人气奖跳过它，在没拿评委奖的作品里
 * 取票数最高的。配置在迁移 0019 的 awardRules 里（人气奖 exclusive: true，
 * 排在一二三等奖之后），结算在 computeAwards。
 *
 * events-integration.test.ts 里原本也有一条覆盖它，但那个文件整体过期了
 * （表清单、截止时间没跟上后来的迁移），这条跟着一起红。颁奖当天才跑
 * 一次的规则，单独钉一份能跑绿的。
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

function parseDsn(dsn: string) {
  const u = new URL(dsn);
  return {
    host: u.hostname, port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), max: 4,
  };
}

describe.skipIf(!DSN)('最佳人气奖与一二三等奖互斥（真实 Postgres）', () => {
  let sql: Sql;
  let ev: EventRow;
  /**
   * 五个入围作品，评委分从高到低：A 90 > B 85 > C 80 > D 75 > E 70。
   * 另有两个没入围的：F 交了作品（参与人气奖），G 没交（不参与）。
   */
  const idea: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', string> = {} as never;
  const voters: string[] = [];

  beforeAll(async () => {
    sql = createDb(parseDsn(DSN!));
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    await runMigrations(sql, MIGRATIONS);

    const mkUser = async (name: string) => {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO ispace.users (sso_subject, username, display_name, role)
        VALUES (${name}, ${name}, ${name}, 'employee') RETURNING id
      `;
      return u!.id;
    };

    [ev] = await sql<EventRow[]>`
      SELECT id, slug, title, subtitle, edition, venue, starts_at, ends_at, phase, config
        FROM ispace.events WHERE slug = ${SLUG}
    `;
    // 前提：迁移里人气奖确实是互斥的、排在评委奖后面。前提不成立就不必往下测
    const rules = ev.config?.awardRules ?? [];
    const pop = rules.findIndex((r) => r.key === 'popular');
    expect(rules[pop]?.exclusive).toBe(true);
    expect(rules.findIndex((r) => r.key === 'third')).toBeLessThan(pop);

    const judges = [await mkUser('judge0'), await mkUser('judge1'), await mkUser('judge2')];
    for (let v = 0; v < 6; v += 1) voters.push(await mkUser(`voter${v}`));

    const totals = { A: 90, B: 85, C: 80, D: 75, E: 70 } as const;
    let no = 1;
    for (const k of ['A', 'B', 'C', 'D', 'E'] as const) {
      const author = await mkUser(`author${k.toLowerCase()}`);
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO ispace.event_ideas (event_id, user_id, name, problem, plan, finalist, finalist_no)
        VALUES (${ev.id}, ${author}, ${`作品${k}`}, 'p', 'p', true, ${String(no++).padStart(2, '0')})
        RETURNING id
      `;
      idea[k] = row!.id;
      for (const j of judges) {
        await sql`
          INSERT INTO ispace.event_scores (event_id, idea_id, judge_id, dims, total, submitted_at)
          VALUES (${ev.id}, ${row!.id}, ${j}, ${sql.json([totals[k], 0, 0, 0])}, ${totals[k]}, now())
        `;
      }
    }

    /* 没入围的两个：评委不给它们打分（打分页只列入围作品） */
    for (const k of ['F', 'G'] as const) {
      const author = await mkUser(`author${k.toLowerCase()}`);
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO ispace.event_ideas (event_id, user_id, name, problem, plan)
        VALUES (${ev.id}, ${author}, ${`作品${k}`}, 'p', 'p')
        RETURNING id
      `;
      idea[k] = row!.id;
    }
    await sql`
      INSERT INTO ispace.event_works (event_id, idea_id, kind, name, files)
      VALUES (${ev.id}, ${idea.F}, 'other', '作品F', ${sql.json([])})
    `;
  });

  afterAll(async () => { await sql?.end({ timeout: 5 }); });
  beforeEach(async () => { await sql`DELETE FROM ispace.event_votes WHERE event_id = ${ev.id}`; });

  /** 给每个作品投指定张数的人气票 */
  const vote = async (counts: Partial<Record<keyof typeof idea, number>>) => {
    for (const [k, n] of Object.entries(counts)) {
      for (let i = 0; i < n!; i += 1) {
        await sql`
          INSERT INTO ispace.event_votes (event_id, idea_id, user_id)
          VALUES (${ev.id}, ${idea[k as keyof typeof idea]}, ${voters[i]!})
        `;
      }
    }
  };
  const winner = async (key: string) =>
    (await computeAwards(sql, ev)).find((a) => a.key === key)?.ideaName;

  it('评委奖按分数：A 一等、B 二等、C 三等', async () => {
    await vote({ A: 1 });
    expect(await winner('first')).toBe('作品A');
    expect(await winner('second')).toBe('作品B');
    expect(await winner('third')).toBe('作品C');
  });

  it('票王是一等奖：人气奖跳过它，给没拿评委奖里票数最高的', async () => {
    await vote({ A: 5, D: 4, B: 3, E: 2, C: 1 });
    expect(await winner('popular')).toBe('作品D');
  });

  it('票王没拿评委奖：人气奖就是它', async () => {
    await vote({ E: 5, A: 4, D: 1 });
    expect(await winner('popular')).toBe('作品E');
  });

  it('票数前三全是一二三等奖：顺延到第四', async () => {
    await vote({ A: 5, B: 4, C: 3, E: 2, D: 1 });
    expect(await winner('popular')).toBe('作品E');
  });

  it('没拿评委奖的里面票数并列：评委分高的那个拿', async () => {
    // D 和 E 都是 2 票；D 评委分 75 高于 E 的 70
    await vote({ A: 5, D: 2, E: 2 });
    expect(await winner('popular')).toBe('作品D');
  });

  it('一个人不会同时拿评委奖和人气奖', async () => {
    await vote({ A: 6, B: 5, C: 4, D: 3, E: 2 });
    const awards = await computeAwards(sql, ev);
    const judged = awards.filter((a) => a.judgeScore != null).map((a) => a.no);
    const pop = awards.find((a) => a.key === 'popular')!;
    expect(judged).not.toContain(pop.no);
  });
  it('没入围但交了作品的票最多：人气奖给它，没有入围编号', async () => {
    await vote({ F: 5, D: 4 });
    const pop = (await computeAwards(sql, ev)).find((a) => a.key === 'popular')!;
    expect(pop.ideaName).toBe('作品F');
    expect(pop.no).toBeNull();
    expect(pop.ideaId).toBe(idea.F);
  });

  it('没入围的拿不到评委奖：它没有分数，一二三等奖照旧', async () => {
    await vote({ F: 6 });
    expect(await winner('first')).toBe('作品A');
    expect(await winner('second')).toBe('作品B');
    expect(await winner('third')).toBe('作品C');
  });

  it('没入围也没交作品的不参与人气奖', async () => {
    // 接口那边投不进去；这里直接写库，确认结算这一层也不认它
    await vote({ G: 5, D: 1 });
    expect(await winner('popular')).toBe('作品D');
  });
});
