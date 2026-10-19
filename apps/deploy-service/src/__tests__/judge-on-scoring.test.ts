import { describe, expect, it } from 'vitest';
import { judgeOnScoring } from '@ispace/contracts';

/**
 * 评委页什么时候从「初筛投票」翻到「打分」。
 *
 * 分界是初筛封票（20:00），不是公布入围（20:30）：中间那半小时阶段还是
 * screening，但票已经投不动、名单已经自动定了。评委这时点「去打分」应该
 * 看到入围作品，而不是一页按不动的票。
 */

const config = {
  deadlines: {
    screeningVote: '2026-10-19T20:00:00+08:00',
    screening: '2026-10-19T20:30:00+08:00',
  },
};
const at = (hm: string) => new Date(`2026-10-19T${hm}:00+08:00`).toISOString();

describe('judgeOnScoring', () => {
  it('报名期：还在看创意', () => {
    expect(judgeOnScoring({ phase: 'signup', now: at('17:00'), config })).toBe(false);
  });

  it('初筛投票没封：投票页', () => {
    expect(judgeOnScoring({ phase: 'screening', now: at('19:59'), config })).toBe(false);
  });

  it('封票后、公布前：已经是打分页', () => {
    expect(judgeOnScoring({ phase: 'screening', now: at('20:00'), config })).toBe(true);
    expect(judgeOnScoring({ phase: 'screening', now: at('20:20'), config })).toBe(true);
  });

  it('入围制作、路演：打分页', () => {
    expect(judgeOnScoring({ phase: 'building', now: at('21:00'), config })).toBe(true);
    expect(judgeOnScoring({ phase: 'demo', now: at('21:00'), config })).toBe(true);
  });

  it('老配置没有 screeningVote：整个 screening 都还是投票页', () => {
    expect(judgeOnScoring({ phase: 'screening', now: at('23:00'), config: { deadlines: {} } })).toBe(false);
  });
});
