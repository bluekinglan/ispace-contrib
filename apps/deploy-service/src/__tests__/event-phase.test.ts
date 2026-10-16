import { describe, expect, it } from 'vitest';
import type { Sql } from '@ispace/db';
import type { EventConfig, EventPhase } from '@ispace/contracts';
import { computeRanking, resolvePhase, scoringWindow } from '../routes/events.js';

/**
 * 阶段推导与名次汇总是这届活动里两件「算错了没人会立刻发现」的事：
 *   阶段错 → 报名在截止后还开着，或者提前关上
 *   名次错 → 颁错奖
 * 两件都不依赖数据库形态，所以都能在这里用纯函数 / 假 sql 钉住。
 */

const DEADLINES: EventConfig['deadlines'] = {
  idea:      '2026-10-19T12:00:00+08:00',
  screening: '2026-10-19T14:30:00+08:00',
  work:      '2026-10-23T00:00:00+08:00',
  vote:      '2026-10-23T11:55:00+08:00',
  award:     '2026-10-23T15:30:00+08:00',
  end:       '2026-11-01T00:00:00+08:00',
};

const cfg = { deadlines: DEADLINES } as EventConfig;
const at = (iso: string) => new Date(iso);

describe('阶段按截止时间推导', () => {
  it.each<[string, EventPhase]>([
    ['2026-10-16T09:00:00+08:00', 'signup'],
    ['2026-10-19T11:59:00+08:00', 'signup'],
    ['2026-10-19T12:00:00+08:00', 'screening'],
    ['2026-10-19T14:29:00+08:00', 'screening'],
    ['2026-10-19T14:30:00+08:00', 'building'],
    ['2026-10-22T23:59:00+08:00', 'building'],
    ['2026-10-23T00:00:00+08:00', 'demo'],
    ['2026-10-23T11:56:00+08:00', 'demo'],
    ['2026-10-23T15:30:00+08:00', 'result'],
    ['2026-10-31T23:00:00+08:00', 'result'],
    ['2026-11-01T00:00:00+08:00', 'ended'],
  ])('%s → %s', (iso, expected) => {
    expect(resolvePhase({ phase: null, config: cfg }, at(iso))).toBe(expected);
  });

  /**
   * 截止时刻本身属于「之后」。
   *
   * 写成 `<=` 的话 10.19 12:00:00 整那一秒报名还开着，而主持人已经在
   * 宣布截止了——边界含糊是这类规则最容易出的争议。
   */
  it('截止时刻算已截止，不是还剩最后一秒', () => {
    expect(resolvePhase({ phase: null, config: cfg }, at(DEADLINES.idea))).toBe('screening');
  });

  it('人工覆盖优先于时间——当天主持人要能手动推进', () => {
    const early = at('2026-10-16T09:00:00+08:00');
    expect(resolvePhase({ phase: 'demo', config: cfg }, early)).toBe('demo');
    // 设回 null 就重新交给时钟
    expect(resolvePhase({ phase: null, config: cfg }, early)).toBe('signup');
  });

  /**
   * 下线不能依赖有人记得解钉。
   *
   * 当天主持人为了等路演会把阶段钉住，活动一散场没人会再打开控制台。
   * 覆盖若能盖过 end，首页横幅和 App 启动页上的 1024 就会一直挂着。
   */
  it.each<EventPhase>(['signup', 'demo', 'result'])(
    '过了 end 之后，钉成 %s 也一律 ended',
    (pinned) => {
      const after = at('2026-11-02T10:00:00+08:00');
      expect(resolvePhase({ phase: pinned, config: cfg }, after)).toBe('ended');
    },
  );

  it('end 当天那一刻起就盖不住了', () => {
    expect(resolvePhase({ phase: 'demo', config: cfg }, at(DEADLINES.end))).toBe('ended');
    // 差一分钟还在活动期内，覆盖照常生效
    expect(resolvePhase({ phase: 'demo', config: cfg }, at('2026-10-31T23:59:00+08:00'))).toBe('demo');
  });

  it('想提前下线：把阶段钉成 ended', () => {
    const during = at('2026-10-20T10:00:00+08:00');
    expect(resolvePhase({ phase: 'ended', config: cfg }, during)).toBe('ended');
  });

  /**
   * 打分窗口两头都要有。
   *
   * 原先只判「锁了没有」，于是入围制作期（10.19–10.22）是不锁的——评委
   * 在路演前四天就能把分打完，而那时作品还没交完、人也还没上台讲。
   * 赛制写的是「现场打分」。
   */
  it.each<[string, boolean, string]>([
    ['2026-10-16T09:00:00+08:00', false, '报名中：还没到'],
    ['2026-10-19T13:00:00+08:00', false, '初筛中：还没到'],
    ['2026-10-20T10:00:00+08:00', false, '入围制作：还没到——这条是修的那个 bug'],
    ['2026-10-23T00:00:00+08:00', true,  '路演开始：开'],
    ['2026-10-23T11:54:00+08:00', true,  '锁定前一分钟：还开着'],
    ['2026-10-23T11:55:00+08:00', false, '锁定时刻：关'],
    ['2026-10-23T16:00:00+08:00', false, '已出结果：关'],
  ])('%s → 能打分=%s（%s）', (iso, open) => {
    expect(scoringWindow({ phase: null, config: cfg }, at(iso)).open).toBe(open);
  });

  it('不能打分时要说清是哪一种，前端照着显示', () => {
    const before = scoringWindow({ phase: null, config: cfg }, at('2026-10-20T10:00:00+08:00'));
    expect(before.reason).toContain('路演');
    const after = scoringWindow({ phase: null, config: cfg }, at('2026-10-23T12:30:00+08:00'));
    expect(after.reason).toContain('锁定');
    // 开着的时候不该有原因，否则前端会把它当成「不能打分」显示出来
    expect(scoringWindow({ phase: null, config: cfg }, at('2026-10-23T10:00:00+08:00')).reason).toBeNull();
  });

  it('config 里没有 deadlines 时退回 signup，而不是崩掉', () => {
    expect(resolvePhase({ phase: null, config: {} as EventConfig }, new Date())).toBe('signup');
  });

  /**
   * 时区必须跟着字面量里的 +08 走。
   *
   * 这条看着多余，实则是最容易回归的一处：迁移里若漏掉偏移量，容器
   * （通常 UTC）会把 10.19 12:00 解释成北京时间晚上 8 点，报名凭空多开
   * 八小时，而本地开发机在 CST 下完全看不出问题。
   */
  it('截止判断按绝对时刻，不受服务器本地时区影响', () => {
    // 北京时间 10.19 11:59 = UTC 03:59，仍在报名中
    expect(resolvePhase({ phase: null, config: cfg }, at('2026-10-19T03:59:00Z'))).toBe('signup');
    // 北京时间 10.19 12:01 = UTC 04:01，已截止
    expect(resolvePhase({ phase: null, config: cfg }, at('2026-10-19T04:01:00Z'))).toBe('screening');
  });
});

// ── 名次汇总 ──────────────────────────────────────────────────────────

/**
 * 假 sql：只认 computeRanking 那一条查询，把 GROUP BY 的结果直接喂回去。
 *
 * 这样测的是**汇总之后的那段 JavaScript**——平均分怎么取整、并列怎么处理、
 * 没人打分的作品排在哪儿。SQL 本身的正确性归集成测试管。
 */
function fakeSql(rows: unknown[]): Sql {
  return (async () => rows) as unknown as Sql;
}

const EV = { id: 'e1', slug: '1024-2026', config: cfg } as Parameters<typeof computeRanking>[1];

describe('评委打分汇总成名次', () => {
  it('按平均分从高到低，rank 从 1 起', async () => {
    const r = await computeRanking(fakeSql([
      { idea_id: 'a', no: '01', idea_name: '甲', work_name: null, who: '周牧', avg_total: '92.44', judged: 8, votes: 10 },
      { idea_id: 'b', no: '02', idea_name: '乙', work_name: '乙作品', who: '许航', avg_total: '88.10', judged: 8, votes: 30 },
      { idea_id: 'c', no: '03', idea_name: '丙', work_name: null, who: '刘洋', avg_total: '70.00', judged: 7, votes: 5 },
    ]), EV);

    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r[0]!.judgeScore).toBe(92.4);   // 一位小数，四舍五入
    expect(r[1]!.name).toBe('乙作品');      // 有作品名就用作品名
    expect(r[2]!.judged).toBe(7);          // 几个人打的分一并交出去
  });

  /**
   * 没有任何评委提交时不编一个名次出来。
   *
   * 排序 SQL 用的是 NULLS LAST，所以这些行排在最后；但它们的 rank 必须是
   * null 而不是 4、5、6——否则颁奖时会把一个零分作品当成第四名。
   */
  it('无人打分的作品没有名次，且不占用名次号', async () => {
    const r = await computeRanking(fakeSql([
      { idea_id: 'a', no: '01', idea_name: '甲', work_name: null, who: '周牧', avg_total: '80', judged: 8, votes: 1 },
      { idea_id: 'b', no: '02', idea_name: '乙', work_name: null, who: '许航', avg_total: null, judged: 0, votes: 9 },
      { idea_id: 'c', no: '03', idea_name: '丙', work_name: null, who: '刘洋', avg_total: null, judged: 0, votes: 2 },
    ]), EV);

    expect(r[0]!.rank).toBe(1);
    expect(r[1]!.rank).toBeNull();
    expect(r[2]!.rank).toBeNull();
    expect(r[1]!.judgeScore).toBeNull();
    // 票数照样带出来：人气奖只看票，不看有没有评委打过分
    expect(r[1]!.votes).toBe(9);
  });

  it('一个作品都没有时返回空数组', async () => {
    expect(await computeRanking(fakeSql([]), EV)).toEqual([]);
  });

  it('票数与分数各自独立——票王不一定是第一名', async () => {
    const r = await computeRanking(fakeSql([
      { idea_id: 'a', no: '01', idea_name: '甲', work_name: null, who: '周牧', avg_total: '92', judged: 8, votes: 3 },
      { idea_id: 'b', no: '06', idea_name: '乙', work_name: null, who: '李骁', avg_total: '85', judged: 8, votes: 39 },
    ]), EV);

    expect(r[0]!.rank).toBe(1);
    expect(r[0]!.votes).toBe(3);
    const topVotes = [...r].sort((x, y) => y.votes - x.votes)[0]!;
    expect(topVotes.no).toBe('06');   // 人气奖归它
    expect(topVotes.rank).toBe(2);    // 但评委名次是第二
  });
});
