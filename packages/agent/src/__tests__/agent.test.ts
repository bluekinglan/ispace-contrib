import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSession, buildSystemPrompt, type AvailableConnector } from '../session.js';
import { parseAsk, runTool, safePath, type ToolContext } from '../tools.js';
import { DESIGN_DIRECTIONS, fanoutCount, runFanout, variantDirections } from '../fanout.js';
import { configuredImageModels, createImageGenerator } from '../image.js';
import {
  configuredModels, createEngine, effortEnabled, numEnv,
  type Engine, type EngineEvent, type EngineMessage, type ToolCall,
} from '../engine.js';

const ws = () => {
  const root = mkdtempSync(join(tmpdir(), 'ispace-ws-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)');
  return { root, username: 'lixiao' };
};

const platform: ToolContext['platform'] = {
  getQuota: async () => '静态空间 1 MB / 500 MB',
  listApps: async () => 'zhoubao (running)',
  requestDeploy: async () => ({ confirmToken: 'tok-123' }),
};

describe('工作区边界——整个工具集的安全边界', () => {
  it('拒绝 ../ 越界', () => {
    const w = ws();
    expect(() => safePath(w, '../../etc/passwd')).toThrow(/越界/);
  });

  it('拒绝绝对路径', () => {
    const w = ws();
    expect(() => safePath(w, '/etc/passwd')).toThrow(/越界/);
  });

  it('拒绝绕一圈回到外面', () => {
    const w = ws();
    expect(() => safePath(w, 'src/../../../tmp')).toThrow(/越界/);
  });

  it('放行区内路径', () => {
    const w = ws();
    expect(safePath(w, 'src/app.js')).toBe(join(w.root, 'src/app.js'));
    expect(safePath(w, './index.html')).toBe(join(w.root, 'index.html'));
  });
});

describe('文件工具', () => {
  it('读写删都在区内生效', async () => {
    const w = ws();
    const ctx: ToolContext = { ws: w, platform };
    expect(await runTool(ctx, 'read_file', { path: 'index.html' })).toContain('hi');
    await runTool(ctx, 'write_file', { path: 'src/new.js', content: 'export const x=1' });
    expect(readFileSync(join(w.root, 'src/new.js'), 'utf8')).toBe('export const x=1');
    await runTool(ctx, 'delete_file', { path: 'src/new.js' });
    expect(existsSync(join(w.root, 'src/new.js'))).toBe(false);
  });

  it('列目录跳过 node_modules 与隐藏文件', async () => {
    const w = ws();
    mkdirSync(join(w.root, 'node_modules'));
    writeFileSync(join(w.root, '.env'), 'SECRET=x');
    const out = await runTool({ ws: w, platform }, 'list_files', {});
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.env');
    expect(out).toContain('index.html');
  });

  it('读不存在的文件返回提示而非抛错——模型据此改正是正常流程', async () => {
    const out = await runTool({ ws: ws(), platform }, 'read_file', { path: 'nope.js' });
    expect(out).toContain('不存在');
  });
});

describe('发布必须经二次确认', () => {
  it('request_deploy 只返回待确认令牌，不直接发布', async () => {
    const out = await runTool({ ws: ws(), platform }, 'request_deploy', {
      site: 'zhoubao', summary: '改了标题',
    });
    expect(out).toContain('等待用户在手机上二次确认');
    expect(out).toContain('tok-123');
    expect(out).toContain('不由你决定');
  });
});

/** 假引擎：按脚本产出事件，不碰网络。 */
class ScriptedEngine implements Engine {
  readonly name = 'scripted';
  readonly model = 'test';
  constructor(private readonly script: EngineEvent[][]) {}
  private turn = 0;
  async *run(): AsyncGenerator<EngineEvent> {
    const evs = this.script[this.turn++] ?? [{ type: 'done' as const }];
    for (const e of evs) yield e;
  }
}

const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: `c-${name}`, name, arguments: args });

describe('会话循环', () => {
  it('无工具调用即视为说完', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([[{ type: 'text', delta: '好的' }, { type: 'done' }]]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('你好');
    expect(r.stopReason).toBe('complete');
    expect(r.turns).toBe(1);
  });

  /*
    工作台的输入框里能换模型。原来会话只在创建时拿一次引擎，之后追问带来的
    model 被悄悄丢掉——界面上换了，跑的还是开场那个。
  */
  it('换了引擎，下一轮就用新的，对话历史接着用', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([[{ type: 'text', delta: '甲说' }, { type: 'done' }]]),
      toolCtx: { ws: ws(), platform },
    });
    await s.send('第一句');
    s.useEngine(new ScriptedEngine([[{ type: 'text', delta: '乙说' }, { type: 'done' }]]));
    await s.send('第二句');
    const said = s.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(said).toEqual(['甲说', '乙说']);
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('工具结果回灌后继续下一轮', async () => {
    const w = ws();
    const s = new AgentSession({
      engine: new ScriptedEngine([
        [{ type: 'tool_call', call: call('read_file', { path: 'index.html' }) }, { type: 'done' }],
        [{ type: 'text', delta: '读到了' }, { type: 'done' }],
      ]),
      toolCtx: { ws: w, platform },
    });
    const r = await s.send('看看首页');
    expect(r.stopReason).toBe('complete');
    expect(r.turns).toBe(2);
    // tool 结果确实进了对话历史
    expect(s.messages.some((m) => m.role === 'tool' && m.content.includes('hi'))).toBe(true);
  });

  it('轮次上限到达时明确告知，不假装完成', async () => {
    // 一个永远调工具的模型——没有上限就是能烧光配额的死循环
    const loop: EngineEvent[] = [
      { type: 'tool_call', call: call('list_files', {}) },
      { type: 'done' },
    ];
    const s = new AgentSession({
      engine: new ScriptedEngine(Array.from({ length: 20 }, () => loop)),
      toolCtx: { ws: ws(), platform },
      maxTurns: 3,
    });
    const r = await s.send('一直看');
    expect(r.stopReason).toBe('max_turns');
    expect(r.turns).toBe(3);
  });

  it('工具失败回灌给模型而非中断会话', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([
        [{ type: 'tool_call', call: call('write_file', { path: '../evil', content: 'x' }) }, { type: 'done' }],
        [{ type: 'text', delta: '换个路径' }, { type: 'done' }],
      ]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('写文件');
    expect(r.stopReason).toBe('complete');
    expect(s.messages.some((m) => m.role === 'tool' && m.content.includes('越界'))).toBe(true);
  });

  it('引擎报错时中止并标记 error', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([[{ type: 'error', message: '模型不可达' }]]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('你好');
    expect(r.stopReason).toBe('error');
  });
});

/**
 * 系统提示里的连接器清单。
 *
 * 这几条测的不是字符串拼接，是「模型会不会去编一个域名」这件事——
 * 有清单时它该看见调用方式和响应结构，没清单时该被明确告知别自己编。
 */
describe('buildSystemPrompt 里的可用连接器', () => {
  const one: AvailableConnector = {
    slug: 'open-meteo', name: '天气预报', what: '任意经纬度的实况与未来天气',
    example: '/forecast?latitude=39.9&longitude=116.4&current=temperature_2m',
    returns: 'data.current.temperature_2m → 摄氏度数字',
    scope: 'personal',
  };

  it('把调用地址拼成同源相对路径，模型照抄即可', () => {
    const p = buildSystemPrompt([one]);
    expect(p).toContain("fetch('/deploy/api/connect/open-meteo/forecast?latitude=39.9");
  });

  it('带上响应结构——少了它模型只能猜取值路径', () => {
    expect(buildSystemPrompt([one])).toContain('data.current.temperature_2m');
  });

  it('三态各自标出来——个人与另外两者的区别有实际后果', () => {
    expect(buildSystemPrompt([{ ...one, scope: 'shared' }])).toContain('（全员共享）');
    expect(buildSystemPrompt([{ ...one, scope: 'builtin' }])).toContain('（平台内置）');
    expect(buildSystemPrompt([one])).toContain('（仅你自己）');
  });

  it('有个人连接器才警告"分享给同事会空白"，没有就不啰嗦', () => {
    expect(buildSystemPrompt([one])).toContain('只在你自己打开页面时有效');
    expect(buildSystemPrompt([{ ...one, scope: 'builtin' }]))
      .not.toContain('只在你自己打开');
  });

  it('一条都没有时，明确禁止自己编域名，而不是留白', () => {
    const p = buildSystemPrompt([]);
    expect(p).toMatch(/不要凭记忆写一个第三方\s*\n?API 地址/);
    expect(p).toContain('还没有可用的连接器');
  });

  it('有清单时同样禁止硬套最接近的那条', () => {
    expect(buildSystemPrompt([one])).toContain('不要硬套一个最接近的');
  });

  it('原有的平台约束不能被挤掉', () => {
    for (const p of [buildSystemPrompt([]), buildSystemPrompt([one])]) {
      expect(p).toContain('不得引入新的原生依赖');
      expect(p).toContain('不要把密钥硬编码进代码');
    }
  });
});

describe('平台给了几个模型可选', () => {
  const base = { AGENT_BASE_URL: 'https://gw.example/v1', AGENT_API_KEY: 'k' };

  it('没配 AGENT_MODELS 就只有默认那一个', () => {
    expect(configuredModels({ AGENT_MODEL: 'gpt-5.6' })).toEqual([
      { id: 'gpt-5.6', label: 'gpt-5.6' },
    ]);
  });

  it('按 id|名字|倍率 解析，倍率可省', () => {
    expect(configuredModels({ AGENT_MODELS: 'a|甲|0.4x, b|乙, c' })).toEqual([
      { id: 'a', label: '甲', mult: '0.4x' },
      { id: 'b', label: '乙' },
      { id: 'c', label: 'c' },
    ]);
  });

  it('配歪了退回默认那个，而不是给一张空菜单', () => {
    expect(configuredModels({ AGENT_MODEL: 'gpt-5.6', AGENT_MODELS: ' | | ' })).toEqual([
      { id: 'gpt-5.6', label: 'gpt-5.6' },
    ]);
  });

  it('选单子里的那个就用那个', () => {
    const env = { ...base, AGENT_MODELS: 'a|甲, b|乙' };
    expect(createEngine(env, { model: 'b' }).model).toBe('b');
  });

  /*
    model 是直接发给网关的字段。不在白名单里就按默认来，而不是原样转发——
    转发等于把「用哪个模型」的开关交给任何会发 HTTP 的人，而这几条通道是
    管理员配的，不是用户能添的。
  */
  it('选单子外的东西就按默认来', () => {
    const env = { ...base, AGENT_MODELS: 'a|甲, b|乙' };
    expect(createEngine(env, { model: 'gpt-9-不在单子里' }).model).toBe('a');
    expect(createEngine(env, {}).model).toBe('a');
  });

  it('思考档位要平台开了才算数', () => {
    expect(effortEnabled({})).toBe(false);
    expect(effortEnabled({ AGENT_EFFORT: '1' })).toBe(true);
    /* 没开的时候前端照样可能传——不报错，只是不往网关发 */
    expect(() => createEngine(base, { effort: 'high' })).not.toThrow();
  });
});

/**
 * 「用户正看着预览」那一段只在真有预览时才说。
 *
 * 这段提示和手机壳那条流共用同一份基础提示，而手机壳没有预览。写死就等于
 * 对一半的会话说了句假话——模型会按"他正看着"去安排顺序，甚至回话里提
 * 「你右边应该已经能看到了」，而那边根本没有那块东西。
 */
describe('实时预览那段提示的开关', () => {
  const none: AvailableConnector[] = [];

  it('没有预览时一个字都不提', () => {
    const p = buildSystemPrompt(none);
    expect(p).not.toContain('正看着预览');
    expect(p).not.toContain('index.html');
  });

  it('不传参数等同于没有预览——手机壳走的就是这一支', () => {
    expect(buildSystemPrompt(none)).toBe(buildSystemPrompt(none, {}));
    expect(buildSystemPrompt(none, { livePreview: false })).toBe(buildSystemPrompt(none));
  });

  it('有预览时才告诉它：先写 index.html、错误会回来找它', () => {
    const p = buildSystemPrompt(none, { livePreview: true });
    expect(p).toContain('正看着预览');
    expect(p).toContain('先把 index.html 写出来');
    expect(p).toContain('回到这个对话里来找你改');
  });

  it('开关不影响连接器那一段——两件事互不干扰', () => {
    const one: AvailableConnector[] = [{
      slug: 'open-meteo', name: '天气', what: '查天气',
      example: '/v1/forecast', returns: '{current:{...}}', scope: 'builtin',
    }];
    expect(buildSystemPrompt(one, { livePreview: true })).toContain('open-meteo');
    expect(buildSystemPrompt(one, { livePreview: true })).toContain('正看着预览');
  });
});

describe('问清楚再动手', () => {
  const askArgs = {
    question: '数据从哪来？',
    options: [
      { label: '我手填', hint: '先做个空表', recommended: true },
      { label: '接飞书表格' },
    ],
  };

  it('ask_user 把一轮停在"等人回答"，而不是接着往下写', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([
        [{ type: 'tool_call', call: call('ask_user', askArgs) }, { type: 'done' }],
        /* 真跑到第二轮就说明没停住——那一轮会接着写文件 */
        [{ type: 'tool_call', call: call('write_file', { path: 'index.html', content: 'x' }) }, { type: 'done' }],
      ]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('做个周报收集页');
    expect(r.stopReason).toBe('ask');
    expect(r.turns).toBe(1);
    /* 问题进了历史：下一轮模型看得到自己问过什么 */
    expect(s.messages.some((m) => m.role === 'tool' && m.content.includes('等他回答'))).toBe(true);
  });

  it('同一轮里既问又改，改的那几下照样执行，只是不再要下一次模型输出', async () => {
    const w = ws();
    const s = new AgentSession({
      engine: new ScriptedEngine([[
        { type: 'tool_call', call: call('write_file', { path: 'a.txt', content: '1' }) },
        { type: 'tool_call', call: call('ask_user', askArgs) },
        { type: 'done' },
      ]]),
      toolCtx: { ws: w, platform },
    });
    const r = await s.send('做个页面');
    expect(r.stopReason).toBe('ask');
    expect(existsSync(join(w.root, 'a.txt'))).toBe(true);
  });

  it('问题不成形就不算问过——模型得自己定，或者补全再问', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([
        [{ type: 'tool_call', call: call('ask_user', { question: '随便问问' }) }, { type: 'done' }],
        [{ type: 'text', delta: '那我自己定了' }, { type: 'done' }],
      ]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('做个页面');
    expect(r.stopReason).toBe('complete');
    expect(r.turns).toBe(2);
  });

  it('parseAsk 只认有问题且至少两个选项的', () => {
    expect(parseAsk(askArgs)?.options).toHaveLength(2);
    expect(parseAsk({ question: '只有一个', options: [{ label: 'a' }] })).toBeNull();
    expect(parseAsk({ options: askArgs.options })).toBeNull();
    /* 多给的丢掉，没名字的也丢掉 */
    const many = parseAsk({
      question: 'q',
      options: [{ label: 'a' }, { label: '' }, { label: 'c' }, { label: 'd' }, { label: 'e' }, { label: 'f' }],
    });
    expect(many?.options.map((o) => o.label)).toEqual(['a', 'c', 'd']);
  });
});

describe('设计扇出', () => {
  const dirs = DESIGN_DIRECTIONS.slice(0, 2);
  const writes = (rel: string) => new ScriptedEngine([
    [{ type: 'tool_call', call: call('write_file', { path: rel, content: '<h1>x</h1>' }) }, { type: 'done' }],
    [{ type: 'text', delta: '好了' }, { type: 'done' }],
  ]);

  it('每个方向各写一个文件，事件按方向报进度', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ispace-fan-'));
    const events: string[] = [];
    /* 每个方向的引擎各写各的路径：按方向对号，不按调用次序（并行，次序不定） */
    const r = await runFanout({
      engine: (d) => writes(`out/${d.key}/index.html`),
      workspaceRoot: root,
      outRel: 'out',
      prompt: '做个排班表',
      device: 'phone',
      dirs,
      onEvent: (e) => events.push(e.type),
    });

    expect(r).toEqual({ ok: 2, failed: 0 });
    for (const d of dirs) {
      expect(existsSync(join(root, 'out', d.key, 'index.html'))).toBe(true);
    }
    expect(events.filter((t) => t === 'dir_start')).toHaveLength(2);
    expect(events.filter((t) => t === 'dir_done')).toHaveLength(2);
    expect(events[events.length - 1]).toBe('all_done');
  });

  it('一个方向没写出页面，算失败，但别的照常出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ispace-fan-'));
    const r = await runFanout({
      /* 第一个方向只说话不写文件——那张卡片没东西可看，就是失败 */
      engine: (d) => (d.key === dirs[0]!.key
        ? new ScriptedEngine([[{ type: 'text', delta: '我觉得不用做' }, { type: 'done' }]])
        : writes(`out/${d.key}/index.html`)),
      workspaceRoot: root,
      outRel: 'out',
      prompt: '做个排班表',
      device: 'both',
      dirs,
    });
    expect(r).toEqual({ ok: 1, failed: 1 });
    /* 失败的那个也留一页说明，不是 404 */
    expect(existsSync(join(root, 'out', dirs[0]!.key, 'index.html'))).toBe(true);
  });

  it('基于某一版再出：原稿进系统提示，key 不会越叠越长', async () => {
    const base = { key: 'paper-bold', name: '暖色纸感 · 更大胆', bg: '#fbf3e0', dot: '#cd2f3a' };
    const like = variantDirections(base, 'like');
    expect(like.map((d) => d.key)).toEqual(['paper-like-a', 'paper-like-b']);
    expect(like.map((d) => d.name)).toEqual(['暖色纸感 · 近似 A', '暖色纸感 · 近似 B']);
    /* 「近似」沿用原稿的底色；「夜间版」有自己的 */
    expect(like[0]!.bg).toBe('#fbf3e0');
    expect(variantDirections(base, 'night')[0]!.bg).toBe('#282522');

    const root = mkdtempSync(join(tmpdir(), 'ispace-fan-'));
    const seen: string[] = [];
    const [d] = variantDirections(base, 'vary');
    const r = await runFanout({
      engine: () => ({
        name: 'spy', model: 'test',
        async *run(o: { messages: { role: string; content: unknown }[] }) {
          if (!seen.length) seen.push(String(o.messages[0]?.content ?? ''));
          yield* writes(`out/${d!.key}/index.html`).run();
        },
      }) as unknown as Engine,
      workspaceRoot: root,
      outRel: 'out',
      prompt: '做个排班表',
      device: 'phone',
      dirs: [d!],
      base: { name: base.name, html: '<h1 class="原稿标记">排班</h1>' },
    });
    expect(r.ok).toBe(1);
    expect(seen[0]).toContain('原稿标记');
    expect(seen[0]).toContain('暖色纸感 · 更大胆');
  });

  it('条数由平台配，且不超过方向表', () => {
    expect(fanoutCount({})).toBe(6);
    expect(fanoutCount({ AGENT_FANOUT_N: '3' })).toBe(3);
    expect(fanoutCount({ AGENT_FANOUT_N: '99' })).toBe(DESIGN_DIRECTIONS.length);
    expect(fanoutCount({ AGENT_FANOUT_N: '0' })).toBe(1);
    expect(fanoutCount({ AGENT_FANOUT_N: '不是数' })).toBe(DESIGN_DIRECTIONS.length);
  });

  /*
    线上实打出来的：compose 写 `${AGENT_FANOUT_N:-}` 时变量是**空串**而不是
    不存在，`??` 不触发，Number('') 又是 0 —— 六个方向当场缩成一个，还不报错。
  */
  it('空串当没配，不当 0', () => {
    expect(fanoutCount({ AGENT_FANOUT_N: '' })).toBe(DESIGN_DIRECTIONS.length);
    expect(fanoutCount({ AGENT_FANOUT_N: '   ' })).toBe(DESIGN_DIRECTIONS.length);
    expect(numEnv('', 120_000)).toBe(120_000);
    expect(numEnv(undefined, 7)).toBe(7);
    expect(numEnv('不是数', 7)).toBe(7);
    expect(numEnv('0', 7)).toBe(0);
    expect(numEnv(' 42 ', 7)).toBe(42);
  });
});

describe('生图', () => {
  const env = { AGENT_BASE_URL: 'https://gw.example/v1', AGENT_API_KEY: 'k' };
  const png = Buffer.from('89504e470d0a1a0a', 'hex');

  afterEach(() => { vi.unstubAllGlobals(); });

  it('没配生图通道就当平台不会画', () => {
    expect(configuredImageModels({})).toEqual([]);
    expect(createImageGenerator(env)).toBeNull();
    /* 配了通道但没有 key 也一样：画不出来就别说能画 */
    expect(createImageGenerator({ AGENT_IMAGE_MODELS: 'a|甲' })).toBeNull();
  });

  it('b64_json 直接收下，白名单外的 model 按默认来', async () => {
    const seen: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: png.toString('base64') }] }),
      };
    });
    const gen = createImageGenerator({ ...env, AGENT_IMAGE_MODELS: 'a|甲, b|乙' })!;

    const r1 = await gen({ prompt: '一只猫', model: 'b' });
    expect(r1.model).toBe('b');
    expect(r1.bytes.equals(png)).toBe(true);

    const r2 = await gen({ prompt: '一只猫', model: '不在单子里' });
    expect(r2.model).toBe('a');
    /* size 一律不发：这个网关不认，发了只是多一个失败面 */
    expect(seen.every((b) => !('size' in b))).toBe(true);
  });

  it('url 形态也收：换个网关不至于整条断', async () => {
    vi.stubGlobal('fetch', async (u: string) => (
      u.includes('/images/generations')
        ? { ok: true, json: async () => ({ data: [{ url: 'https://cdn.example/x.webp' }] }) }
        : {
          ok: true,
          headers: { get: () => 'image/webp; charset=binary' },
          arrayBuffer: async () => png.buffer.slice(0),
        }
    ));
    const gen = createImageGenerator({ ...env, AGENT_IMAGE_MODELS: 'a|甲' })!;
    const r = await gen({ prompt: '一只猫' });
    expect(r.mime).toBe('image/webp');
  });

  it('接口报错要说清楚是哪一步，不吞', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 400, text: async () => '{"error":{"message":"要图片模型"}}',
    }));
    const gen = createImageGenerator({ ...env, AGENT_IMAGE_MODELS: 'a|甲' })!;
    await expect(gen({ prompt: 'x' })).rejects.toThrow(/400.*要图片模型/);
  });

  it('扩展名按实际格式改正，不听模型的', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }),
    }));
    const w = ws();
    const out = await runTool(
      {
        ws: w,
        platform: { ...platform, generateImage: createImageGenerator({ ...env, AGENT_IMAGE_MODELS: 'a|甲' })! },
      },
      'generate_image',
      { prompt: '封面', path: 'assets/hero.jpg' },
    );
    /* 网关出的是 png，模型写的是 .jpg —— 发布后带 nosniff，那就是一个裂图 */
    expect(existsSync(join(w.root, 'assets', 'hero.png'))).toBe(true);
    expect(existsSync(join(w.root, 'assets', 'hero.jpg'))).toBe(false);
    expect(out).toContain('assets/hero.png');
  });

  it('越界路径不画——那一次生图就是白花钱', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async () => {
      calls.push('x');
      return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) };
    });
    const ctx = {
      ws: ws(),
      platform: { ...platform, generateImage: createImageGenerator({ ...env, AGENT_IMAGE_MODELS: 'a|甲' })! },
    };
    await expect(runTool(ctx, 'generate_image', { prompt: 'x', path: '../../evil.png' }))
      .rejects.toThrow(/越界/);
  });

  it('平台没配时，工具自己说清楚，并给出替代做法', async () => {
    const out = await runTool({ ws: ws(), platform }, 'generate_image', { prompt: 'x', path: 'a.png' });
    expect(out).toContain('没有配生图通道');
  });
});

describe('harness 接进会话循环', () => {
  /** 记下每一次被喂了什么——要验证的正是"模型下一轮看到了什么"。 */
  class RecordingEngine implements Engine {
    readonly name = 'recording';
    readonly model = 'test';
    readonly seen: EngineMessage[][] = [];
    private turn = 0;
    constructor(private readonly script: EngineEvent[][]) {}
    async *run(input: { messages: EngineMessage[] }): AsyncGenerator<EngineEvent> {
      this.seen.push(input.messages.map((m) => ({ ...m })));
      for (const e of this.script[this.turn++] ?? [{ type: 'done' as const }]) yield e;
    }
  }

  it('截图在这一轮所有工具结果之后作为一条带图的 user 消息补上，不夹在工具结果中间', async () => {
    const w = ws();
    const engine = new RecordingEngine([
      [
        { type: 'tool_call', call: { id: 'a', name: 'screenshot_preview', arguments: {} } },
        { type: 'tool_call', call: { id: 'b', name: 'read_file', arguments: { path: 'index.html' } } },
        { type: 'done' },
      ],
      [{ type: 'text', delta: '标题溢出了，我改一下' }, { type: 'done' }],
    ]);
    const s = new AgentSession({
      engine,
      toolCtx: { ws: w, platform: { ...platform, screenshot: async () => ({ mimeType: 'image/png', dataBase64: 'iVBOR' }) } },
      canSee: true,
    });
    await s.send('看看手机上什么样');

    const second = engine.seen[1]!;
    const roles = second.slice(1).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    const last = second.at(-1)!;
    expect(last.images).toEqual([{ mimeType: 'image/png', dataBase64: 'iVBOR' }]);
    expect(last.content).toContain('不是用户发的消息');
  });

  it('上下文超预算就在要模型输出之前压一次，并发出 compacted 事件', async () => {
    const w = ws();
    const events: string[] = [];
    const engine = new RecordingEngine([[{ type: 'text', delta: '好' }, { type: 'done' }]]);
    const s = new AgentSession({
      engine, toolCtx: { ws: w, platform },
      compact: { budgetChars: 15_000, keepTurns: 1 },
      onEvent: (e) => { if (e.type === 'compacted') events.push(`${e.stage}`); },
    });
    const big = 'x'.repeat(20_000);
    s.messages.push(
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'read_file', arguments: { path: 'index.html' } }] },
      { role: 'tool', content: big, toolCallId: 'r' },
      { role: 'assistant', content: '读完了' },
    );
    await s.send('第二句');
    expect(events).toEqual(['1']);
    const fed = engine.seen[0]!;
    expect(fed.find((m) => m.toolCallId === 'r')!.content).toContain('已从上下文裁掉');
    expect(fed.at(-1)!.content).toBe('第二句');
  });

  it('设计扇出那种关掉压缩的会话，一个字节都不动', async () => {
    const engine = new RecordingEngine([[{ type: 'done' }]]);
    const s = new AgentSession({ engine, toolCtx: { ws: ws(), platform }, compact: false });
    s.messages.push({ role: 'user', content: 'x'.repeat(500_000) }, { role: 'assistant', content: 'ok' });
    await s.send('再来');
    expect(engine.seen[0]![1]!.content).toHaveLength(500_000);
  });

  it('提示词：小改用 edit_file、发布前先自检；能截图时才说能截图', () => {
    const base = buildSystemPrompt([]);
    expect(base).toContain('小改用 edit_file');
    expect(base).toContain('先调 check_publishable');
    expect(base).not.toContain('screenshot_preview');
    expect(buildSystemPrompt([], { canSee: true })).toContain('screenshot_preview');
  });
});
