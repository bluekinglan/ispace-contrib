import { describe, expect, it } from 'vitest';
import {
  LOTTERY_JACKPOT, LOTTERY_JP_EXCLUDE, LOTTERY_PEOPLE, LOTTERY_PRIZES,
  LOTTERY_REGULAR, LOTTERY_ROUNDS,
} from '../event/lottery-data';

/**
 * 全员抽奖的名册与奖品表。
 *
 * 这些数字当天上午才用一次，用的时候是投在大屏上、全公司看着。奖品比人多
 * 会在最后一轮剩下发不掉的东西，比人少会有人站在那儿没被抽到——两种都没法
 * 当场补救，所以把约束钉在这里，改名单或改奖品表时先撞上它。
 */

const roundTotal = (r: number) =>
  LOTTERY_PRIZES.reduce((n, p) => n + (p.r[r - 1] ?? 0), 0);

describe('人数与奖品数', () => {
  it('普通轮的份数之和正好等于人数——人人有奖，一个不多一个不少', () => {
    const prizes = LOTTERY_REGULAR.reduce((n, r) => n + roundTotal(r), 0);
    expect(prizes).toBe(LOTTERY_PEOPLE.length);
  });

  it('每轮 17 个，第三轮 18 个（86 人摊不平，多的那个放中间那轮）', () => {
    expect(LOTTERY_REGULAR.map(roundTotal)).toEqual([17, 17, 18, 17, 17]);
  });

  it('每个普通轮各有且只有一个现金大奖（666 红包）', () => {
    for (const r of LOTTERY_REGULAR) {
      const cash = LOTTERY_PRIZES.filter((p) => p.cash).reduce((n, p) => n + (p.r[r - 1] ?? 0), 0);
      expect(cash, `第 ${r} 轮`).toBe(1);
    }
  });

  it('压轴只有 1024 红包这一份', () => {
    expect(roundTotal(LOTTERY_JACKPOT)).toBe(1);
    const jack = LOTTERY_PRIZES.filter((p) => p.jack);
    expect(jack).toHaveLength(1);
    expect(jack[0]!.r[LOTTERY_JACKPOT - 1]).toBe(1);
  });

  it('奖品表的每一行长度都等于总轮数——短一位就会静默当成 0 份', () => {
    for (const p of LOTTERY_PRIZES) {
      expect(p.r, p.name).toHaveLength(LOTTERY_ROUNDS + 1);
    }
  });
});

describe('名册', () => {
  it('编号连续从 1 起——编号就是头像文件名，断号会让头像对错人', () => {
    LOTTERY_PEOPLE.forEach((p, i) => expect(p.pid).toBe(i + 1));
  });

  it('花名不重名：大屏上只显示花名，重名就认不出是谁中了', () => {
    const nicks = LOTTERY_PEOPLE.map((p) => p.nick);
    expect(new Set(nicks).size).toBe(nicks.length);
  });

  it('有照片的人，照片地址和他的编号对得上', () => {
    for (const p of LOTTERY_PEOPLE) {
      if (!p.img) continue;
      const pad = p.pid < 10 ? `0${p.pid}` : String(p.pid);
      expect(p.img, p.nick).toBe(`/lottery/avatar-${pad}.png`);
    }
  });

  it('不参加压轴的那几位确实在名册里——写错花名的话排除会静默失效', () => {
    for (const nick of LOTTERY_JP_EXCLUDE) {
      expect(LOTTERY_PEOPLE.some((p) => p.nick === nick), nick).toBe(true);
    }
  });

  it('压轴的池子至少还剩两个人', () => {
    expect(LOTTERY_PEOPLE.length - LOTTERY_JP_EXCLUDE.length).toBeGreaterThan(1);
  });
});
