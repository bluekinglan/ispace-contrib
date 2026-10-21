import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Sql } from '@ispace/db';
import type { EngineMessage } from '@ispace/agent';
import {
  MemoryAgentStore, PgAgentStore, stripImages, type AgentStore,
} from '../services/agent-store.js';

/**
 * 会话落库。同一组用例跑两遍：内存实现（路由测试用它）与 Postgres 实现
 * （线上用它）——两边说法不一致，测试里绿的东西上线就是另一回事。
 *
 *   ISPACE_TEST_PG='postgres://postgres:pgtest@127.0.0.1:55432/postgres' \
 *     pnpm --filter @ispace/deploy-service test
 *
 * ⚠️ Postgres 那一组会 DROP SCHEMA ispace CASCADE。只指向一次性的测试库。
 */

const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const withImage: EngineMessage[] = [
  { role: 'user', content: '照这张图做', images: [{ mimeType: 'image/png', dataBase64: 'A'.repeat(1000) }] },
  { role: 'assistant', content: '好', toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'index.html', content: '<h1>' } }] },
  { role: 'tool', content: '已写入', toolCallId: 'c1' },
];

function contract(name: string, make: () => Promise<AgentStore>, tick: () => Promise<void>) {
  describe(name, () => {
    it('建、读、存消息；存的时候图片字节去掉、留一句话', async () => {
      const s = await make();
      await s.create({ id: sid(1), userId: U1, workspace: sid(1) });
      await s.save(sid(1), { messages: withImage });
      const got = (await s.get(sid(1)))!;
      expect(got.workspace).toBe(sid(1));
      expect(got.slug).toBeNull();
      expect(got.messages).toHaveLength(3);
      expect(got.messages[0]!.images).toBeUndefined();
      expect(got.messages[0]!.content).toContain('原本附了 1 张图');
      expect(got.messages[1]!.toolCalls?.[0]?.arguments).toEqual({ path: 'index.html', content: '<h1>' });
      expect(await s.get(sid(99))).toBeNull();
    });

    it('只给部分字段时其余不动', async () => {
      const s = await make();
      await s.create({ id: sid(2), userId: U1, workspace: 'legacy' });
      await s.save(sid(2), { messages: [{ role: 'user', content: 'hi' }] });
      await s.save(sid(2), { slug: 'zhoubao' });
      const got = (await s.get(sid(2)))!;
      expect(got.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(got.slug).toBe('zhoubao');
      expect(got.workspace).toBe('legacy');
    });

    it('按页面找工作区取最近那条，且只在本人名下找', async () => {
      const s = await make();
      await s.create({ id: sid(3), userId: U1, workspace: 'w-old', slug: 'zhoubao' });
      await tick();
      await s.create({ id: sid(4), userId: U1, workspace: 'w-new', slug: 'zhoubao' });
      await s.create({ id: sid(5), userId: U2, workspace: 'w-other', slug: 'zhoubao' });
      expect(await s.workspaceForSlug(U1, 'zhoubao')).toBe('w-new');
      expect(await s.workspaceForSlug(U2, 'zhoubao')).toBe('w-other');
      expect(await s.workspaceForSlug(U1, 'nope')).toBeNull();
      await tick();
      await s.save(sid(3), { messages: [] }); // 碰一下旧的，它就成了最近的
      expect(await s.workspaceForSlug(U1, 'zhoubao')).toBe('w-old');
      expect(await s.latestWorkspace(U1)).toBe('w-old');
    });

    it('会话列表：只列本人、说过话的，新的在前，带第一句话', async () => {
      const s = await make();
      await s.create({ id: sid(30), userId: U2, workspace: 'empty' }); // 一句话没说
      await tick();
      await s.create({ id: sid(31), userId: U2, workspace: 'a' });
      await s.save(sid(31), { messages: [{ role: 'user', content: '做个排班表' }, { role: 'assistant', content: '好' }] });
      await tick();
      await s.create({ id: sid(32), userId: U2, workspace: 'b' });
      await s.save(sid(32), { messages: [{ role: 'user', content: '午饭吃什么' }] });
      const list = await s.listForUser(U2, 10);
      expect(list.map((r) => [r.id, r.first])).toEqual([[sid(32), '午饭吃什么'], [sid(31), '做个排班表']]);
      expect(await s.listForUser(U2, 1)).toHaveLength(1);
    });
  });
}

/** 内存版的时钟自己拨，不用真等。 */
let clock = 1_000;
contract('会话存储 · 内存', async () => new MemoryAgentStore(() => clock), async () => { clock += 1000; });

describe('stripImages 不动没有图的消息', () => {
  it('原样返回同一个对象', () => {
    const m: EngineMessage = { role: 'user', content: 'x' };
    expect(stripImages([m])[0]).toBe(m);
  });
});

describe('会话清理', () => {
  it('超过保留期的才清', async () => {
    let t = 0;
    const s = new MemoryAgentStore(() => t);
    await s.create({ id: sid(7), userId: U1, workspace: 'a' });
    t = 10_000;
    await s.create({ id: sid(8), userId: U1, workspace: 'b' });
    expect(await s.prune(5_000)).toBe(1);
    expect(await s.get(sid(7))).toBeNull();
    expect(await s.get(sid(8))).not.toBeNull();
  });
});

const DSN = process.env.ISPACE_TEST_PG;
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../../../packages/db/migrations');

describe.skipIf(!DSN)('会话存储 · Postgres', () => {
  let sql: Sql;
  beforeAll(async () => {
    const u = new URL(DSN!);
    sql = createDb({
      host: u.hostname, port: Number(u.port || 5432),
      database: u.pathname.replace(/^\//, '') || 'postgres',
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), max: 2,
    });
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    await runMigrations(sql, MIGRATIONS);
    for (const [id, name] of [[U1, 'u1'], [U2, 'u2']] as const) {
      await sql`
        INSERT INTO ispace.users (id, sso_subject, username, display_name, role)
        VALUES (${id}, ${name}, ${name}, ${name}, 'employee')
      `;
    }
  });
  afterAll(async () => { await sql?.end({ timeout: 2 }); });

  it('messages 存进去是 jsonb 数组，不是字符串标量', async () => {
    const s = new PgAgentStore(sql);
    await s.create({ id: sid(20), userId: U1, workspace: 'x' });
    await s.save(sid(20), { messages: [{ role: 'user', content: 'hi' }] });
    const [r] = await sql<{ t: string }[]>`SELECT jsonb_typeof(messages) AS t FROM ispace.agent_sessions WHERE id = ${sid(20)}`;
    expect(r!.t).toBe('array');
  });

  contract('契约', async () => new PgAgentStore(sql), () => new Promise((r) => setTimeout(r, 15)));
});
