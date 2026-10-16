import { describe, expect, it } from 'vitest';
import { rankScreening } from '../routes/events.js';

/**
 * 初筛得票榜，以及第 8 名同票怎么处理。
 *
 * 这段逻辑一年只跑一次，跑的那一次是在 8 位评委和几十位参赛同事面前当场
 * 公布名单——出错没有补救的机会，所以每一种边界都钉在这里。
 */

const mk = (votes: number[]) =>
  votes.map((v, i) => ({ id: `i${i}`, name: `创意${i}`, who: `人${i}`, votes: v }));

/** 取每一行的状态，拼成一串好对照 */
const st = (rows: ReturnType<typeof rankScreening>) => rows.map((r) => r.status);
const rk = (rows: ReturnType<typeof rankScreening>) => rows.map((r) => r.rank);

describe('常规情况', () => {
  it('前 8 入围，第 9 名之后出局', () => {
    const r = rankScreening(mk([8, 7, 6, 6, 5, 4, 3, 2, 1, 1]), 8);
    expect(st(r)).toEqual([
      'in', 'in', 'in', 'in', 'in', 'in', 'in', 'in',
      'out', 'out',
    ]);
  });

  it('名次是竞赛排名：同票同名次，下一个跳号', () => {
    // 票数 8,7,7,5 → 名次 1,2,2,4。显示成 1,2,3,4 的话，看榜的人会以为
    // 两个 7 票里有一个排在前面——而他们是平的。
    const r = rankScreening(mk([8, 7, 7, 5]), 8);
    expect(rk(r)).toEqual([1, 2, 2, 4]);
  });
});

describe('卡在第 8 名上的同票', () => {
  /*
    这是整个函数存在的理由。票数 …,3,3,3 其中两个要挤进最后一个名额——
    系统不替人选，三个都标 tie，由评委线下商定。
  */
  it('卡线那一档塞不下剩余名额时，整档标成待定', () => {
    //                      1  2  3  4  5  6  ← 这六个稳进
    //                                        7  8  9 都是 3 票，抢最后两个名额
    const r = rankScreening(mk([9, 8, 7, 6, 5, 4, 3, 3, 3]), 8);
    expect(st(r)).toEqual([
      'in', 'in', 'in', 'in', 'in', 'in',
      'tie', 'tie', 'tie',
    ]);
    // 排在第 7 位的那个也是 3 票，所以它同样是待定的一员——不能因为 SQL
    // 把它排在前面就算它进了，那正是「让 ORDER BY 替人做决定」
    expect(r[6]!.votes).toBe(3);
    expect(r[6]!.status).toBe('tie');
  });

  it('卡线那一档正好填满名额，就不是同票', () => {
    // 票数 …,4,4 两个并列第 7，正好占满 7、8 两个名额——没有人被挤出去
    const r = rankScreening(mk([9, 8, 7, 6, 5, 5, 4, 4, 2]), 8);
    expect(st(r)).toEqual([
      'in', 'in', 'in', 'in', 'in', 'in', 'in', 'in',
      'out',
    ]);
  });

  it('第 9 名票数更低时，第 8 名独占名额', () => {
    const r = rankScreening(mk([9, 8, 7, 6, 5, 4, 3, 2, 1]), 8);
    expect(r[7]!.status).toBe('in');
    expect(r[8]!.status).toBe('out');
  });
});

describe('边界', () => {
  it('创意数不足名额时谁都不出局', () => {
    const r = rankScreening(mk([3, 2, 1]), 8);
    expect(st(r)).toEqual(['in', 'in', 'in']);
  });

  it('全员零票也不崩，而且不会凭空判出局', () => {
    // 真会发生：评委一票没投就到点了。那时名单是空的，该由人来处理，
    // 但这个函数不能抛，否则整个看板接口 500。
    const r = rankScreening(mk([0, 0, 0]), 8);
    expect(st(r)).toEqual(['in', 'in', 'in']);
    expect(rk(r)).toEqual([1, 1, 1]);
  });

  it('零票的人排在有票的人后面时算出局', () => {
    const r = rankScreening(mk([2, 1, 0]), 2);
    expect(st(r)).toEqual(['in', 'in', 'out']);
  });

  it('没有创意、或者本届不设名额，返回空榜而不是抛', () => {
    expect(rankScreening([], 8)).toEqual([]);
    expect(rankScreening(mk([3, 2]), 0)).toEqual([]);
  });

  it('名额为 1 且前两名同票：两个都待定', () => {
    const r = rankScreening(mk([5, 5, 1]), 1);
    expect(st(r)).toEqual(['tie', 'tie', 'out']);
  });
});
