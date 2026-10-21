import { describe, expect, it } from 'vitest';
import { configuredModels, contextBudget, MAX_CONTEXT_CHARS } from '../engine.js';
import { DEFAULT_CONTEXT_CHARS } from '../compact.js';

/**
 * 压缩阈值按模型窗口算。
 *
 * ┌─ 这一组守的是两条容易想当然的判断 ──────────────────────────────────┐
 * │ 1. 字符不是 token。压缩器量字符，窗口给 token——只能拿字符数去顶   │
 * │    token 额度（中文一字约一 token），反过来按"三字符一 token"折算， │
 * │    一篇全中文的长对话会直接把请求撑爆，而那是网关拒绝不是我们截断。 │
 * │ 2. 窗口大不等于该用满：每轮都重发整段历史，1M 真喂满又慢又贵。      │
 * └──────────────────────────────────────────────────────────────────────┘
 */
describe('上下文预算', () => {
  const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

  it('模型清单能解析出第四段窗口', () => {
    const list = configuredModels(env({
      AGENT_MODELS: 'gpt-6.1-sol|GPT|0.4x|258000, deepseek-flash|快|1x|1000000, glm|GLM',
    }));
    expect(list[0]).toMatchObject({ id: 'gpt-6.1-sol', ctx: 258_000 });
    expect(list[1]).toMatchObject({ id: 'deepseek-flash', ctx: 1_000_000 });
    /* 没填窗口的不瞎猜——猜错是网关直接拒请求 */
    expect(list[2]?.ctx).toBeUndefined();
  });

  it('窗口填错（非数字、负数）当没填', () => {
    const list = configuredModels(env({ AGENT_MODELS: 'a|A|1x|abc, b|B|1x|-5' }));
    expect(list[0]?.ctx).toBeUndefined();
    expect(list[1]?.ctx).toBeUndefined();
  });

  it('没填窗口的模型，照旧用保守的全局值', () => {
    expect(contextBudget(env({ AGENT_MODELS: 'glm|GLM' }), 'glm')).toBe(DEFAULT_CONTEXT_CHARS);
  });

  it('258k 窗口：扣掉输出上限与余量之后的那部分', () => {
    const b = contextBudget(env({
      AGENT_MODELS: 'gpt|GPT|1x|258000',
      AGENT_MAX_TOKENS: '64000',
    }), 'gpt');
    // 258000 - 64000(输出) - 8000(工具与系统提示) = 186000
    expect(b).toBe(186_000);
    // 关键：不能超过窗口本身
    expect(b).toBeLessThan(258_000);
  });

  it('1M 窗口被 CAP 压住——窗口大不等于该用满', () => {
    const b = contextBudget(env({
      AGENT_MODELS: 'ds|DeepSeek|1x|1000000',
      AGENT_MAX_TOKENS: '64000',
    }), 'ds');
    expect(b).toBe(MAX_CONTEXT_CHARS);
    expect(b).toBeLessThan(1_000_000);
  });

  it('按这一轮实际用的那个模型算，不是永远第一个', () => {
    const e = env({ AGENT_MODELS: 'gpt|GPT|1x|258000, ds|DeepSeek|1x|1000000', AGENT_MAX_TOKENS: '64000' });
    expect(contextBudget(e, 'gpt')).toBe(186_000);
    expect(contextBudget(e, 'ds')).toBe(MAX_CONTEXT_CHARS);
  });

  it('显式配了 AGENT_CONTEXT_CHARS 就听它的——管理员写的数字赢过推算', () => {
    const b = contextBudget(env({
      AGENT_MODELS: 'ds|DeepSeek|1x|1000000',
      AGENT_CONTEXT_CHARS: '900000',
    }), 'ds');
    expect(b).toBe(900_000);
  });

  it('窗口比输出上限还小（多半填错了）退回保守值，而不是算出负数', () => {
    const b = contextBudget(env({ AGENT_MODELS: 'x|X|1x|1000', AGENT_MAX_TOKENS: '64000' }), 'x');
    expect(b).toBe(DEFAULT_CONTEXT_CHARS);
  });

  it('算出来的预算永远不低于原来的保守值——不会因为填了窗口反而更小', () => {
    const b = contextBudget(env({ AGENT_MODELS: 'x|X|1x|200000', AGENT_MAX_TOKENS: '64000' }), 'x');
    expect(b).toBeGreaterThanOrEqual(DEFAULT_CONTEXT_CHARS);
  });
});
