import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';
import type { ToolDef } from './engine.js';
import { extFor, type ImageGenerator } from './image.js';

/**
 * Agent 可用的工具（技术方案 §6.4）。
 *
 * ┌─ 与方案 §6.2 的实质偏离，须知悉 ────────────────────────────────────┐
 * │ 方案原设计是「每位开发者一个 Docker 沙箱工作区，Codex 以              │
 * │ sandbox: workspace-write + approval-policy: never 在容器内运行」。   │
 * │                                                                      │
 * │ 本实现不给 Agent 任意 shell，改为**受控文件工具集**：读目录、读文件、 │
 * │ 写文件、删文件，全部限定在该用户的工作区内，路径经 resolve 后必须     │
 * │ 仍在工作区下，否则拒绝。                                             │
 * │                                                                      │
 * │ 理由：给 Agent 沙箱要么给 deploy-service 挂 docker socket（等于开一个 │
 * │ 容器逃逸的口子），要么再起一套容器编排。而实际需要的能力只是「改这个  │
 * │ 项目的文件、然后走平台的发布链路」——受控文件工具完全覆盖，攻击面     │
 * │ 小一个数量级。                                                        │
 * │                                                                      │
 * │ 代价：Agent 不能自己跑 npm install 或测试。构建与校验发生在平台的     │
 * │ 发布链路里（扫描、base path 校验、合成流水线），失败会回给 Agent，    │
 * │ 它据此改代码——这条反馈回路是通的，只是比"能跑任意命令"慢一些。       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 部署二次确认仍按方案 §6.2：审批收在平台层而非模型层——手机端确认后
 * 签发一次性 token，requestDeploy 校验 token 方可执行。比模型层审批更硬。
 */

export interface WorkspaceContext {
  /** 该用户工作区的绝对路径。所有文件操作限定在此之下。 */
  root: string;
  username: string;
}

/** 单文件读写上限。防止 Agent 一次读进一个几十 MB 的文件把上下文撑爆。 */
const MAX_FILE_BYTES = 256 * 1024;
/** 目录列举上限。 */
const MAX_ENTRIES = 300;

/**
 * 把 Agent 给的相对路径解析为绝对路径，并确保仍在工作区内。
 *
 * 这是整个工具集的安全边界。resolve 之后必须仍以 root 开头——
 * 这一条挡住 ../、绝对路径、以及符号链接之外的所有越界形式。
 */
function safePath(ws: WorkspaceContext, rel: string): string {
  const abs = resolve(ws.root, rel);
  if (abs !== ws.root && !abs.startsWith(ws.root + sep)) {
    throw new IspaceError(
      ERROR_CODES.FORBIDDEN,
      `路径越界：${rel} 不在你的工作区内。只能操作 ${ws.username} 自己的项目文件。`,
    );
  }
  return abs;
}

export const FILE_TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description: '列出工作区里某个目录下的文件与子目录。path 省略则列根目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的目录路径' } },
    },
  },
  {
    name: 'read_file',
    description: '读取工作区里某个文件的内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '写入（覆盖）工作区里的某个文件。父目录会自动创建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除工作区里的某个文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
      required: ['path'],
    },
  },
];

export const PLATFORM_TOOLS: ToolDef[] = [
  {
    name: 'get_quota',
    description: '查询当前用户的空间、后端与数据行用量。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_apps',
    description: '列出当前用户已部署的全部应用及其状态。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'request_deploy',
    description:
      '请求把当前工作区发布到用户空间。需要用户在手机上二次确认——调用后会返回一个待确认状态，' +
      '不会立即发布。这是有意的：发布是对外可见的动作，必须由人点头。',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '发布到的路径，如 zhoubao' },
        summary: { type: 'string', description: '本次改动的一句话摘要，会显示在确认卡上' },
      },
      required: ['site', 'summary'],
    },
  },
];

/**
 * 把一个带选项的问题摆到用户面前。
 *
 * ┌─ 为什么要有这个工具，而不是让模型在正文里问 ────────────────────────┐
 * │ 模型本来就会在正文里问「你想要哪种风格？A/B/C」。问题是那段话对前端 │
 * │ 来说只是一段文本：人要自己把选项打一遍，打错了模型还得再问一次。    │
 * │                                                                      │
 * │ 走工具就不一样——问题和选项是结构化的，前端能画成可点的卡片，点一下  │
 * │ 就是下一轮的输入。少的那几次打字，正是"问清楚再动手"能不能真正成立  │
 * │ 的前提：要人打五十个字才能回答的问题，他宁可不回答。                │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 调用它会**结束这一轮**（见 session.ts 的 stopReason 'ask'）：问题问出去了
 * 就该等人，继续往下写代码等于没问。
 */
export const ASK_TOOL: ToolDef = {
  name: 'ask_user',
  description:
    '向用户提一个带选项的问题，然后停下等他回答。只在"选哪条路会让结果差很多、'
    + '而你猜不出来"时用；能自己定的事不要问。一次只问一个问题。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '一句话的问题' },
      options: {
        type: 'array',
        description: '2 到 4 个选项',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '选项本身，几个字' },
            hint: { type: 'string', description: '选了会怎样，一句话' },
            recommended: { type: 'boolean', description: '是否是你推荐的那个' },
          },
          required: ['label'],
        },
      },
    },
    required: ['question', 'options'],
  },
};

/**
 * 生图。只在平台配了生图通道时才挂上去（AGENT_IMAGE_MODELS）。
 *
 * 不挂的时候模型压根不知道有这回事——这正是要的：它不会承诺"我给你画一张"
 * 然后画不出来。
 *
 * 说明里写死了三件实测出来的事（尺寸不可控、一张约 2 MB、按张计费），因为
 * 模型读工具说明比读系统提示认真，而这三件事直接决定它该不该多调几次。
 */
export const IMAGE_TOOL: ToolDef = {
  name: 'generate_image',
  description:
    '生成一张图片并存进工作区，页面用相对路径引用它。'
    + '用于插图、封面、空状态配图这类"没有现成素材"的地方。'
    + '注意：①尺寸由网关决定、传不了参数，页面要用 CSS 适配（object-fit 之类）；'
    + '②一张约 2 MB，别为了装饰多生；③按张计费，一次会话最多几张。'
    + '能用 CSS、SVG、emoji 解决的，不要生图。',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '画什么。具体些：主体、风格、配色、有没有文字（文字常画歪，尽量别要）',
      },
      path: {
        type: 'string',
        description: '存到工作区的哪里，相对路径，如 assets/hero.png。扩展名按实际格式自动改正',
      },
      model: { type: 'string', description: '可选。平台配了多条生图通道时指定用哪条' },
    },
    required: ['prompt', 'path'],
  },
};

export const ALL_TOOLS: ToolDef[] = [...FILE_TOOLS, ...PLATFORM_TOOLS, ASK_TOOL];

/** 平台开了生图时用这一套。由服务端按配置决定传哪个（见 routes/agent.ts）。 */
export const TOOLS_WITH_IMAGE: ToolDef[] = [...ALL_TOOLS, IMAGE_TOOL];

/** 一个待回答的问题。前端照它画选项卡片。 */
export interface PendingAsk {
  question: string;
  options: { label: string; hint?: string; recommended?: boolean }[];
}

/** 从 ask_user 的调用参数里解出问题。参数不成形时返回 null——那就当普通工具结果。 */
export function parseAsk(args: Record<string, unknown>): PendingAsk | null {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw.slice(0, 4).flatMap((o) => {
    const rec = o as Record<string, unknown>;
    const label = typeof rec?.label === 'string' ? rec.label.trim() : '';
    if (!label) return [];
    return [{
      label,
      ...(typeof rec.hint === 'string' && rec.hint.trim() ? { hint: rec.hint.trim() } : {}),
      ...(rec.recommended === true ? { recommended: true } : {}),
    }];
  });
  if (!question || options.length < 2) return null;
  return { question, options };
}

export interface ToolContext {
  ws: WorkspaceContext;
  /** 平台侧回调。由 agent-service 注入，包内不直接碰数据库。 */
  platform: {
    getQuota(): Promise<string>;
    listApps(): Promise<string>;
    /** 返回一次性确认 token，交给手机端。 */
    requestDeploy(site: string, summary: string): Promise<{ confirmToken: string }>;
    /**
     * 生图。没配生图通道时不注入——那时 IMAGE_TOOL 也不会挂上去，
     * 两边是同一个开关的两面。
     */
    generateImage?: ImageGenerator;
  };
}

/** 执行一次工具调用。返回给模型看的文本结果。 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'list_files': {
      const dir = safePath(ctx.ws, String(args.path ?? '.'));
      if (!existsSync(dir)) return `目录不存在：${args.path ?? '.'}`;
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, MAX_ENTRIES)
        .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${relative(ctx.ws.root, join(dir, e.name)) || e.name}`);
      return lines.length ? lines.join('\n') : '（空目录）';
    }

    case 'read_file': {
      const f = safePath(ctx.ws, String(args.path));
      if (!existsSync(f)) return `文件不存在：${args.path}`;
      const buf = await readFile(f);
      if (buf.byteLength > MAX_FILE_BYTES) {
        return `文件过大（${Math.round(buf.byteLength / 1024)} KB），超过 ${MAX_FILE_BYTES / 1024} KB 上限，未读取。`;
      }
      return buf.toString('utf8');
    }

    case 'write_file': {
      const f = safePath(ctx.ws, String(args.path));
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          `写入内容超过 ${MAX_FILE_BYTES / 1024} KB 上限`,
        );
      }
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, content, 'utf8');
      return `已写入 ${args.path}（${Buffer.byteLength(content)} 字节）`;
    }

    case 'delete_file': {
      const f = safePath(ctx.ws, String(args.path));
      if (!existsSync(f)) return `文件不存在：${args.path}`;
      await rm(f, { force: true });
      return `已删除 ${args.path}`;
    }

    case 'get_quota':
      return ctx.platform.getQuota();

    case 'list_apps':
      return ctx.platform.listApps();

    case 'generate_image': {
      const gen = ctx.platform.generateImage;
      if (!gen) {
        return '这个平台没有配生图通道。改用 CSS、SVG 或 emoji，别空着一个图位。';
      }
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return '要画什么没说清楚。给一句具体的描述再调。';

      /*
        先定路径再调接口：路径越界的话，那一次生图就是白花钱。
        safePath 抛的是 FORBIDDEN，会被上层当工具失败回灌给模型。
      */
      const want = String(args.path ?? '').trim() || 'assets/image.png';
      const img = await gen({
        prompt,
        model: typeof args.model === 'string' ? args.model : undefined,
      });
      /*
        扩展名按**实际格式**改正，不听模型的。它经常写 .jpg 而网关出的是
        png——浏览器多半能靠嗅探认出来，但发布后的站点带 nosniff，那时就是
        一个裂图，而且离生成已经很远，没人会想到是扩展名的事。
      */
      const ext = extFor(img.mime);
      const rel = want.replace(/\.[a-z0-9]+$/i, '') + ext;
      const file = safePath(ctx.ws, rel);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, img.bytes);
      return `已生成并写入 ${rel}（${Math.round(img.bytes.byteLength / 1024)} KB，${img.model}）。`
        + `页面里用相对路径引用它，尺寸交给 CSS。`;
    }

    case 'ask_user': {
      const ask = parseAsk(args);
      if (!ask) {
        return '这个问题不成形（要有 question 和至少两个 options）。要么补全再问，要么自己定。';
      }
      /*
        工具结果是给模型看的，而这一轮到此为止（session.ts 收到 ask_user
        就停）。写明"已经问出去了"，下一轮它看到的是用户的回答，不会以为
        自己的问题石沉大海又问一遍。
      */
      return `已把这个问题摆给用户，等他回答。他的回答会是下一条用户消息。`;
    }

    case 'request_deploy': {
      const r = await ctx.platform.requestDeploy(String(args.site), String(args.summary));
      return (
        `已提交发布请求，等待用户在手机上二次确认。\n` +
        `确认令牌：${r.confirmToken}\n` +
        `发布不会自动进行——这是平台层的硬性审批，不由你决定。`
      );
    }

    default:
      throw new IspaceError(ERROR_CODES.NOT_IMPLEMENTED, `未知工具：${name}`);
  }
}

export { safePath };
