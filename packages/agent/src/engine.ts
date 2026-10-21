import { ERROR_CODES, IspaceError } from '@ispace/contracts';
import { DEFAULT_CONTEXT_CHARS } from './compact.js';

/**
 * Agent 引擎抽象（技术方案 §6.6）。
 *
 * ┌─ 为什么必须有这一层，以及它已经救过一次 ────────────────────────────┐
 * │ 方案 §6.1 原本定的是 OpenAI Codex + Codex SDK。实测在一个兼容        │
 * │ OpenAI 协议的网关上，codex 专用模型（gpt-5.3-codex-spark）发起工具    │
 * │ 调用时 arguments 恒为空字符串——它走的不是标准 chat completions 的     │
 * │ 工具调用协议。同一请求换 gpt-5.6 / gpt-5.4 / MiniMax-M3 则全部正常     │
 * │ 返回参数，说明网关没问题，是那个模型的协议不同。                       │
 * │                                                                       │
 * │ 因为有这层抽象，换实现只改本文件的一个类，会话管理、工具注册、配额、   │
 * │ 手机端全部不动。                                                       │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * 接口只暴露方案 §6.6 要求的四件事：会话创建/续接、消息与事件流、
 * 工具注册、配额。不出现任何厂商专有概念。
 */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema。引擎负责转成各自的格式。 */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type EngineEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'error'; message: string };

export interface EngineMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role='assistant' 且发起了工具调用时携带。 */
  toolCalls?: ToolCall[];
  /** role='tool' 时指明回应哪次调用。 */
  toolCallId?: string;
  /** 多模态：截图随 prompt 传入（方案 §6.5）。 */
  images?: { mimeType: string; dataBase64: string }[];
}

export interface Engine {
  readonly name: string;
  readonly model: string;
  /**
   * 跑一轮。返回事件流。
   * 工具调用的执行由调用方负责——引擎只负责"模型想调什么"，
   * 不碰平台状态，这样单测里可以完全不起真实工具。
   */
  run(input: {
    messages: EngineMessage[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }): AsyncGenerator<EngineEvent>;
}

// ── OpenAI 兼容实现 ───────────────────────────────────────────────────

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单轮最大输出 token。防止一次跑飞把配额烧光。 */
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * 思考档位（创建屏那个「快速 / 深度思考 / 最大」）。
   *
   * 不设就**不发这个字段**——这是刻意的：reasoning_effort 只有推理模型认，
   * 网关遇到不认识的字段可能直接 400，那会让所有人的生成一起失败。平台没
   * 显式开启（AGENT_EFFORT）时，整条链路保持改版前的样子。
   */
  effort?: ReasoningEffort | undefined;
}

/** 思考档位。三档对应 OpenAI 兼容接口的 reasoning_effort。 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export class OpenAiCompatibleEngine implements Engine {
  readonly name = 'openai-compatible';
  readonly model: string;

  constructor(private readonly cfg: OpenAiCompatibleConfig) {
    this.model = cfg.model;
  }

  async *run(input: {
    messages: EngineMessage[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }): AsyncGenerator<EngineEvent> {
    const body = {
      model: this.cfg.model,
      messages: input.messages.map(toWireMessage),
      ...(input.tools.length
        ? {
            tools: input.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      stream: true,
      max_tokens: this.cfg.maxTokens ?? 64_000,
      ...(this.cfg.effort ? { reasoning_effort: this.cfg.effort } : {}),
    };

    const ctl = new AbortController();
    /*
      超时放宽到 5 分钟。

      推理型模型写一整页 HTML 本来就要几分钟（实测 glm-5.3-flash 在 120 秒
      时被掐断，而它只是还没写完）。掐断的代价不只是这一轮白跑：那一刻模型
      已经在生成了，token 照样计费。
    */
    const timeoutMs = this.cfg.timeoutMs ?? 300_000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    input.signal?.addEventListener('abort', () => ctl.abort());

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      yield { type: 'error', message: `模型服务不可达：${e instanceof Error ? e.message : String(e)}` };
      return;
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      yield { type: 'error', message: `模型返回 ${res.status}：${text.slice(0, 200)}` };
      return;
    }

    // 工具调用在流式响应里是**分片到达**的：name 可能只在第一片出现，
    // arguments 逐字拼接。必须按 index 累积，不能每片当成独立调用。
    const pending = new Map<number, { id: string; name: string; args: string }>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let chunk: WireChunk;
          try {
            chunk = JSON.parse(payload) as WireChunk;
          } catch {
            continue; // 半截 JSON，等下一片
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) yield { type: 'text', delta: delta.content };

          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const cur = pending.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            pending.set(idx, cur);
          }
        }
      }
    } catch (e) {
      /*
        读流读到一半断了。最常见的就是上面那个超时——直接把 AbortError 抛
        出去，上层看到的是一句英文的 "This operation was aborted"，没人知道
        那是"它还在写、被我们掐了"。这里翻译成一句能照着做的话。
      */
      yield {
        type: 'error',
        message: timedOut
          ? `模型 ${Math.round(timeoutMs / 1000)} 秒还没说完，这一轮停了。`
            + `可以把需求拆小一点再说，或者换一个快些的模型。`
          : `模型连接中断：${e instanceof Error ? e.message : String(e)}`,
      };
      return;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }

    for (const cur of pending.values()) {
      if (!cur.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = cur.args ? (JSON.parse(cur.args) as Record<string, unknown>) : {};
      } catch {
        // 参数不是合法 JSON 说明模型输出坏了。给出可诊断的错误而非静默丢弃——
        // 静默丢弃会表现为"模型说要做但什么都没发生"。
        yield {
          type: 'error',
          message: `模型返回的工具参数不是合法 JSON（工具 ${cur.name}）：${cur.args.slice(0, 120)}`,
        };
        continue;
      }
      yield { type: 'tool_call', call: { id: cur.id || `call_${cur.name}`, name: cur.name, arguments: args } };
    }

    yield { type: 'done' };
  }
}

interface WireChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}

function toWireMessage(m: EngineMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  if (m.images?.length) {
    // 多模态：截图随 prompt 传入（方案 §6.5）
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        ...m.images.map((i) => ({
          type: 'image_url',
          image_url: { url: `data:${i.mimeType};base64,${i.dataBase64}` },
        })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * 按环境变量构造引擎。
 *
 * 默认模型不用 codex-spark：实测该模型在本网关上工具调用的 arguments
 * 恒为空，无法驱动 Agent。详见文件头部说明。
 */
export interface EngineChoice {
  /** 用哪个模型。必须是 configuredModels 里的一个，否则按默认那个来。 */
  model?: string | undefined;
  /** 思考档位。平台没开启时忽略。 */
  effort?: ReasoningEffort | undefined;
}

/**
 * 平台允许选的模型。
 *
 * 取自 AGENT_MODELS，格式是逗号分隔的若干条，每条用竖线分三段：
 *
 *   AGENT_MODELS=gpt-6.1-sol|iSpace Auto|0.4x|258000, deepseek-flash|快|1x|1000000
 *                 └ 发给网关的 id  └ 名字  └ 倍率（可省）  └ 窗口 token 数（可省）
 *
 * 没配就只有 AGENT_MODEL 那一个——创建屏的菜单于是只列一行。列一行而不是
 * 把菜单藏掉：用户至少该知道这次是谁在给他写页面。
 *
 * ┌─ 第四段「窗口」是干什么的 ──────────────────────────────────────────┐
 * │ 平台原先不知道任何一个模型的上下文窗口，压缩阈值只有一个全局值     │
 * │ （160000 字符），按最小的那个模型定。而这几条通道差着数量级：      │
 * │ GPT 系 258k token，deepseek 与 GLM 到 1M——用同一个保守阈值，       │
 * │ 后两者会被远早于必要地压掉历史，表现就是"它好像忘了前面说过的话"。 │
 * │                                                                     │
 * │ 填了窗口，压缩阈值就按**这一轮实际用的那个模型**算（见 budgetFor）。│
 * │ 不填保持原样——不猜，猜错的后果是请求被网关直接拒掉。               │
 * └─────────────────────────────────────────────────────────────────────┘
 */
export interface ModelOption {
  id: string;
  label: string;
  mult?: string | undefined;
  /** 上下文窗口（token）。没填就是不知道，按全局保守值走。 */
  ctx?: number | undefined;
}

/**
 * 读一个数字型环境变量。
 *
 * ┌─ 为什么不能直接 Number(env.X ?? 默认值) ────────────────────────────┐
 * │ 没配的变量在容器里往往不是"不存在"，而是**空字符串**：compose 写     │
 * │ `AGENT_FANOUT_N: ${AGENT_FANOUT_N:-}` 时，变量照样存在，值是 ""。    │
 * │ 于是 `??` 不触发，而 `Number("")` 是 **0**——不是 NaN。              │
 * │                                                                      │
 * │ 后果实打实踩过：线上 AGENT_IMAGE_TIMEOUT_MS 是空串，超时变成 0 毫秒，│
 * │ 每一次生图当场 AbortError；AGENT_FANOUT_N 空串则让扇出从 6 个方向    │
 * │ 缩成 1 个，而且不报错——看起来"只是出得少"。两处都是端到端跑一遍才   │
 * │ 发现的，单测和 typecheck 都发现不了。                                │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function numEnv(raw: string | undefined, fallback: number): number {
  const t = (raw ?? '').trim();
  if (!t) return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

export function configuredModels(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const fallback = env.AGENT_MODEL ?? 'gpt-5.6';
  const raw = (env.AGENT_MODELS ?? '').trim();
  if (!raw) return [{ id: fallback, label: fallback }];

  const list = raw.split(',').map((entry) => {
    const [id, label, mult, ctx] = entry.split('|').map((x) => x.trim());
    if (!id) return null;
    const win = Number(ctx);
    return {
      id,
      label: label || id,
      ...(mult ? { mult } : {}),
      ...(Number.isFinite(win) && win > 0 ? { ctx: win } : {}),
    };
  }).filter((m): m is ModelOption => m !== null);

  /*
    配歪了（一条都解析不出来）就退回默认那个，而不是给出一张空菜单——
    空菜单会让创建屏看起来像是坏了，而真正坏的是一行环境变量。
  */
  return list.length ? list : [{ id: fallback, label: fallback }];
}

/**
 * 这一轮该给多大的上下文预算（字符）。
 *
 * ┌─ 两个容易想当然的地方 ──────────────────────────────────────────────┐
 * │ 1. 压缩器量的是**字符**，窗口给的是**token**，两者不是一回事。      │
 * │    中文大约一字一 token（有的分词器还更多），代码三四个字符一个。   │
 * │    所以安全的方向只有一个：拿字符数去顶 token 额度——中文最吃亏的   │
 * │    那种会话也不会超。反过来按"三个字符一个 token"折算，遇上一篇全   │
 * │    中文的长对话就会直接把请求撑爆，而那是网关拒绝、不是我们截断。   │
 * │                                                                     │
 * │ 2. **窗口大不等于该用满。** 每一轮都要把整段历史重新发一遍：窗口    │
 * │    1M 的模型如果真喂到 1M，一次请求又慢又贵，而这个 Agent 的典型    │
 * │    活儿（改一个页面）根本用不到。所以上面还压一个 CAP。             │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * AGENT_CONTEXT_CHARS 配了就照它来，不再按模型算——管理员显式写的数字
 * 应该赢过这里的推算。
 */

/** 留给工具定义、系统提示和余量的 token。 */
const CONTEXT_RESERVE_TOKENS = 8_000;

/**
 * 预算上限。不是模型顶不住，是**每轮重发整段历史**的代价：
 * 真用满 1M 窗口，一次请求的钱和时间都不是这个场景该花的。
 * 要更高就显式配 AGENT_CONTEXT_CHARS。
 */
export const MAX_CONTEXT_CHARS = 400_000;

export function contextBudget(
  env: NodeJS.ProcessEnv = process.env,
  modelId?: string,
): number {
  const explicit = (env.AGENT_CONTEXT_CHARS ?? '').trim();
  if (explicit) return numEnv(explicit, DEFAULT_CONTEXT_CHARS);

  const models = configuredModels(env);
  const picked = models.find((m) => m.id === modelId) ?? models[0];
  const win = picked?.ctx;
  if (!win) return DEFAULT_CONTEXT_CHARS;

  const usable = win - numEnv(env.AGENT_MAX_TOKENS, 64_000) - CONTEXT_RESERVE_TOKENS;
  /* 窗口比输出上限还小这种配法多半是填错了，退回保守值而不是算出个负数 */
  if (usable <= 0) return DEFAULT_CONTEXT_CHARS;
  return Math.min(MAX_CONTEXT_CHARS, Math.max(DEFAULT_CONTEXT_CHARS, usable));
}

/** 平台有没有开启「思考档位」。没开就不在创建屏显示那一排。 */
export function effortEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_EFFORT === '1';
}

export function createEngine(
  env: NodeJS.ProcessEnv = process.env,
  choice: EngineChoice = {},
): Engine {
  const baseUrl = env.AGENT_BASE_URL;
  const apiKey = env.AGENT_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new IspaceError(
      ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
      'Agent 未配置：需要 AGENT_BASE_URL 与 AGENT_API_KEY',
    );
  }
  const models = configuredModels(env);
  /*
    只认白名单里的 id。前端传什么都可能——而 model 是直接发给网关的字段，
    不校验等于把"随便点哪个模型"的开关交给了任何会发 HTTP 的人。
  */
  const picked = models.find((m) => m.id === choice.model) ?? models[0]!;
  return new OpenAiCompatibleEngine({
    baseUrl,
    apiKey,
    model: picked.id,
    /*
      上限给得大，是因为**推理型模型先想后说**。

      原来是 2048——那是按"改两行代码"估的。实测这个网关上
      deepseek-flash / glm-5.3 / gpt-6-astra 都把这 2048 全用在 reasoning 上，
      于是 content 和 tool_calls 都是空的，一轮下来什么都没发生、也不报错：
      界面上就是"没反应"。把上限提到 32000 之后，同一个模型同一句话立刻
      正常写文件。

      而且本来也该大：这个 Agent 的典型动作是一次 write_file 写出一整页
      HTML（实测 13~17 KB），2048 个 token 连写完都不够。

      现在是 64000：32000 已经能让它正常写文件，但"先想后说"的模型里，
      思考那一段本身就可能吃掉一两万，剩下的留给一整页 HTML 仍然紧。
      这是**上限不是预算**——模型写完就停，不会因为给得多就多写；给小了
      才会在半句话上截断，而截断的表现正是那种最难查的"没反应"。
    */
    maxTokens: numEnv(env.AGENT_MAX_TOKENS, 64_000),
    timeoutMs: numEnv(env.AGENT_TIMEOUT_MS, 120_000),
    ...(effortEnabled(env) && choice.effort ? { effort: choice.effort } : {}),
  });
}
