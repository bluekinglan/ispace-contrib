import type { FastifyInstance } from 'fastify';
import { CURRENT_EVENT_SLUG } from '@ispace/contracts';
import type { Sql } from '@ispace/db';
import { applyAutoFinalists } from '../services/event-finalists.js';

/**
 * 初筛投票一截止就自动定入围名单（规则见 services/event-finalists.ts）。
 *
 * 每 30 秒看一眼。到点前、跑过之后都只是一次主键查询；真正写库只有到点后
 * 的第一轮那一次。30 秒的粒度意味着名单最晚在 20:00:30 定下来——离 20:30
 * 公布还有将近半小时，组织者在控制台有足够时间核对。
 *
 * 不靠「谁来访问就顺手算一下」：20:00 那一刻未必有人开着页面，而组织者
 * 打开控制台时应该看到已经定好的名单，而不是等他点进来才开始算。
 *
 * 和 maintenance.ts 一样假定单实例；即便多跑一份，抢标记那一步也保证只写
 * 一次。
 */
const EVERY = 30_000;

export function startEventFinalistsJob(app: FastifyInstance, sql: Sql): () => void {
  const tick = () => {
    void applyAutoFinalists(sql, CURRENT_EVENT_SLUG, new Date())
      .then((r) => {
        if (!r.done) return;
        if ('kept' in r) {
          app.log.info(`入围名单：到点前已有 ${r.kept} 个人工设定的入围，保留不动`);
        } else if (r.tie) {
          app.log.warn(
            `入围名单：第 8 名同票 ${r.pending} 个，扩到 9 个也装不下，没有自动写入，等人在控制台定`,
          );
        } else {
          app.log.info(`入围名单：初筛投票已截止，自动写入 ${r.written} 个入围`);
        }
      })
      .catch((e: unknown) => {
        app.log.error({ err: e, job: 'event-finalists' }, '自动定入围名单失败');
      });
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, EVERY);
  return () => { clearTimeout(first); clearInterval(timer); };
}
