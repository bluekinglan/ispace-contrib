import type { Engine, EngineMessage, ToolDef } from './engine.js';
import { ALL_TOOLS, parseAsk, runTool, type ToolContext } from './tools.js';

/**
 * 会话循环（技术方案 §6.1 的「线程语义恰好对应会话」）。
 *
 * 一轮 = 模型输出文本 + 可能发起若干工具调用 → 执行工具 → 把结果回灌
 * → 模型继续。直到模型不再调用工具，或达到轮次上限。
 *
 * 轮次上限是必需的：模型可能在两个工具之间来回打转（读文件→写文件→
 * 再读→再写），没有上限就是一个能烧光配额的死循环。上限到达时明确
 * 告知用户，而不是假装完成了。
 */

const BASE_PROMPT = `你是 ispace 内部平台的编码助手，帮助员工修改他们自己的网页应用。

工作方式：
- 用户用自然语言描述想改什么，你读代码、改代码，然后请求发布。
- 你只能操作该用户自己的工作区文件，不能执行任意命令。
- 发布必须经用户在手机上二次确认，你无权直接发布。

平台约束（AGENTS.md 的等价约束，违反会在构建期被拒）：
- 不得引入新的原生依赖——会改变 runtimeVersion，导致更新不被壳接受。
- 前端资源引用必须用相对路径（./assets/x.js），不能用根绝对路径
  （/assets/x.js）——应用部署在子路径下，绝对路径会 404。
- 不要把密钥硬编码进代码。发布链路会扫描并阻断，Supabase 的
  service_role key 尤其禁止出现在前端。
- app.json 的 tabBar.activeColor 必须是 #RRGGBB 形式。

回答用中文，简短直接。改动完成后用一句话说清楚改了什么。`;

/**
 * 把这个人能用的连接器拼进系统提示。
 *
 * ┌─ 为什么是系统提示而不是再加一个工具 ────────────────────────────────┐
 * │ 工具是「你去问」，系统提示是「你已经知道」。                          │
 * │                                                                      │
 * │ 用户说「做个页面显示今天天气」时，模型要先意识到"我需要外部数据、    │
 * │ 而这个平台可能有现成的"，才会想到去调 list-connectors。它多半不会——  │
 * │ 更可能直接编一段假数据，或者写死一个它记忆里的 api.weatherapi.com，  │
 * │ 那个域名既没登记也调不通。等页面发出去才发现，就晚了。               │
 * │                                                                      │
 * │ 清单很短（十条上下），全量内联的 token 成本可以忽略，换来的是模型在  │
 * │ 决定"数据从哪来"的那一刻就已经知道有什么可用。                        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * returns 那一栏尤其不能省：模型写 `data.current.temperature_2m` 时如果不知道
 * 响应形状就只能猜，猜错是一个运行时才暴露的白屏。
 */
/**
 * 「用户正看着预览」那一段。
 *
 * ┌─ 为什么是条件拼接，而不是写死在 SYSTEM_PROMPT 里 ───────────────────┐
 * │ 这段提示和手机壳那条流共用同一份 SYSTEM_PROMPT，而手机壳没有预览。  │
 * │ 写死就等于对一半的会话说了一句假话——模型会按"他正看着"去安排顺序， │
 * │ 甚至在回话里提"你右边应该已经能看到了"，而那边根本没有那块东西。    │
 * │                                                                      │
 * │ 所以它由**服务端查真实状态**决定（routes/agent.ts 按这个人有没有一个 │
 * │ 活着的预览会话判断），不是前端说了算。前端能撒谎，真实状态不会。     │
 * └──────────────────────────────────────────────────────────────────────┘
 */
const LIVE_PREVIEW = `

## 用户正看着预览

他右边有一块实时预览，**你每写完一个文件它就刷新一次**，页面当场在他眼前跑。
因此：

- **先把 index.html 写出来，再写别的。** 它是预览的入口；先写别的文件，那块
  会一直空着，人看不出你在干活。
- 页面跑起来报的错（脚本异常、资源加载失败）会回到这个对话里来找你改。
  不用靠读自己的代码猜哪里会错——等它告诉你，然后照着改。
- 预览和发布后的站点一样挂在子路径下，所以根绝对路径（\`/assets/x.js\`）在
  预览里当场就会 404。这是好事：它把这个错提前暴露给你了。`;

/**
 * 「你能生图」那一段。
 *
 * 和 LIVE_PREVIEW 同一个道理：平台没配生图通道时这段不能出现，否则模型会
 * 按"我能画"去安排内容——先写一个 <img src="assets/hero.png">，再去调一个
 * 根本没挂上来的工具，最后页面上是一个裂图。
 */
const CAN_DRAW = `

## 你能生成图片

有 generate_image 工具：给一句描述和一个工作区路径，它把图存进去，页面用相
对路径引用。用在插图、封面、空状态配图这类没有现成素材的地方。

三条硬约束，都是这个网关的实际情况：

- **尺寸不可控**：传不了尺寸参数，出来多大由网关定，同样的参数两次还未必
  一样。所以页面那边一定要用 CSS 兜住（给容器定高 + object-fit: cover），
  不要假设它是方的。
- **一张约 2 MB**：别为了装饰生图。能用 CSS 渐变、SVG、emoji 表达的就别画。
- **按张计费**，一次对话里最多几张。把配额花在真正撑场面的那一两张上。

图里尽量不要文字——模型画的字经常是歪的。文字用 HTML 写在图上面。`;

/**
 * 「开工之前要不要问」那一段。
 *
 * 创建屏原来在开场摆三个固定选项，每个人都得先点一下才开始。拿掉之后，
 * 问不问、问什么完全交给模型——但得告诉它分寸：不说的话，有的模型一句话
 * 都不问就硬做，有的则把用户当问卷来填。
 */
const ASK_FIRST = `

## 开工之前要不要问

用户的第一句话往往不完整。先判断，再动手：

- **已经够做出一个像样的第一版**（做什么、给谁用大致清楚）→ 直接做，别问。
  宁可先做出来让他改，也别让他先答题。
- **有一两处会让结果差很多、而你确实猜不出来** → 先用 ask_user 问。典型的是：
  数据从哪来（手填 / 接已有系统 / 多人一起填）、主要在手机还是电脑上看、
  要不要登录或区分每个人的数据。一次一个问题，2~4 个选项，把你推荐的标上。
  最多问两轮，问完就动手。
- 风格、配色、文案、布局细节这类做出来再改更快的，**不要问**。`;

export function buildSystemPrompt(
  available: AvailableConnector[],
  opts: { livePreview?: boolean; canDraw?: boolean } = {},
): string {
  const SYSTEM_PROMPT = (opts.livePreview ? BASE_PROMPT + LIVE_PREVIEW : BASE_PROMPT)
    + ASK_FIRST
    + (opts.canDraw ? CAN_DRAW : '');

  if (available.length === 0) {
    return `${SYSTEM_PROMPT}

## 外部数据

这个空间还没有可用的连接器。页面需要外部数据时，**不要凭记忆写一个第三方
API 地址**——页面直接调外站会被跨域挡住，写死密钥则会被发布链路阻断。
请告诉用户「这需要先在控制台『连接器』里登记一个数据源」，并说清楚要登记哪个。`;
  }

  const TAG = { personal: '（仅你自己）', shared: '（全员共享）', builtin: '（平台内置）' };
  const lines = available.map((c) => [
    `- **${c.slug}** ${c.name}${TAG[c.scope]}`,
    `  用途：${c.what}`,
    `  调用：fetch('/deploy/api/connect/${c.slug}${c.example}')`,
    `  返回：${c.returns}`,
  ].join('\n'));

  // 只在真有个人连接器时才说这一句。没有的话它是噪音，还会让模型无谓地犹豫
  const personalWarning = available.some((c) => c.scope === 'personal')
    ? '\n⚠️ 标「仅你自己」的连接器**只在你自己打开页面时有效**。'
      + '这个页面要分享给同事的话，改用「全员共享」或「平台内置」的那些，'
      + '否则同事打开就是一片空白。\n'
    : '';

  return `${SYSTEM_PROMPT}

## 外部数据：可用的连接器

页面需要外部数据时**先看这份清单**。命中了就直接用，不要自己去调第三方域名
——那会被跨域挡住；也不要把密钥写进代码——会被发布链路阻断。

调用一律是同源相对路径 \`/deploy/api/connect/{短名}/{上游路径}\`，凭据由平台
在服务端注入，**你写的代码里不出现任何 key**。

${lines.join('\n')}
${personalWarning}
没有一条命中用户需求时，不要硬套一个最接近的，也不要编一个域名。直接说
「平台上没有能拿这个数据的连接器」，并建议用户去控制台登记。`;
}

export interface AvailableConnector {
  slug: string;
  name: string;
  what: string;
  example: string;
  returns: string;
  /**
   * 三态而不是「是否共享」的布尔。
   *   personal —— 本人登记的。**用了它的页面分享给同事会失败**
   *   shared   —— 管理员发布的，全员可用
   *   builtin  —— 平台内置目录里免密钥的，不需要登记，人人可用
   * personal 与另外两者的区别有实际后果，模型必须看得见。
   */
  scope: 'personal' | 'shared' | 'builtin';
}

export interface SessionOptions {
  engine: Engine;
  toolCtx: ToolContext;
  /** 轮次上限。默认 12——够完成"读几个文件、改两处、请求发布"，又不至于跑飞。 */
  maxTurns?: number;
  tools?: ToolDef[];
  /**
   * 整段换掉系统提示。
   *
   * 只有设计扇出用（fanout.ts）：那几个会话不是"改这个人的项目"，而是
   * "出一版视觉草案"，连接器清单、发布纪律、实时预览那几段对它们全是噪音，
   * 还会让它去调根本没给它的工具。
   */
  systemPrompt?: string;
  /**
   * 这个人能用的连接器。不传等同于空——那种情况下提示词会明确告诉模型
   * "没有可用数据源、别自己编域名"，而不是留白让它自由发挥。
   */
  connectors?: AvailableConnector[];
  /**
   * 这个人此刻有没有一块活着的实时预览。
   *
   * 由服务端查真实状态得出（见 buildSystemPrompt 里 LIVE_PREVIEW 的说明），
   * 不传等同于没有——手机壳那条流就是没有。
   */
  livePreview?: boolean;
  /**
   * 平台有没有配生图通道。和 toolCtx.platform.generateImage 是同一个开关的
   * 两面：挂了工具就得在提示里说，说了就得真能调。
   */
  canDraw?: boolean;
  onEvent?: (e: SessionEvent) => void;
  signal?: AbortSignal;
}

export type SessionEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'turn'; index: number }
  | { type: 'done'; turns: number; stopReason: StopReason }
  | { type: 'error'; message: string };

/**
 * 一轮为什么停了。
 *
 * 'ask' 是新加的：模型调了 ask_user，问题已经摆到用户面前，这一轮就该到此
 * 为止。把它和 'complete' 分开，前端才知道"在等你回答"和"它说完了"是两件
 * 事——前者该把输入框换成选项卡片，后者不该。
 */
export type StopReason = 'complete' | 'ask' | 'max_turns' | 'error';

export class AgentSession {
  readonly messages: EngineMessage[];

  constructor(private readonly opts: SessionOptions) {
    this.messages = [
      {
        role: 'system',
        content: opts.systemPrompt
          ?? buildSystemPrompt(opts.connectors ?? [], {
            livePreview: opts.livePreview ?? false,
            canDraw: opts.canDraw ?? false,
          }),
      },
    ];
  }

  /** 追加一条用户消息（可带截图）并跑到收敛。 */
  async send(
    text: string,
    images: { mimeType: string; dataBase64: string }[] = [],
  ): Promise<{ stopReason: StopReason; turns: number }> {
    const emit = this.opts.onEvent ?? (() => {});
    const tools = this.opts.tools ?? ALL_TOOLS;
    const maxTurns = this.opts.maxTurns ?? 12;

    this.messages.push(
      images.length ? { role: 'user', content: text, images } : { role: 'user', content: text },
    );

    for (let turn = 0; turn < maxTurns; turn++) {
      emit({ type: 'turn', index: turn });

      let assistantText = '';
      const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
      let errored = false;

      const runOpts = this.opts.signal
        ? { messages: this.messages, tools, signal: this.opts.signal }
        : { messages: this.messages, tools };

      for await (const ev of this.opts.engine.run(runOpts)) {
        if (ev.type === 'text') {
          assistantText += ev.delta;
          emit({ type: 'text', delta: ev.delta });
        } else if (ev.type === 'tool_call') {
          calls.push(ev.call);
        } else if (ev.type === 'error') {
          emit({ type: 'error', message: ev.message });
          errored = true;
        }
      }

      if (errored) {
        emit({ type: 'done', turns: turn + 1, stopReason: 'error' });
        return { stopReason: 'error', turns: turn + 1 };
      }

      this.messages.push(
        calls.length
          ? { role: 'assistant', content: assistantText, toolCalls: calls }
          : { role: 'assistant', content: assistantText },
      );

      // 没有工具调用 = 模型认为说完了
      if (!calls.length) {
        emit({ type: 'done', turns: turn + 1, stopReason: 'complete' });
        return { stopReason: 'complete', turns: turn + 1 };
      }

      let asked = false;
      for (const call of calls) {
        emit({ type: 'tool_start', name: call.name, args: call.arguments });
        let result: string;
        try {
          result = await runTool(this.opts.toolCtx, call.name, call.arguments);
        } catch (e) {
          // 工具失败要回灌给模型而非中断——模型据此改正是正常流程的一部分，
          // 比如路径写错了、文件不存在。直接中断会让用户看到"没反应"。
          result = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
        }
        emit({ type: 'tool_result', name: call.name, result });
        this.messages.push({ role: 'tool', content: result, toolCallId: call.id });
        if (call.name === 'ask_user' && parseAsk(call.arguments)) asked = true;
      }

      /*
        问出去了就停，不再让模型接着往下写。

        同一轮里它可能既问了又改了文件（模型偶尔会这样），那几个工具已经
        执行完了——停的是"再要一次模型输出"，不是回滚。下一轮带着用户的
        回答继续，历史是连续的。
      */
      if (asked) {
        emit({ type: 'done', turns: turn + 1, stopReason: 'ask' });
        return { stopReason: 'ask', turns: turn + 1 };
      }
    }

    // 到上限要说清楚，不能假装完成
    emit({ type: 'done', turns: maxTurns, stopReason: 'max_turns' });
    return { stopReason: 'max_turns', turns: maxTurns };
  }
}
