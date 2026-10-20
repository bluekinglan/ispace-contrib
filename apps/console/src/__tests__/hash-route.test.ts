import { describe, expect, it } from 'vitest';
import { screenFromHash } from '../App';

/**
 * 控制台认 hash 的那一下。
 *
 * 它是门户与控制台之间唯一的接口：门户侧栏写 /console#guide、「我的作品」
 * 的管理按钮写 /console#page=gongshi。这几条约定一旦对不上，表现是"点了
 * 管理，打开的是总览"——没有报错，只是去错了地方。
 */
describe('控制台的 hash 路由', () => {
  it('控制台自己写出去的形式', () => {
    expect(screenFromHash('#/pages')).toBe('pages');
    expect(screenFromHash('#/audit')).toBe('audit');
  });

  it('门户那边链接过来的短形式', () => {
    expect(screenFromHash('#guide')).toBe('guide');
    expect(screenFromHash('#backend')).toBe('backends');
  });

  it('并进「后端与数据」的那几屏，老链接仍落到新屏上', () => {
    // 书签和已经发出去的链接不会自己改
    for (const old of ['#/data', '#/connectors', '#/quota']) {
      expect(screenFromHash(old)).toBe('backends');
    }
  });

  it('带页面 slug 的形式落到「页面与版本」', () => {
    expect(screenFromHash('#page=gongshi')).toBe('pages');
    expect(screenFromHash('#/page=gongshi')).toBe('pages');
  });

  it('空 hash 回总览', () => {
    expect(screenFromHash('')).toBe('overview');
    expect(screenFromHash('#')).toBe('overview');
    expect(screenFromHash('#/')).toBe('overview');
  });
});
