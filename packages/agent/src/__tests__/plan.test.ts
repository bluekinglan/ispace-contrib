import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlan, runTool, toolsFor, type ToolContext } from '../tools.js';

/**
 * 计划模式：「先出计划，你确认后再动手」。
 *
 * ┌─ 这一组真正要守的是什么 ────────────────────────────────────────────┐
 * │ 不是"提示词里写了让它先出计划"，是**没点头之前它真的动不了文件**。   │
 * │ 只靠提示词的话，模型兴致一来照样先写两个文件再说——而用户点「确认」 │
 * │ 的时候东西已经改完了，那句承诺就是假的。                            │
 * └──────────────────────────────────────────────────────────────────────┘
 */
describe('计划模式的闸门', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ispace-plan-'));
  const ctx = (planGate: boolean): ToolContext => ({
    ws: { root: dir, username: 'lixiao' },
    platform: {
      getQuota: async () => '',
      listApps: async () => '',
      requestDeploy: async () => ({ confirmToken: 't' }),
    },
    ...(planGate ? { planGate: true } : {}),
  });

  it('没点头之前，写/改/删/发布一律拦下', async () => {
    for (const [name, args] of [
      ['write_file', { path: 'a.html', content: 'x' }],
      ['edit_file', { path: 'a.html', find: 'x', replace: 'y' }],
      ['delete_file', { path: 'a.html' }],
      ['request_deploy', { site: 'x', summary: 'y' }],
    ] as const) {
      const out = await runTool(ctx(true), name, args as Record<string, unknown>);
      expect(out).toContain('计划模式');
      expect(out).toContain('propose_plan');
    }
  });

  it('拦下来的时候要告诉它该干什么，不是只说「不行」', async () => {
    const out = await runTool(ctx(true), 'write_file', { path: 'a.html', content: 'x' });
    // 模型照着这句话就能走回正路
    expect(out).toContain('先调 propose_plan');
    expect(out).toContain('停下等他点头');
  });

  it('读、搜、列不拦——做计划正要用它们', async () => {
    const out = await runTool(ctx(true), 'list_files', {});
    expect(out).not.toContain('计划模式');
  });

  it('点头之后（闸门撤掉）照常能写', async () => {
    const out = await runTool(ctx(false), 'write_file', { path: 'a.html', content: '<h1>hi</h1>' });
    expect(out).toContain('已写入');
  });

  it('不在计划模式时不挂 propose_plan——否则普通对话也会先绕一份计划', () => {
    const names = (opts: Parameters<typeof toolsFor>[0]) => toolsFor(opts).map((t) => t.name);
    expect(names({})).not.toContain('propose_plan');
    expect(names({ canPlan: true })).toContain('propose_plan');
  });

  it('计划解析：空的、全空白的都算没给出计划', () => {
    expect(parsePlan({})).toBeNull();
    expect(parsePlan({ steps: [] })).toBeNull();
    expect(parsePlan({ steps: ['  ', ''] })).toBeNull();
  });

  it('计划解析：去空白、丢空行、最多 8 步', () => {
    const r = parsePlan({ steps: ['  建两张表 ', '', '写三个视图', '自检'], note: ' 数据来源还没定 ' });
    expect(r?.steps).toEqual(['建两张表', '写三个视图', '自检']);
    expect(r?.note).toBe('数据来源还没定');

    const many = parsePlan({ steps: Array.from({ length: 12 }, (_, i) => `第 ${i} 步`) });
    expect(many?.steps).toHaveLength(8);
  });
});
