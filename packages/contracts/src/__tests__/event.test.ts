import { describe, expect, it } from 'vitest';
import {
  CURRENT_EVENT_SLUG, EVENT_PATH, EVENT_PHASES,
  ideaInputSchema, isReservedPath, phaseAtLeast, scoreInputSchema, usernameSchema,
  workInputSchema,
} from '../index.js';

describe('活动路径', () => {
  /**
   * /1024/judge 与 /1024/screen 正好长成 `/{user}/{app}/` 的样子。
   * 不把 1024 放进保留字，网关会拿它去 /srv/sites/1024/judge/ 找文件，
   * 评委打分页会变成 404，而且看不出为什么。
   */
  it('1024 是保留路径，否则 /1024/judge 会被网关当成用户页面', () => {
    expect(isReservedPath('1024')).toBe(true);
    expect(EVENT_PATH).toBe('/1024');
  });

  it('用户名本来就不可能叫 1024——保留它不会挡掉任何人', () => {
    expect(usernameSchema.safeParse('1024').success).toBe(false);
  });
});

describe('阶段顺序', () => {
  it('phaseAtLeast 按时间先后比较', () => {
    expect(phaseAtLeast('demo', 'building')).toBe(true);
    expect(phaseAtLeast('building', 'demo')).toBe(false);
    expect(phaseAtLeast('result', 'result')).toBe(true);
  });

  it('每个阶段都能和自己比，且 ended 最大', () => {
    for (const p of EVENT_PHASES) {
      expect(phaseAtLeast(p, p)).toBe(true);
      expect(phaseAtLeast('ended', p)).toBe(true);
    }
  });
});

describe('创意校验', () => {
  const ok = { name: '周报助手', problem: '每周五凑周报', plan: '接日程和工单自动汇总' };

  it('三个必填项缺一不可', () => {
    expect(ideaInputSchema.safeParse(ok).success).toBe(true);
    for (const k of ['name', 'problem', 'plan'] as const) {
      expect(ideaInputSchema.safeParse({ ...ok, [k]: '   ' }).success, k).toBe(false);
    }
  });

  it('默认形态是 iSpace 页面，附件默认为空', () => {
    const r = ideaInputSchema.parse(ok);
    expect(r.form).toBe('iSpace 页面');
    expect(r.files).toEqual([]);
  });

  it('附件最多 5 个', () => {
    const f = { name: 'a.png', size: 1, url: '/x' };
    expect(ideaInputSchema.safeParse({ ...ok, files: Array(5).fill(f) }).success).toBe(true);
    expect(ideaInputSchema.safeParse({ ...ok, files: Array(6).fill(f) }).success).toBe(false);
  });
});

describe('作品校验', () => {
  /*
    两种 kind 要求的字段不同。用 discriminatedUnion 的意义就在于
    「页面作品没选页面」这类错在解析期就被挡住，而不是落到库的 CHECK
    上变成一句看不懂的约束名。
  */
  it('页面作品必须给 appSlug', () => {
    expect(workInputSchema.safeParse({ kind: 'page', appSlug: 'zhoubao' }).success).toBe(true);
    expect(workInputSchema.safeParse({ kind: 'page' }).success).toBe(false);
  });

  it('硬件作品必须有名字和至少一个附件', () => {
    const f = { name: 'p.jpg', size: 10, url: '/x' };
    expect(workInputSchema.safeParse({ kind: 'other', name: '签到机', files: [f] }).success).toBe(true);
    expect(workInputSchema.safeParse({ kind: 'other', name: '签到机', files: [] }).success).toBe(false);
    expect(workInputSchema.safeParse({ kind: 'other', name: ' ', files: [f] }).success).toBe(false);
  });

  it('页面作品不接受 appSlug 之外的身份来源', () => {
    // 传了 files 也不会被当成硬件作品——kind 才是判别字段
    const r = workInputSchema.safeParse({ kind: 'page', appSlug: 'zhoubao', files: [] });
    expect(r.success).toBe(true);
    if (r.success) expect('files' in r.data).toBe(false);
  });
});

describe('打分校验', () => {
  it('submit 默认 false——不显式提交就是草稿', () => {
    expect(scoreInputSchema.parse({ dims: [30, 20, 15, 15] }).submit).toBe(false);
  });

  it('分数不能是负数', () => {
    expect(scoreInputSchema.safeParse({ dims: [-1, 0, 0, 0] }).success).toBe(false);
  });

  it('维度个数与上限由服务端按 config.criteria 校验，schema 只管形态', () => {
    // 这里能过，是因为「几个维度、每个多少分」是本届配置，不是契约常量
    expect(scoreInputSchema.safeParse({ dims: [1, 2] }).success).toBe(true);
  });
});

describe('当届 slug', () => {
  it('slug 带年份，路径不带——横幅上印的是 1024', () => {
    expect(CURRENT_EVENT_SLUG).toMatch(/^1024-\d{4}$/);
    expect(EVENT_PATH).not.toContain('2026');
  });
});
