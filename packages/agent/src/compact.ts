import type { Engine, EngineMessage } from './engine.js';

/**
 * 上下文压缩。
 *
 * ┌─ 为什么要压 ────────────────────────────────────────────────────────┐
 * │ 会话落库之后能续好几天，而这个 Agent 的消息天生就大：一次 write_file │
 * │ 的参数就是一整页 HTML（实测 13~17 KB），一次 read_file 的结果又是一 │
 * │ 整页。改十来轮就是几十万字——超过模型窗口时网关直接 400，用户看到的 │
 * │ 是"昨天还好好的，今天一句话都说不了了"。没超过也贵：每一轮都要把全 │
 * │ 部历史重新发一遍、重新计费。                                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 三级，便宜的先上，够了就停：
 *
 *   1. 裁剪——早先几轮的工具结果只留个头，write_file / edit_file 参数里的
 *      大段文本换成一句「略去 N 字」。文件本身在工作区里，要用随时能再读；
 *      模型需要记住的是"我做过什么"，不是"那一页的每一个字"。
 *   2. 摘要——还超就让模型把更早的对话写成一段前情提要，替换掉原文。
 *   3. 硬截断——摘要失败（网关出错）时丢掉最早的几轮，留一句话说明丢了。
 *      宁可忘掉开头，也不能让这一轮因为上下文太长直接失败。
 *
 * 最近 keepTurns 轮永远原样保留：模型正在做的事，一个字都不能少。
 *
 * 只在超预算时才动。不超就一个字节都不改——历史前缀不变，网关的提示缓存
 * 才命中得上。
 */

export interface CompactOptions {
  /** 上下文预算（按字符估）。超过才压。 */
  budgetChars?: number;
  /** 最近几轮（按用户消息数）原样保留。 */
  keepTurns?: number;
  /** 写摘要用的函数。不给就跳过第 2 级。 */
  summarize?: (transcript: string) => Promise<string>;
}

export interface CompactResult {
  messages: EngineMessage[];
  /** 0 = 没动；1 = 裁剪；2 = 摘要；3 = 硬截断。 */
  stage: 0 | 1 | 2 | 3;
  before: number;
  after: number;
}

/**
 * 默认预算。约合四五万到八万 token（中文接近一字一 token，代码三四个字符
 * 一个），给模型留足输出与工具定义的余量，又远低于这几个网关模型的窗口。
 */
export const DEFAULT_CONTEXT_CHARS = 160_000;
const DEFAULT_KEEP_TURNS = 2;
/** 一张图按这么多字符估。它确实很贵，但不至于贵过一页 HTML。 */
const IMAGE_CHARS = 3000;
/** 早先的工具结果裁到只剩这么长的开头。 */
const KEEP_HEAD = 300;
/** 工具参数里超过这个长度的字符串换成「略去」。 */
const ARG_LIMIT = 400;

export const SUMMARY_MARK = '【前情提要】';

/** 估一组消息有多大。 */
export function measure(messages: EngineMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.content.length;
    for (const c of m.toolCalls ?? []) n += c.name.length + JSON.stringify(c.arguments).length;
    n += (m.images?.length ?? 0) * IMAGE_CHARS;
  }
  return n;
}

export async function compact(all: EngineMessage[], opts: CompactOptions = {}): Promise<CompactResult> {
  const budget = opts.budgetChars ?? DEFAULT_CONTEXT_CHARS;
  const keepTurns = opts.keepTurns ?? DEFAULT_KEEP_TURNS;
  const before = measure(all);
  if (before <= budget) return { messages: all, stage: 0, before, after: before };

  const head = all[0]?.role === 'system' ? [all[0]] : [];
  let body = all.slice(head.length);
  const keepFrom = turnStart(body, keepTurns);

  // ── 1. 裁剪 ──────────────────────────────────────────────────────────
  body = body.map((m, i) => (i < keepFrom ? trim(m) : m));
  let after = measure([...head, ...body]);
  if (after <= budget) return { messages: [...head, ...body], stage: 1, before, after };

  // ── 2. 摘要 ──────────────────────────────────────────────────────────
  const cut = keepFrom;
  if (cut > 0 && opts.summarize) {
    try {
      const summary = (await opts.summarize(transcript(body.slice(0, cut)))).trim();
      if (summary) {
        body = [{ role: 'user', content: `${SUMMARY_MARK}之前的对话太长，压缩成了下面这段摘要。文件都还在工作区里，需要细节就重新读。\n\n${summary}` }, ...body.slice(cut)];
        after = measure([...head, ...body]);
        if (after <= budget) return { messages: [...head, ...body], stage: 2, before, after };
      }
    } catch {
      /* 摘要失败就落到第 3 级，不能让这一轮因此失败 */
    }
  }

  // ── 3. 硬截断 ────────────────────────────────────────────────────────
  /*
    从最早的一轮开始整轮丢（按用户消息切，工具调用和它的结果不会被拆开），
    直到放得下或只剩保留的那几轮。还放不下就连保留区里的大段工具结果也裁掉
    ——这已经是一轮之内就塞爆了的情况，能跑总比 400 好。
  */
  let dropped = 0;
  while (measure([...head, ...body]) > budget) {
    const keep = turnStart(body, keepTurns);
    if (keep <= 0) break; // 前面已经没有可丢的了
    /* 丢掉最前面那一轮：从开头到下一条用户消息（不含） */
    const next = body.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next <= 0 || next > keep) break;
    body = body.slice(next);
    dropped += 1;
  }
  if (measure([...head, ...body]) > budget) {
    body = body.map((m, i) => (i < body.length - 2 ? trim(m) : m));
  }
  if (dropped) {
    body = [{ role: 'user', content: `${SUMMARY_MARK}更早的 ${dropped} 轮对话因为太长已经丢掉了。工作区里的文件都在，接着做之前先看看现在的文件。` }, ...body];
  }
  after = measure([...head, ...body]);
  return { messages: [...head, ...body], stage: 3, before, after };
}

/** 用一个引擎写摘要。走无工具的单轮调用，失败就抛，交给 compact 落到第 3 级。 */
export function engineSummarizer(engine: Engine, signal?: AbortSignal): (t: string) => Promise<string> {
  return async (t) => {
    let out = '';
    const run = engine.run({
      messages: [
        {
          role: 'system',
          content: '你在帮一个写网页的助手整理它自己的工作记录。把下面这段对话压成一段前情提要，'
            + '供它接着干活时看。要写清楚：用户要做什么页面、提过哪些要求和偏好（尤其是被否掉的方案）、'
            + '已经做了哪些文件和改动、发布到了哪里、还有什么没做完。不要寒暄，不要复述代码，800 字以内。',
        },
        { role: 'user', content: t },
      ],
      tools: [],
      ...(signal ? { signal } : {}),
    });
    for await (const ev of run) {
      if (ev.type === 'text') out += ev.delta;
      else if (ev.type === 'error') throw new Error(ev.message);
    }
    return out;
  };
}

/** 倒数第 keep 条用户消息的下标——从它开始是要原样保留的。不够 keep 轮就是 0。 */
function turnStart(body: EngineMessage[], keep: number): number {
  let seen = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.role === 'user' && !body[i]!.content.startsWith(SUMMARY_MARK)) {
      seen += 1;
      if (seen === keep) return i;
    }
  }
  return 0;
}

function trim(m: EngineMessage): EngineMessage {
  let out: EngineMessage = m;
  if (m.role === 'tool' && m.content.length > KEEP_HEAD * 2) {
    out = {
      ...out,
      content: `${m.content.slice(0, KEEP_HEAD)}\n…（早先的工具结果，已从上下文裁掉 ${m.content.length - KEEP_HEAD} 字。要用就重新调一次。）`,
    };
  }
  if (m.toolCalls?.some((c) => Object.values(c.arguments).some((v) => typeof v === 'string' && v.length > ARG_LIMIT))) {
    out = {
      ...out,
      toolCalls: m.toolCalls.map((c) => ({
        ...c,
        arguments: Object.fromEntries(Object.entries(c.arguments).map(([k, v]) => [
          k,
          typeof v === 'string' && v.length > ARG_LIMIT ? `«已略去 ${v.length} 字，内容见工作区里的文件»` : v,
        ])),
      })),
    };
  }
  if (m.images?.length) {
    const { images, ...rest } = out;
    out = { ...rest, content: `${out.content}\n（这里原本附了 ${images!.length} 张图，已不在上下文里。）` };
  }
  return out;
}

/** 把一段消息写成给摘要模型读的纯文本。 */
function transcript(ms: EngineMessage[]): string {
  return ms.map((m) => {
    if (m.role === 'user') return `【用户】${m.content}`;
    if (m.role === 'tool') return `【工具结果】${m.content.slice(0, 600)}`;
    const calls = (m.toolCalls ?? []).map((c) => {
      const brief = Object.entries(c.arguments)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : JSON.stringify(v)}`)
        .join(', ');
      return `  → 调用 ${c.name}(${brief})`;
    });
    return [`【助手】${m.content}`, ...calls].join('\n');
  }).join('\n\n');
}
