import { describe, expect, it } from 'vitest';
import {
  EXPLORE_ALL, EXPLORE_BUCKETS, EXPLORE_CATEGORIES,
  commentBodySchema, exploreBucket, interestsInputSchema, postInputSchema,
} from '../social.js';

describe('探索分类', () => {
  it('第一颗是「不筛」，其余就是七个桶', () => {
    expect(EXPLORE_CATEGORIES[0]).toBe(EXPLORE_ALL);
    expect(EXPLORE_CATEGORIES.slice(1)).toEqual([...EXPLORE_BUCKETS]);
  });

  it('改版前攒下的旧分类仍能落到某个桶里', () => {
    // 这是这张映射表存在的唯一理由：库里已经有这些值，不认它们就等于
    // 让既有页面从每一个分类下消失。
    expect(exploreBucket('效率工具')).toBe('工作提效');
    expect(exploreBucket('办公提效')).toBe('工作提效');
    expect(exploreBucket('表单问卷')).toBe('数据看板');
    expect(exploreBucket('游戏娱乐')).toBe('小游戏');
    expect(exploreBucket('旅行攻略')).toBe('生活');
    expect(exploreBucket('生活服务')).toBe('生活');
  });

  it('新分类原样保留', () => {
    for (const c of EXPLORE_BUCKETS) expect(exploreBucket(c)).toBe(c);
  });

  it('没分类、空白、以及 AI 自造的词都落到「工作提效」，不另开桶', () => {
    // 另开桶的后果是那些页面没有任何入口能点到——分类条是固定八颗。
    expect(exploreBucket(null)).toBe('工作提效');
    expect(exploreBucket(undefined)).toBe('工作提效');
    expect(exploreBucket('')).toBe('工作提效');
    expect(exploreBucket('摸鱼神器')).toBe('工作提效');
    expect(EXPLORE_BUCKETS).toContain(exploreBucket('随便什么'));
  });

  it('两边空格不影响归桶', () => {
    expect(exploreBucket('  团队协作 ')).toBe('团队协作');
  });
});

describe('兴趣', () => {
  it('设计稿写「选 1-3 个」，所以 0 个也收（右上角那个「跳过」）', () => {
    expect(interestsInputSchema.parse({ interests: [] }).interests).toEqual([]);
  });

  it('超过三个不收', () => {
    expect(
      interestsInputSchema.safeParse({ interests: ['工作提效', '生活', '学习', '小游戏'] }).success,
    ).toBe(false);
  });

  it('只收探索分类里的词', () => {
    expect(interestsInputSchema.safeParse({ interests: ['摸鱼'] }).success).toBe(false);
    expect(interestsInputSchema.safeParse({ interests: [EXPLORE_ALL] }).success).toBe(false);
  });
});

describe('评论与动态的正文', () => {
  it('纯空白不是内容', () => {
    expect(commentBodySchema.safeParse('   ').success).toBe(false);
    expect(postInputSchema.safeParse({ body: '\n\t ' }).success).toBe(false);
  });

  it('前后空格会被削掉，长度按削完算', () => {
    expect(commentBodySchema.parse('  好用  ')).toBe('好用');
    expect(commentBodySchema.safeParse(` ${'字'.repeat(500)} `).success).toBe(true);
    expect(commentBodySchema.safeParse('字'.repeat(501)).success).toBe(false);
  });

  it('附的页面得是个 uuid', () => {
    expect(postInputSchema.safeParse({ body: '看这个', appId: 'paiban' }).success).toBe(false);
  });
});
