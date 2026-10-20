import { ERROR_CODES, IspaceError } from '@ispace/contracts';
import type { ModelOption } from './engine.js';

/**
 * 生图通道。
 *
 * ┌─ 为什么和对话模型分开配 ────────────────────────────────────────────┐
 * │ 两张单子里的 id 不能混：AGENT_MODELS 决定"谁来写你的页面"，服务端拿 │
 * │ 它去调 /chat/completions 并带上工具集；生图模型没有这套语义，混进去 │
 * │ 的后果是用户在下拉里选了它，这一次生成当场失败，看起来像平台坏了。  │
 * │                                                                      │
 * │ 所以生图另起一条：AGENT_IMAGE_MODELS。没配就当平台没有这个能力——    │
 * │ 工具不挂、系统提示里不提。模型不会去调一个它不知道存在的东西，也就  │
 * │ 不会承诺"我给你画一张"然后画不出来。                                │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 2026-10-20 在公司网关上实测到的三件事 ─────────────────────────────┐
 * │ 1. 响应是 `data[0].b64_json`（PNG），不是 url。两种都收着，换网关   │
 * │    时不至于整条断。                                                 │
 * │ 2. **size 不起作用**：同一个模型传 1024x1024 / 1536x1024 /          │
 * │    1024x1536 / auto，回来的分别是 1254×1254、1312×1199、1312×1199、 │
 * │    1312×1199——尺寸由网关自己定，连同一组参数两次调用都未必一样。    │
 * │    所以工具里**不给 size 这个参数**：摆一个按了没反应的旋钮，比没有 │
 * │    更糟。页面那边用 CSS 适配。                                      │
 * │ 3. 一张 PNG 约 2 MB。网页上放几张就把工作区配额吃掉一块，所以有     │
 * │    每次会话的张数上限。                                             │
 * └──────────────────────────────────────────────────────────────────────┘
 */

/** 一次会话最多出几张。生图按张计费，而一个跑飞的循环能在一分钟里烧掉一沓。 */
export const MAX_IMAGES_PER_SESSION = 8;

/** 单张上限。实测一张约 2 MB，留一倍余量；再大就不是网页上该放的东西了。 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * 平台配了哪几条生图通道。
 *
 * 格式与 AGENT_MODELS 同：`id|给人看的名字`，逗号分隔。
 * 没配返回空数组——调用方据此决定挂不挂这个工具。
 */
export function configuredImageModels(env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const raw = (env.AGENT_IMAGE_MODELS ?? '').trim();
  if (!raw) return [];
  return raw.split(',').flatMap((entry) => {
    const [id, label, mult] = entry.split('|').map((x) => x.trim());
    if (!id) return [];
    return [{ id, label: label || id, ...(mult ? { mult } : {}) }];
  });
}

export interface GeneratedImage {
  bytes: Buffer;
  /** 真正用的那个模型 id。模型传了白名单外的值时这里是默认那个。 */
  model: string;
  mime: string;
}

export type ImageGenerator = (opts: {
  prompt: string;
  model?: string | undefined;
}) => Promise<GeneratedImage>;

/**
 * 按 OpenAI 兼容的 `/images/generations` 调一次。
 *
 * 响应两种形态都收：`b64_json`（直接是字节）和 `url`（再取一次）。
 */
export function createImageGenerator(
  env: NodeJS.ProcessEnv = process.env,
): ImageGenerator | null {
  const baseUrl = env.AGENT_BASE_URL;
  const apiKey = env.AGENT_API_KEY;
  const models = configuredImageModels(env);
  /* 三样缺一样就当平台没有生图。不抛异常：没配不是错误，是没开这个功能 */
  if (!baseUrl || !apiKey || !models.length) return null;

  const timeoutMs = Number(env.AGENT_IMAGE_TIMEOUT_MS ?? 120_000);

  return async ({ prompt, model }) => {
    /* 只认白名单。model 是直接发给网关的字段，原样转发等于把计费开关交出去 */
    const picked = models.find((m) => m.id === model) ?? models[0]!;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: picked.id, prompt, n: 1 }),
        signal: ctl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new IspaceError(
          ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
          `生图接口返回 ${res.status}：${body.slice(0, 180)}`,
        );
      }

      const json = await res.json() as { data?: { b64_json?: string; url?: string }[] };
      const first = json.data?.[0];
      if (!first) {
        throw new IspaceError(ERROR_CODES.ORCHESTRATOR_UNAVAILABLE, '生图接口没有返回图片');
      }

      let bytes: Buffer;
      let mime = 'image/png';
      if (first.b64_json) {
        bytes = Buffer.from(first.b64_json, 'base64');
      } else if (first.url) {
        const img = await fetch(first.url, { signal: ctl.signal });
        if (!img.ok) {
          throw new IspaceError(
            ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
            `图片下载失败（${img.status}）`,
          );
        }
        mime = img.headers.get('content-type')?.split(';')[0]?.trim() || mime;
        bytes = Buffer.from(await img.arrayBuffer());
      } else {
        throw new IspaceError(
          ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
          '生图接口返回的既不是 b64_json 也不是 url',
        );
      }

      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          `生成的图片 ${Math.round(bytes.byteLength / 1024)} KB，`
          + `超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限`,
        );
      }
      return { bytes, model: picked.id, mime };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 按 MIME 给个扩展名。认不出来就按 png——网关出的就是 png。 */
export function extFor(mime: string): string {
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  })[mime] ?? '.png';
}
