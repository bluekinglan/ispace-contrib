import { describe, expect, it } from 'vitest';
import type { EventAdminIdea } from '@ispace/contracts';
import { finalistNo, moveAt, savedFinalistOrder } from '../event-admin.js';

/**
 * 入围名单的顺序 = 编号 = 路演顺序。排错了要到 10.23 上午才会被发现，
 * 所以把顺序这件事钉在这里。
 */

const idea = (id: string, over: Partial<EventAdminIdea> = {}): EventAdminIdea => ({
  id,
  name: `创意 ${id}`,
  problem: '问题',
  plan: '方案',
  form: 'iSpace 页面',
  files: [],
  who: '某人',
  username: 'someone',
  finalist: false,
  no: null,
  submitted: false,
  createdAt: '2026-10-16T02:00:00.000Z',
  ...over,
});

describe('已存的入围顺序', () => {
  it('按编号排，不按提交时间', () => {
    const order = savedFinalistOrder([
      idea('a', { finalist: true, no: '03', createdAt: '2026-10-16T01:00:00.000Z' }),
      idea('b', { finalist: true, no: '01', createdAt: '2026-10-17T01:00:00.000Z' }),
      idea('c', { finalist: true, no: '02', createdAt: '2026-10-18T01:00:00.000Z' }),
    ]);
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('没入围的创意不进名单', () => {
    expect(savedFinalistOrder([
      idea('a', { finalist: true, no: '01' }),
      idea('b'),
    ])).toEqual(['a']);
  });

  /** 编号到两位数之后，字典序会把 '10' 排到 '2' 前面，所以必须按数值排。 */
  it('两位数编号仍按数值排', () => {
    const order = savedFinalistOrder([
      idea('x', { finalist: true, no: '10' }),
      idea('y', { finalist: true, no: '09' }),
      idea('z', { finalist: true, no: '02' }),
    ]);
    expect(order).toEqual(['z', 'y', 'x']);
  });

  it('还没加载上（null）时是空名单，而不是崩掉', () => {
    expect(savedFinalistOrder(null)).toEqual([]);
  });
});

describe('上移下移', () => {
  it('相邻两项互换', () => {
    expect(moveAt(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveAt(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('越界时原样返回，不洗牌', () => {
    const list = ['a', 'b', 'c'];
    expect(moveAt(list, 0, -1)).toEqual(list);
    expect(moveAt(list, 2, 1)).toEqual(list);
    expect(moveAt(list, 9, -1)).toEqual(list);
  });

  it('不改原数组——React 靠引用变化判断要不要重渲染', () => {
    const list = ['a', 'b'];
    const moved = moveAt(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
    expect(moved).not.toBe(list);
  });
});

describe('编号', () => {
  /** 与服务端 PATCH 里的 padStart(2, '0') 必须一致，否则屏上与库里对不上。 */
  it('从 01 起，补到两位', () => {
    expect([0, 1, 7, 9, 10].map(finalistNo)).toEqual(['01', '02', '08', '10', '11']);
  });
});
