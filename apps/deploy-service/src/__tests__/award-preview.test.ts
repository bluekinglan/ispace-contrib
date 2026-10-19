import { describe, expect, it } from 'vitest';
import { canPreviewAwards } from '../routes/events.js';

/**
 * 组织者提前进颁奖大屏。
 *
 * 获奖名单对外 15:10 才公布，组织者要在那之前把大屏挂上、从背景墙走一遍。
 * 放开的时刻必须是「所有结果都定了」——打分锁定和人气投票截止都过了。
 * 早一分钟放，人气奖都可能在大屏上变。
 */

const ev = {
  config: {
    awardPreview: ['lixuege'],
    deadlines: {
      judgeLock: '2026-10-23T11:55:00+08:00',
      vote: '2026-10-23T12:00:00+08:00',
    },
  },
} as never;

const at = (hm: string) => new Date(`2026-10-23T${hm}:00+08:00`);
const lixuege = { username: 'lixuege', role: 'employee' as const };
const admin = { username: 'zongkelong', role: 'admin' as const };
const other = { username: 'wangkai', role: 'employee' as const };

describe('谁能提前看', () => {
  it('名单里的人可以', () => {
    expect(canPreviewAwards(ev, lixuege, at('12:00'))).toBe(true);
  });

  it('管理员不用列进名单也可以', () => {
    expect(canPreviewAwards(ev, admin, at('12:00'))).toBe(true);
  });

  it('其他人不行，哪怕时间到了', () => {
    expect(canPreviewAwards(ev, other, at('14:00'))).toBe(false);
  });

  it('没登录不行', () => {
    expect(canPreviewAwards(ev, null, at('14:00'))).toBe(false);
  });
});

describe('什么时候放开', () => {
  it('打分锁定了、人气票还没截止：不放——人气奖还会变', () => {
    expect(canPreviewAwards(ev, lixuege, at('11:57'))).toBe(false);
  });

  it('两个都过了才放', () => {
    expect(canPreviewAwards(ev, lixuege, at('11:59'))).toBe(false);
    expect(canPreviewAwards(ev, lixuege, at('12:00'))).toBe(true);
  });

  it('配置里两个时间都没有：不放，等正式公布', () => {
    const bare = { config: { awardPreview: ['lixuege'], deadlines: {} } } as never;
    expect(canPreviewAwards(bare, lixuege, at('14:00'))).toBe(false);
  });

  it('时间写坏了：不放，而不是当成已经过了', () => {
    const broken = {
      config: { awardPreview: ['lixuege'], deadlines: { judgeLock: 'not-a-date', vote: '2026-10-23T12:00:00+08:00' } },
    } as never;
    expect(canPreviewAwards(broken, lixuege, at('14:00'))).toBe(false);
  });

  it('没有 awardPreview 的老配置：只有管理员能提前看', () => {
    const old = { config: { deadlines: { judgeLock: '2026-10-23T11:55:00+08:00', vote: '2026-10-23T12:00:00+08:00' } } } as never;
    expect(canPreviewAwards(old, lixuege, at('14:00'))).toBe(false);
    expect(canPreviewAwards(old, admin, at('14:00'))).toBe(true);
  });
});
