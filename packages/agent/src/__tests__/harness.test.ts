import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatPublishCheck, runTool, runToolOutput, SCREENSHOT_TOOL, toolsFor,
  type PublishCheck, type ToolContext,
} from '../tools.js';
import { Snapshots } from '../snapshots.js';
import { compact, measure, SUMMARY_MARK } from '../compact.js';
import type { EngineMessage } from '../engine.js';

/**
 * 补给 harness 的几样东西：补丁式编辑、搜索、发布前自检、截图、快照、上下文压缩。
 * 会话循环那一侧（截图回灌、压缩接入）的用例在 agent.test.ts 里。
 */

const ws = () => {
  const root = mkdtempSync(join(tmpdir(), 'ispace-harness-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'index.html'), [
    '<!doctype html>',
    '<div class="card">一</div>',
    '<div class="card">二</div>',
    '<h1 class="title">周报</h1>',
    '<script src="./src/app.js"></script>',
  ].join('\n'));
  writeFileSync(join(root, 'src', 'app.js'), 'const list = document.querySelector(".list");\nlist.innerHTML = data;\n');
  return { root, username: 'lixiao' };
};

const basePlatform: ToolContext['platform'] = {
  getQuota: async () => '',
  listApps: async () => '',
  requestDeploy: async () => ({ confirmToken: 'tok-1' }),
};
const ctxOf = (w = ws(), platform: Partial<ToolContext['platform']> = {}): ToolContext =>
  ({ ws: w, platform: { ...basePlatform, ...platform } });

describe('edit_file：只改那一处，别处不动', () => {
  it('唯一命中就替换，回一小段带行号的结果供模型确认', async () => {
    const c = ctxOf();
    const out = await runTool(c, 'edit_file', {
      path: 'index.html', old_string: '<h1 class="title">周报</h1>', new_string: '<h1 class="title big">周报</h1>',
    });
    expect(out).toContain('替换 1 处');
    expect(out).toContain('第 4 行');
    expect(out).toMatch(/\s4 {2}<h1 class="title big">/);
    const text = readFileSync(join(c.ws.root, 'index.html'), 'utf8');
    expect(text).toContain('title big');
    expect(text).toContain('<div class="card">一</div>'); // 别处原样
  });

  it('出现多次就报错并给出行号，不替它猜改哪一处', async () => {
    const c = ctxOf();
    await expect(runTool(c, 'edit_file', {
      path: 'index.html', old_string: '<div class="card">', new_string: '<div class="card x">',
    })).rejects.toThrow(/出现了 2 次（第 2、3 行）/);
    expect(readFileSync(join(c.ws.root, 'index.html'), 'utf8')).not.toContain('card x');
  });

  it('replace_all 时全部替换', async () => {
    const c = ctxOf();
    const out = await runTool(c, 'edit_file', {
      path: 'index.html', old_string: 'class="card"', new_string: 'class="tile"', replace_all: true,
    });
    expect(out).toContain('替换 2 处');
    expect(readFileSync(join(c.ws.root, 'index.html'), 'utf8')).not.toContain('class="card"');
  });

  it('只差空白时说清楚是缩进对不上', async () => {
    await expect(runTool(ctxOf(), 'edit_file', {
      path: 'index.html', old_string: '<h1   class="title">周报</h1>', new_string: 'x',
    })).rejects.toThrow(/空白差异/);
  });

  it('第一行对得上、后面对不上时指出在第几行', async () => {
    await expect(runTool(ctxOf(), 'edit_file', {
      path: 'index.html', old_string: '<h1 class="title">周报</h1>\n<p>不存在的一行</p>', new_string: 'x',
    })).rejects.toThrow(/第 4 行/);
  });

  it('文件不存在时指向 write_file；old 与 new 相同时拒绝；越界路径拒绝', async () => {
    expect(await runTool(ctxOf(), 'edit_file', { path: 'nope.html', old_string: 'a', new_string: 'b' }))
      .toContain('write_file');
    await expect(runTool(ctxOf(), 'edit_file', { path: 'index.html', old_string: 'a', new_string: 'a' }))
      .rejects.toThrow(/一模一样/);
    await expect(runTool(ctxOf(), 'edit_file', { path: '../x.html', old_string: 'a', new_string: 'b' }))
      .rejects.toThrow(/越界/);
  });
});

describe('search_files：先找到再改', () => {
  it('返回 文件:行号: 片段', async () => {
    const out = await runTool(ctxOf(), 'search_files', { pattern: 'innerHTML\\s*=' });
    expect(out).toBe('src/app.js:2: list.innerHTML = data;');
  });

  it('include 只搜匹配的文件名，ignore_case 生效', async () => {
    const c = ctxOf();
    expect(await runTool(c, 'search_files', { pattern: 'CARD', include: '*.js', ignore_case: true }))
      .toContain('没有匹配');
    expect(await runTool(c, 'search_files', { pattern: 'CARD', include: '*.{html,css}', ignore_case: true }))
      .toContain('index.html:2:');
  });

  it('默认跳过 node_modules 与 _ 开头的平台草稿，显式指定 path 时照搜', async () => {
    const c = ctxOf();
    mkdirSync(join(c.ws.root, 'node_modules'));
    writeFileSync(join(c.ws.root, 'node_modules', 'x.js'), 'needle');
    mkdirSync(join(c.ws.root, '_fanout', 'a'), { recursive: true });
    writeFileSync(join(c.ws.root, '_fanout', 'a', 'index.html'), 'needle');
    expect(await runTool(c, 'search_files', { pattern: 'needle' })).toContain('没有匹配');
    expect(await runTool(c, 'search_files', { pattern: 'needle', path: '_fanout' }))
      .toContain('_fanout/a/index.html:1:');
  });

  it('结果有上限，超了提示缩小范围', async () => {
    const c = ctxOf();
    writeFileSync(join(c.ws.root, 'big.txt'), Array.from({ length: 200 }, (_, i) => `hit ${i}`).join('\n'));
    const out = await runTool(c, 'search_files', { pattern: '^hit' });
    expect(out.split('\n').filter((l) => l.startsWith('big.txt:'))).toHaveLength(80);
    expect(out).toContain('共 200 处');
  });

  it('拒绝会灾难性回溯的嵌套量词，正则写错给出原因', async () => {
    await expect(runTool(ctxOf(), 'search_files', { pattern: '(a+)+$' })).rejects.toThrow(/嵌套量词/);
    await expect(runTool(ctxOf(), 'search_files', { pattern: '(unclosed' })).rejects.toThrow(/正则写错了/);
  });
});

describe('copy_file：把附件拷进页面', () => {
  it('二进制原样拷过去，父目录自动建', async () => {
    const c = ctxOf();
    mkdirSync(join(c.ws.root, '_uploads'));
    writeFileSync(join(c.ws.root, '_uploads', 'p.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
    const out = await runTool(c, 'copy_file', { from: '_uploads/p.png', to: 'assets/img/p.png' });
    expect(out).toContain('已把 _uploads/p.png 拷到 assets/img/p.png');
    expect([...readFileSync(join(c.ws.root, 'assets', 'img', 'p.png'))]).toEqual([0x89, 0x50, 0, 1, 2]);
  });

  it('两头都过 safePath，源不存在给一句话', async () => {
    await expect(runTool(ctxOf(), 'copy_file', { from: '../../etc/passwd', to: 'x' })).rejects.toThrow(/越界/);
    await expect(runTool(ctxOf(), 'copy_file', { from: 'index.html', to: '../out.html' })).rejects.toThrow(/越界/);
    expect(await runTool(ctxOf(), 'copy_file', { from: 'nope.png', to: 'a.png' })).toContain('不存在');
  });
});

describe('发布前自检', () => {
  const dirty: PublishCheck = {
    findings: [{ file: 'src/app.js', line: 2, rule: 'innerHTML-from-variable', advice: '纯文字用 textContent' }],
  };

  it('命中项按 文件:行号:规则:建议 列出', () => {
    const out = formatPublishCheck(dirty);
    expect(out).toContain('src/app.js:2:innerHTML-from-variable:纯文字用 textContent');
    expect(out).toContain('再调一次 check_publishable');
  });

  it('干净时明说可以发布；认不出产物时转述原因', () => {
    expect(formatPublishCheck({ findings: [] })).toContain('可以 request_deploy');
    expect(formatPublishCheck({ findings: [], error: '产物根目录下没有 index.html' })).toContain('没有 index.html');
  });

  it('平台没接自检时不报错，说一句发布时仍会扫描', async () => {
    expect(await runTool(ctxOf(), 'check_publishable', {})).toContain('发布时仍会扫描');
  });

  it('request_deploy 时自检没过就不签令牌——提示会被忘，这一道不会', async () => {
    const requestDeploy = vi.fn(async () => ({ confirmToken: 'should-not-issue' }));
    const c = ctxOf(ws(), { requestDeploy, checkPublishable: async () => dirty });
    const out = await runTool(c, 'request_deploy', { site: 'tianqi', summary: '天气页' });
    expect(out).toContain('发布请求没有提交');
    expect(out).toContain('innerHTML-from-variable');
    expect(out).not.toContain('should-not-issue');
    expect(requestDeploy).not.toHaveBeenCalled();
  });

  it('自检干净时照常签令牌', async () => {
    const c = ctxOf(ws(), { checkPublishable: async () => ({ findings: [] }) });
    expect(await runTool(c, 'request_deploy', { site: 'tianqi', summary: '天气页' })).toContain('tok-1');
  });
});

describe('screenshot_preview', () => {
  it('截到的图随结果带回，文字说明盲区', async () => {
    const shoot = vi.fn(async () => ({ mimeType: 'image/png', dataBase64: 'iVBOR' }));
    const out = await runToolOutput(ctxOf(ws(), { screenshot: shoot }), 'screenshot_preview', { device: 'pc' });
    expect(shoot).toHaveBeenCalledWith({ path: 'index.html', device: 'pc' });
    expect(out.images).toEqual([{ mimeType: 'image/png', dataBase64: 'iVBOR' }]);
    expect(out.text).toContain('1280×800');
    expect(out.text).toContain('盲区');
  });

  it('没有截图器、文件不存在时都给一句话，不抛', async () => {
    expect((await runToolOutput(ctxOf(), 'screenshot_preview', {})).text).toContain('截不了图');
    const shoot = vi.fn();
    const out = await runToolOutput(ctxOf(ws(), { screenshot: shoot }), 'screenshot_preview', { path: 'nope.html' });
    expect(out.text).toContain('不存在');
    expect(shoot).not.toHaveBeenCalled();
  });

  it('只有平台能截图时才挂这个工具', () => {
    expect(toolsFor().map((t) => t.name)).not.toContain(SCREENSHOT_TOOL.name);
    expect(toolsFor({ canSee: true }).map((t) => t.name)).toContain(SCREENSHOT_TOOL.name);
    expect(toolsFor({ canSee: true }).map((t) => t.name)).not.toContain('generate_image');
    expect(toolsFor().map((t) => t.name)).toEqual(expect.arrayContaining(['edit_file', 'search_files', 'copy_file', 'check_publishable']));
  });
});

describe('快照与撤回', () => {
  const setup = () => {
    const w = ws();
    const store = mkdtempSync(join(tmpdir(), 'ispace-snap-'));
    return { w, store, snaps: new Snapshots(store, w.root) };
  };

  it('撤回把改过的、新增的、删掉的文件都退回拍照时的样子', async () => {
    const { w, snaps } = setup();
    const s = await snaps.take({ sessionId: 's1', messageCount: 3, label: '改标题' });
    writeFileSync(join(w.root, 'index.html'), '<h1>改坏了</h1>');
    mkdirSync(join(w.root, 'assets'));
    writeFileSync(join(w.root, 'assets', 'new.css'), 'body{}');
    writeFileSync(join(w.root, 'src', 'app.js'), '');
    const { rmSync } = await import('node:fs');
    rmSync(join(w.root, 'src', 'app.js'));

    const r = await snaps.restore(s.seq);
    expect(readFileSync(join(w.root, 'index.html'), 'utf8')).toContain('周报');
    expect(readFileSync(join(w.root, 'src', 'app.js'), 'utf8')).toContain('innerHTML');
    expect(existsSync(join(w.root, 'assets'))).toBe(false); // 新增的文件连同空目录一起收掉
    expect(r).toEqual({ written: 2, removed: 1 });
  });

  it('平台草稿不进快照，撤回也不碰它', async () => {
    const { w, snaps } = setup();
    const s = await snaps.take({ sessionId: 's1', messageCount: 0, label: '' });
    mkdirSync(join(w.root, '_fanout'));
    writeFileSync(join(w.root, '_fanout', 'a.html'), '六版之一');
    await snaps.restore(s.seq);
    expect(existsSync(join(w.root, '_fanout', 'a.html'))).toBe(true);
  });

  it('没变的文件所有快照共用一份 blob', async () => {
    const { w, store, snaps } = setup();
    await snaps.take({ sessionId: 's1', messageCount: 0, label: 'a' });
    await snaps.take({ sessionId: 's1', messageCount: 2, label: 'b' });
    writeFileSync(join(w.root, 'index.html'), 'v2');
    await snaps.take({ sessionId: 's1', messageCount: 4, label: 'c' });
    expect(readdirSync(join(store, 'blobs'))).toHaveLength(3); // index v1、app.js、index v2
  });

  it('按会话找最近一张；用掉就删，下一次撤回再往前退一步', async () => {
    const { snaps } = setup();
    await snaps.take({ sessionId: 's1', messageCount: 0, label: '第一句' });
    await snaps.take({ sessionId: 's2', messageCount: 0, label: '别的会话' });
    const b = await snaps.take({ sessionId: 's1', messageCount: 2, label: '第二句' });
    expect((await snaps.lastFor('s1'))?.label).toBe('第二句');
    await snaps.drop(b.seq);
    expect((await snaps.lastFor('s1'))?.label).toBe('第一句');
  });

  it('只留最近 keep 张，没人引用的 blob 一并清掉', async () => {
    const w = ws();
    const store = mkdtempSync(join(tmpdir(), 'ispace-snap-'));
    const snaps = new Snapshots(store, w.root, 2);
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(w.root, 'index.html'), `v${i}`);
      await snaps.take({ sessionId: 's', messageCount: i, label: String(i) });
    }
    expect((await snaps.list()).map((m) => m.label)).toEqual(['2', '3']);
    expect(readdirSync(join(store, 'blobs'))).toHaveLength(3); // v2、v3、app.js
  });
});

describe('上下文压缩', () => {
  const page = 'x'.repeat(5000);
  /** 一轮：用户说一句 → 模型写一整页 → 工具结果 → 模型读回来 → 结果 → 收尾。 */
  const turn = (i: number): EngineMessage[] => [
    { role: 'user', content: `第 ${i} 句` },
    { role: 'assistant', content: '', toolCalls: [{ id: `w${i}`, name: 'write_file', arguments: { path: 'index.html', content: page } }] },
    { role: 'tool', content: '已写入', toolCallId: `w${i}` },
    { role: 'assistant', content: '', toolCalls: [{ id: `r${i}`, name: 'read_file', arguments: { path: 'index.html' } }] },
    { role: 'tool', content: page, toolCallId: `r${i}` },
    { role: 'assistant', content: `改好了 ${i}` },
  ];
  const history = (n: number): EngineMessage[] => [
    { role: 'system', content: '系统提示' },
    ...Array.from({ length: n }, (_, i) => turn(i + 1)).flat(),
  ];

  /** 工具调用和它的结果不能被拆开——网关见到孤立的 tool 消息会 400。 */
  const paired = (ms: EngineMessage[]) => {
    const open = new Set<string>();
    for (const m of ms) {
      for (const c of m.toolCalls ?? []) open.add(c.id);
      if (m.role === 'tool' && !open.has(m.toolCallId!)) return false;
    }
    return true;
  };

  it('没超预算就原样返回——一个字节都不动，提示缓存才命中得上', async () => {
    const h = history(2);
    const r = await compact(h, { budgetChars: 1_000_000 });
    expect(r.stage).toBe(0);
    expect(r.messages).toBe(h);
  });

  it('第 1 级只裁早先的轮次：大段参数与工具结果换成说明，最近两轮原样', async () => {
    const h = history(6);
    const r = await compact(h, { budgetChars: 30_000 });
    expect(r.stage).toBe(1);
    expect(r.after).toBeLessThanOrEqual(30_000);
    expect(r.messages[0]).toEqual(h[0]); // system 不动
    const old = r.messages.find((m) => m.toolCalls?.[0]?.id === 'w1')!;
    expect(String(old.toolCalls![0]!.arguments.content)).toContain('已略去 5000 字');
    expect(r.messages.find((m) => m.toolCallId === 'r1')!.content).toContain('已从上下文裁掉');
    const recent = r.messages.find((m) => m.toolCalls?.[0]?.id === 'w6')!;
    expect(recent.toolCalls![0]!.arguments.content).toBe(page);
    expect(paired(r.messages)).toBe(true);
  });

  it('裁完还超就写摘要，替换掉更早的原文', async () => {
    const summarize = vi.fn(async () => '用户要做周报页，已经写了 index.html。');
    const r = await compact(history(6), { budgetChars: 21_000, summarize });
    expect(r.stage).toBe(2);
    expect(summarize).toHaveBeenCalledOnce();
    expect(r.messages[1]!.content.startsWith(SUMMARY_MARK)).toBe(true);
    expect(r.messages[1]!.content).toContain('周报页');
    expect(r.messages.some((m) => m.content === '第 1 句')).toBe(false);
    expect(r.messages.some((m) => m.content === '第 6 句')).toBe(true);
    expect(paired(r.messages)).toBe(true);
  });

  it('摘要失败就整轮丢掉最早的，留一句说明——宁可忘掉开头也不能让这一轮失败', async () => {
    const r = await compact(history(6), {
      budgetChars: 21_000,
      summarize: async () => { throw new Error('网关 502'); },
    });
    expect(r.stage).toBe(3);
    expect(r.after).toBeLessThanOrEqual(21_000);
    expect(r.messages[1]!.content).toContain('已经丢掉了');
    expect(r.messages.some((m) => m.content === '第 6 句')).toBe(true);
    expect(paired(r.messages)).toBe(true);
  });

  it('图片按固定成本估，被裁掉时留一句话', async () => {
    const withImg: EngineMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: '看这张', images: [{ mimeType: 'image/png', dataBase64: 'a' }] },
      { role: 'assistant', content: 'ok' },
      ...turn(2), ...turn(3),
    ];
    expect(measure([withImg[1]!])).toBeGreaterThan(3000);
    const r = await compact(withImg, { budgetChars: 22_000 });
    expect(r.messages[1]!.images).toBeUndefined();
    expect(r.messages[1]!.content).toContain('原本附了 1 张图');
  });
});
