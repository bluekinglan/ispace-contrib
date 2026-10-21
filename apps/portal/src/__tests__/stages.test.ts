import { describe, expect, it } from 'vitest';
import { STAGES, stageDetail, stageOf, type Step } from '../workbench';

/**
 * 稿上那四步作为「真实事件的分组标签」的那套判定。
 *
 * ┌─ 这一组真正要守的是什么 ────────────────────────────────────────────┐
 * │ 不是"分组分得好不好看"，是**不许把四步变回一条和模型无关的进度条**。 │
 * │ 稿里原本是 `step > i` 就打勾——那跟模型在做什么没有关系。所以这里  │
 * │ 钉死两条：每个工具都有确定的归属；没发生过的步不出现。              │
 * └──────────────────────────────────────────────────────────────────────┘
 */
describe('四步分组', () => {
  const step = (key: string, done = true): Step => ({ key, title: key, detail: '', done });

  it('每个工具都归得进去，没有漏网的', () => {
    const tools = [
      'ask_user', 'list_files', 'read_file', 'search_files', 'list_apps', 'get_quota',
      'write_file', 'edit_file', 'copy_file', 'delete_file', 'generate_image',
      'check_publishable', 'screenshot_preview', 'request_deploy',
    ];
    for (const t of tools) {
      expect(STAGES.map((s) => s.key)).toContain(stageOf(t));
    }
  });

  it('认不出来的工具归「写页面」，不会凭空多出一步', () => {
    // 将来加了新工具、忘了登记，它也该落在干活那一档，而不是消失
    expect(stageOf('some_future_tool')).toBe('write');
  });

  it('读文件、问你归「理解需求」；写改文件归「写页面」；自检发布归「发布前检查」', () => {
    expect(stageOf('read_file')).toBe('understand');
    expect(stageOf('ask_user')).toBe('understand');
    expect(stageOf('write_file')).toBe('write');
    expect(stageOf('edit_file')).toBe('write');
    expect(stageOf('check_publishable')).toBe('check');
    expect(stageOf('request_deploy')).toBe('check');
  });

  it('「设计数据表」今天没有任何工具——它不会亮，但位置留着', () => {
    /*
      平台没有建表的工具，页面是直接走 PostgREST 读写自己 schema 的。
      所以这一步今天归不进任何事件，按规矩就不出现；将来真有了那样的
      工具，往 tools 里加个名字它自己就会亮。
    */
    const data = STAGES.find((s) => s.key === 'data');
    expect(data).toBeDefined();
    expect(data?.tools).toEqual([]);
  });

  it('小字只数真调了几次，不说平台不知道的事', () => {
    const detail = stageDetail([step('read_file'), step('read_file'), step('ask_user')]);
    expect(detail).toBe('读文件 2 · 问你 1');
    // 没调过的工具不出现在小字里
    expect(detail).not.toContain('新文件');
  });

  it('一步里什么都没有时小字是空的，不是「0 个文件」', () => {
    expect(stageDetail([])).toBe('');
  });

  it('只按真实事件分组：没发生过的步不该被凑出来', () => {
    /* 组件里的过滤是 items.length > 0；这里钉住它依赖的那份数据是对的 */
    const steps = [step('read_file'), step('write_file')];
    const live = STAGES
      .map((st) => ({ key: st.key, items: steps.filter((x) => stageOf(x.key) === st.key) }))
      .filter((g) => g.items.length > 0)
      .map((g) => g.key);
    expect(live).toEqual(['understand', 'write']);   // 没有 data，也没有 check
  });
});
