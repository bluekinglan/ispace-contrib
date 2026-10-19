import type { Sql } from '@ispace/db';
import { rankScreening } from '../routes/events.js';

/**
 * 初筛投票截止后自动定入围名单。
 *
 * 规则在 rankScreening：前 8 入围；第 8 名同票的全部入围、最多扩到 9 个；
 * 扩到 9 个还装不下的那一档标成 'tie'，**这里不替人选**——那种情况一个都
 * 不写，名单留空，由组织者在控制台定。宁可空着让人看见，也不要悄悄写进
 * 一份系统替人切出来的名单。
 *
 * ┌─ 只跑一次 ─────────────────────────────────────────────────────────┐
 * │ 在 config 里打一个 finalistsAutoAt 标记，抢标记用条件 UPDATE：同一时 │
 * │ 刻就算有两处同时触发，也只有一个能写成。跑过之后组织者在控制台改了  │
 * │ 名单（调顺序、换人），定时任务下一轮不会再把它冲掉。                │
 * │                                                                    │
 * │ 到点前已经有人工设好的入围名单也不动——标记照打，名单原样保留。      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 入围编号就是路演顺序，按名次排（票多的先上，同票按提交先后）。顺序不合
 * 适在控制台的入围那一块拖动调整就行，那里会整批重编号。
 *
 * 返回这一轮做了什么，给定时任务记日志用。
 */
export type AutoFinalistsResult =
  | { done: false; reason: 'not-yet' | 'no-config' | 'already' }
  | { done: true; kept: number }
  | { done: true; written: number; tie: false }
  | { done: true; written: 0; tie: true; pending: number };

export async function applyAutoFinalists(
  sql: Sql,
  slug: string,
  now: Date,
): Promise<AutoFinalistsResult> {
  const [ev] = await sql<{
    id: string;
    config: {
      screeningSlots?: number;
      finalistsAutoAt?: string;
      deadlines?: { screeningVote?: string };
    } | null;
  }[]>`
    SELECT id, config FROM ispace.events WHERE slug = ${slug}
  `;
  if (!ev) return { done: false, reason: 'no-config' };
  const shutAt = ev.config?.deadlines?.screeningVote;
  const slots = ev.config?.screeningSlots ?? 0;
  if (!shutAt || slots <= 0) return { done: false, reason: 'no-config' };
  if (now.getTime() < Date.parse(shutAt)) return { done: false, reason: 'not-yet' };
  if (ev.config?.finalistsAutoAt) return { done: false, reason: 'already' };

  return sql.begin(async (tx) => {
    /* 抢标记。抢不到说明别处刚跑完，这一轮什么都不做 */
    const won = await tx<{ id: string }[]>`
      UPDATE ispace.events
         SET config = jsonb_set(config, '{finalistsAutoAt}', to_jsonb(${now.toISOString()}::text)),
             updated_at = now()
       WHERE id = ${ev.id} AND NOT (config ? 'finalistsAutoAt')
      RETURNING id
    `;
    if (!won[0]) return { done: false, reason: 'already' } as const;

    const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ispace.event_ideas
       WHERE event_id = ${ev.id} AND finalist
    `;
    if (n > 0) return { done: true, kept: n } as const;

    /* 和得票榜用同一条排序：票数降序、同票按提交先后 */
    const rows = await tx<{ id: string; name: string; who: string; votes: number }[]>`
      SELECT i.id, i.name, u.display_name AS who,
             count(v.judge_id)::int AS votes
        FROM ispace.event_ideas i
        JOIN ispace.users u ON u.id = i.user_id
        LEFT JOIN ispace.event_screening_votes v
               ON v.event_id = i.event_id AND v.idea_id = i.id
       WHERE i.event_id = ${ev.id}
       GROUP BY i.id, i.name, u.display_name, i.created_at
       ORDER BY count(v.judge_id) DESC, i.created_at
    `;
    const ranked = rankScreening(rows, slots);
    const pending = ranked.filter((r) => r.status === 'tie').length;
    if (pending > 0) {
      /*
        卡线那一档扩到 9 个都装不下。'in' 的那几个其实是确定的，但只写一半
        的名单比空着更糟——活动页 20:30 会照着公布出去，看着像是「名单就
        这么几个」。整份留给人定。
      */
      return { done: true, written: 0, tie: true, pending } as const;
    }

    const picked = ranked.filter((r) => r.status === 'in');
    for (let i = 0; i < picked.length; i += 1) {
      await tx`
        UPDATE ispace.event_ideas
           SET finalist = true, finalist_no = ${String(i + 1).padStart(2, '0')}, updated_at = now()
         WHERE id = ${picked[i]!.ideaId} AND event_id = ${ev.id}
      `;
    }
    return { done: true, written: picked.length, tie: false } as const;
  });
}
