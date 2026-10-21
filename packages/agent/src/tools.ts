import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
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
 * │ 搜索、写文件、补丁式修改、拷贝、删文件，全部限定在这次会话的工作区内，│
 * │ 路径经 resolve 后必须仍在工作区下，否则拒绝。                         │
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
  /** 这次会话的工作区的绝对路径（/srv/workspaces/{username}/{会话id}/）。所有文件操作限定在此之下。 */
  root: string;
  username: string;
}

/** 单文件读写上限。防止 Agent 一次读进一个几十 MB 的文件把上下文撑爆。 */
const MAX_FILE_BYTES = 256 * 1024;
/** 目录列举上限。 */
const MAX_ENTRIES = 300;
/** copy_file 的上限。与附件上限一致：附得进来的就拷得动。 */
const MAX_COPY_BYTES = 10 * 1024 * 1024;

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
    description:
      '写入（覆盖）工作区里的某个文件。父目录会自动创建。'
      + '只用于新建文件或整页重写；改已有文件里的几处，用 edit_file。',
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
    name: 'edit_file',
    description:
      '把文件里的一段原文换成新文字，其余部分原样不动。改已有文件时优先用它，而不是 write_file 整页重写。'
      + 'old_string 必须与文件内容逐字一致（含缩进与换行），并且在文件里只出现一次——'
      + '出现多次会报错，那就多带几行上下文让它唯一；确实要全部替换时设 replace_all。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        old_string: { type: 'string', description: '要被替换的原文，逐字照抄' },
        new_string: { type: 'string', description: '换成的新文字。可以为空（即删掉这段）' },
        replace_all: { type: 'boolean', description: '把所有出现处都换掉。默认 false' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'copy_file',
    description:
      '把工作区里的一个文件拷到另一个位置（图片、字体这类二进制也行）。'
      + '用户附的文件存在 _uploads/ 下、不会跟着页面发布；要用到页面里（比如拿他附的照片当头图），'
      + '先用它拷到 assets/ 之类的位置，再用相对路径引用。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件，相对工作区，如 _uploads/photo.png' },
        to: { type: 'string', description: '目标路径，相对工作区，如 assets/photo.png' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'search_files',
    description:
      '在工作区里按正则搜文件内容，返回「文件:行号: 片段」。改之前先用它找到要改的地方，'
      + '比把文件一个个读进来省得多。默认不搜 node_modules 和平台草稿（_ 开头的顶层目录）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则，如 innerHTML\\s*=' },
        path: { type: 'string', description: '只在这个子目录里搜，省略则搜整个工作区' },
        include: { type: 'string', description: '只搜文件名匹配的，如 *.html 或 *.{js,css}' },
        ignore_case: { type: 'boolean', description: '忽略大小写。默认 false' },
      },
      required: ['pattern'],
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
    name: 'check_publishable',
    description:
      '发布前自检：在工作区上跑一遍发布链路同一套扫描（硬编码密钥、XSS 写法、根绝对路径），'
      + '把命中项按「文件:行号:规则:建议」列出来。request_deploy 之前必须先调它并把命中项修干净'
      + '——这些问题到发布那一下一样会被拦，那时候用户已经在等了。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'request_deploy',
    description:
      '请求把当前工作区发布到用户空间。需要用户在手机上二次确认——调用后会返回一个待确认状态，' +
      '不会立即发布。这是有意的：发布是对外可见的动作，必须由人点头。' +
      '调用前先用 check_publishable 自检；自检没过的工作区，这里也会拒绝。',
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

/**
 * 让模型看见自己做出来的页面。
 *
 * ┌─ 为什么要它，有实时预览不就够了吗 ──────────────────────────────────┐
 * │ 实时预览是给**人**看的。模型那边只收得到预览回流的报错——脚本抛了  │
 * │ 异常它知道，但"按钮叠在标题上""手机上横向溢出了""深色背景上的字看 │
 * │ 不清"这类不报错的毛病，它完全看不见，只能靠读自己的代码去猜。      │
 * │                                                                    │
 * │ 截一张图回给它，它就能像人一样"看一眼、发现不对、改掉"。截图器是  │
 * │ 现成的（发布时补封面用的那个 chromium），不用新增任何东西。          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 和生图一样是条件挂载：机器上没有 chromium（本机 dev）就不挂，模型也就不会
 * 承诺"我截个图看看"然后截不出来。
 *
 * 说明里写死了它的盲区：截的是 file://，所以走连接器取数的区域是空的、根
 * 绝对路径的资源加载不到。不写的话，模型看到一块空白会以为是自己写错了，
 * 去改一段本来没问题的代码。
 */
export const SCREENSHOT_TOOL: ToolDef = {
  name: 'screenshot_preview',
  description:
    '把工作区里的页面在无头浏览器里打开并截一张图给你看，用来检查排版、溢出、配色这类不报错的问题。'
    + '一次要十几秒，写完一版或改完布局后截一次，别每改一行就截。'
    + '盲区：截的是本地文件，走 /deploy/api/connect 取数的区域会是空的；根绝对路径（/x.js）的资源也加载不到。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要截的 HTML，相对工作区。省略则截 index.html' },
      device: {
        type: 'string',
        enum: ['phone', 'pc'],
        description: 'phone 是 390×844 的手机竖屏，pc 是 1280×800。省略则用 phone',
      },
    },
  },
};

/**
 * 计划模式用的工具（改版稿「先出计划，你确认后再动手」）。
 *
 * ┌─ 为什么是一个工具，而不是让模型"把计划说出来" ──────────────────────┐
 * │ 说出来的计划只是一段文字，前端认不出哪几行是计划、也就没法让人逐条 │
 * │ 改。走工具则拿到的是结构化的 steps[]，界面可以摆成一张卡、可以回灌 │
 * │ 修改意见，而模型这一轮也会在这里停住——它调完这个就没别的可做了。   │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export const PLAN_TOOL: ToolDef = {
  name: 'propose_plan',
  description:
    '先把要做的事列成几步给用户看，等他点头再动手。计划模式下**必须先调它**：'
    + '没有被确认的计划之前，写文件、改文件、删文件都会被拒绝。'
    + '列 3–6 步，每步一句话，说清楚要做什么而不是怎么写代码。'
    + '调完就停下，不要在同一轮里接着改文件——用户要先看一眼。',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: '按顺序的几步，每步一句话',
      },
      note: { type: 'string', description: '可选：一句补充说明，比如哪里还不确定' },
    },
    required: ['steps'],
  },
};

export const ALL_TOOLS: ToolDef[] = [...FILE_TOOLS, ...PLATFORM_TOOLS, ASK_TOOL];

/** 平台开了生图时用这一套。由服务端按配置决定传哪个（见 routes/agent.ts）。 */
export const TOOLS_WITH_IMAGE: ToolDef[] = [...ALL_TOOLS, IMAGE_TOOL];

/**
 * 按平台此刻真有的能力拼工具表。
 *
 * 生图、截图都是"有才挂"：工具挂上去了就得真能调，调不了就别让模型看见。
 * 两个开关各自独立，所以用拼的，而不是再穷举出四个常量。
 */
export function toolsFor(
  opts: { canDraw?: boolean; canSee?: boolean; canPlan?: boolean } = {},
): ToolDef[] {
  return [
    ...ALL_TOOLS,
    ...(opts.canDraw ? [IMAGE_TOOL] : []),
    ...(opts.canSee ? [SCREENSHOT_TOOL] : []),
    /* 不在计划模式时不挂：挂了模型会在普通对话里也先来一份计划，白绕一圈 */
    ...(opts.canPlan ? [PLAN_TOOL] : []),
  ];
}

/** 从 propose_plan 的参数里解出计划。不成形就返回 null，当普通工具结果处理。 */
export function parsePlan(args: Record<string, unknown>): { steps: string[]; note?: string } | null {
  const raw = Array.isArray(args.steps) ? args.steps : [];
  const steps = raw
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0)
    .slice(0, 8);
  if (!steps.length) return null;
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
  return note === undefined ? { steps } : { steps, note };
}

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
    /**
     * 发布前自检：跑发布链路同一套扫描，但只报告、不发布。
     *
     * 由服务端实现，因为"同一套"要落到字面上——产物根怎么认、哪些草稿目录
     * 不算产物，这些判据都在发布链路里（services/preflight.ts），在包里另写
     * 一份迟早和真发布对不上：自检说没问题，点发布照样被拦。
     */
    checkPublishable?: () => Promise<PublishCheck>;
    /** 截图。机器上没有 chromium 时不注入，SCREENSHOT_TOOL 也就不挂。 */
    screenshot?: (opts: { path: string; device: 'phone' | 'pc' }) => Promise<ToolImage>;
  };
  /**
   * 计划模式的闸门：计划还没被用户确认之前，不许动文件。
   *
   * ┌─ 为什么要在这里真拦，而不是只写在提示词里 ──────────────────────┐
   * │ 「先出计划，你确认后再动手」如果只靠提示词，模型兴致一来照样会先 │
   * │ 写两个文件再说——而用户点「确认」的时候，东西已经改完了。那这句  │
   * │ 承诺就是假的。                                                   │
   * │                                                                  │
   * │ 拦在工具执行这一层，它就是真的：写、改、删、发布一律被拒，拒的   │
   * │ 时候把该干什么告诉模型（先调 propose_plan），它自己会走回正路。   │
   * └──────────────────────────────────────────────────────────────────┘
   *
   * 这不是安全边界——计划模式是用户自己给自己定的规矩，开关也在他手里。
   * 它要防的是"模型抢跑"，不是防人。
   */
  planGate?: boolean;
}

/** 计划没点头之前不许用的工具。读、搜、问都不拦——那些正是做计划要用的。 */
const PLAN_BLOCKED = new Set([
  'write_file', 'edit_file', 'copy_file', 'delete_file', 'request_deploy', 'generate_image',
]);

/** 一张交给模型看的图。 */
export interface ToolImage { mimeType: string; dataBase64: string }

/**
 * 工具结果。绝大多数只有文字；screenshot_preview 还要带一张图回去。
 *
 * 图不能塞进 role='tool' 的消息里——OpenAI 兼容协议的工具结果只收文本。
 * 所以会话循环（session.ts）把它们攒起来，等这一轮的工具结果都回灌完，
 * 再作为一条带图的 user 消息补在后面。
 */
export interface ToolOutput { text: string; images?: ToolImage[] }

/** 自检的结果。findings 与发布链路的扫描一一对应，路径是相对工作区的。 */
export interface PublishCheck {
  findings: { file: string; line: number; rule: string; advice: string }[];
  /** 发布链路认不出产物时（比如还没有 index.html）给的那句话。有它就没有 findings。 */
  error?: string;
}

/** 检查结果最多列这么多条。真有上百条，先修前面这些，模型自然会再调一次。 */
const MAX_CHECK_LINES = 40;

/** 把自检结果写成模型照着就能改的一段话。 */
export function formatPublishCheck(r: PublishCheck): string {
  if (r.error) return `自检没法进行：${r.error}`;
  if (!r.findings.length) {
    return '自检通过：密钥、XSS 写法、根绝对路径都没有命中，可以 request_deploy 了。'
      + '（真发布时还会再跑一道 gitleaks 深度扫描。）';
  }
  const lines = r.findings.slice(0, MAX_CHECK_LINES)
    .map((f) => `${f.file}:${f.line}:${f.rule}:${f.advice}`);
  const more = r.findings.length > MAX_CHECK_LINES
    ? `\n……还有 ${r.findings.length - MAX_CHECK_LINES} 处没列出。`
    : '';
  return `自检没过，共 ${r.findings.length} 处，发布时会被原样拦下（文件:行号:规则:建议）：\n`
    + `${lines.join('\n')}${more}\n`
    + '逐条改掉（小改用 edit_file），改完再调一次 check_publishable，干净了再 request_deploy。';
}

/** 执行一次工具调用。返回给模型看的文本结果（截图之类的附图丢弃——要图用 runToolOutput）。 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return (await runToolOutput(ctx, name, args)).text;
}

/** 同 runTool，但带上工具产出的图。会话循环用这个。 */
export async function runToolOutput(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  if (ctx.planGate && PLAN_BLOCKED.has(name)) {
    return {
      text:
        `现在是计划模式，用户还没确认计划，${name} 先不能用。\n`
        + '请先调 propose_plan 把要做的几步列出来，然后停下等他点头。'
        + '需要先看看现在有什么，read_file、list_files、search_files 都可以照常用。',
    };
  }
  if (name === 'screenshot_preview') {
    const shoot = ctx.platform.screenshot;
    if (!shoot) return { text: '这个平台截不了图（没有无头浏览器）。靠预览回流的报错和读代码判断。' };
    const rel = String(args.path ?? '').trim() || 'index.html';
    const file = safePath(ctx.ws, rel);
    if (!existsSync(file)) return { text: `文件不存在：${rel}。先把页面写出来再截。` };
    const device = args.device === 'pc' ? 'pc' : 'phone';
    const img = await shoot({ path: rel, device });
    return {
      text: `已截图 ${rel}（${device === 'pc' ? '电脑 1280×800' : '手机 390×844'}），图在下一条消息里。`
        + '看看排版、溢出、对比度有没有问题；取数区域为空是截图的盲区，不是 bug。',
      images: [img],
    };
  }
  return { text: await runTextTool(ctx, name, args) };
}

async function runTextTool(
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

    case 'edit_file':
      return editFile(ctx.ws, args);

    case 'search_files':
      return searchFiles(ctx.ws, args);

    case 'copy_file': {
      const from = safePath(ctx.ws, String(args.from ?? ''));
      const to = safePath(ctx.ws, String(args.to ?? ''));
      const st = await stat(from).catch(() => null);
      if (!st?.isFile()) return `源文件不存在：${args.from}`;
      if (st.size > MAX_COPY_BYTES) {
        throw new IspaceError(ERROR_CODES.INVALID_INPUT, `文件 ${Math.round(st.size / 1048576)} MB，超过 ${MAX_COPY_BYTES / 1048576} MB 上限`);
      }
      await mkdir(join(to, '..'), { recursive: true });
      await copyFile(from, to);
      return `已把 ${args.from} 拷到 ${args.to}（${Math.round(st.size / 1024)} KB）。页面里用相对路径引用它。`;
    }

    case 'delete_file': {
      const f = safePath(ctx.ws, String(args.path));
      if (!existsSync(f)) return `文件不存在：${args.path}`;
      await rm(f, { force: true });
      return `已删除 ${args.path}`;
    }

    case 'check_publishable': {
      const check = ctx.platform.checkPublishable;
      if (!check) return '这个平台没有接发布前自检。发布时仍会扫描，被拦下会告诉你原因。';
      return formatPublishCheck(await check());
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
      /*
        自检没过就不签令牌。

        系统提示里已经要求"先 check_publishable 再 request_deploy"，但提示只是
        请求，模型会忘。这里把它落成硬的：同一套扫描在这一刻再跑一遍，命中就
        把结果回给模型、不发令牌。否则用户会拿到一个发布按钮，点下去才被拦
        ——线上 zongkelong/tianqi 就是这样卡住的（innerHTML = 变量）。
      */
      if (ctx.platform.checkPublishable) {
        const pre = await ctx.platform.checkPublishable();
        if (pre.error || pre.findings.length) {
          return `发布请求没有提交。${formatPublishCheck(pre)}`;
        }
      }
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

// ── edit_file ────────────────────────────────────────────────────────

/**
 * 补丁式编辑：把一段原文换成新文字。
 *
 * ┌─ 为什么要求 old_string 唯一，而不是"替换第一处" ────────────────────┐
 * │ 页面里重复的片段多得很：每张卡片都是 `<div class="card">`，每个按钮  │
 * │ 都有 `onclick=`。模型说"把这个换掉"时，心里想的是某一处；替换第一处 │
 * │ 等于替它猜，猜错了改坏的是别处，而且它自己不会发现。                 │
 * │                                                                      │
 * │ 报错让它多带两行上下文，代价是多一轮；换来的是"改的就是它想改的那   │
 * │ 处"。这正是从 write_file 整页重写换成补丁的初衷——别把别处改坏。     │
 * └──────────────────────────────────────────────────────────────────────┘
 */
async function editFile(ws: WorkspaceContext, args: Record<string, unknown>): Promise<string> {
  const rel = String(args.path ?? '');
  const f = safePath(ws, rel);
  if (!existsSync(f)) return `文件不存在：${rel}。新文件用 write_file 写。`;

  const oldS = typeof args.old_string === 'string' ? args.old_string : '';
  const newS = typeof args.new_string === 'string' ? args.new_string : '';
  const all = args.replace_all === true;
  if (!oldS) {
    throw new IspaceError(ERROR_CODES.INVALID_INPUT, 'old_string 不能为空。要整页重写用 write_file。');
  }
  if (oldS === newS) {
    throw new IspaceError(ERROR_CODES.INVALID_INPUT, 'old_string 和 new_string 一模一样，改了等于没改。');
  }

  const buf = await readFile(f);
  if (buf.byteLength > MAX_FILE_BYTES) {
    return `文件过大（${Math.round(buf.byteLength / 1024)} KB），超过 ${MAX_FILE_BYTES / 1024} KB 上限，没有改。`;
  }
  const text = buf.toString('utf8');
  const hits = indicesOf(text, oldS);

  if (hits.length === 0) {
    throw new IspaceError(ERROR_CODES.INVALID_INPUT, `在 ${rel} 里没找到 old_string。${missHint(text, oldS)}`);
  }
  if (hits.length > 1 && !all) {
    const at = hits.slice(0, 8).map((i) => lineAt(text, i)).join('、');
    throw new IspaceError(
      ERROR_CODES.INVALID_INPUT,
      `old_string 在 ${rel} 里出现了 ${hits.length} 次（第 ${at} 行），不知道你要改哪一处。`
      + '多带几行上下文让它只出现一次；确实要全部替换就设 replace_all: true。',
    );
  }

  const next = all
    ? text.split(oldS).join(newS)
    : text.slice(0, hits[0]!) + newS + text.slice(hits[0]! + oldS.length);
  if (Buffer.byteLength(next) > MAX_FILE_BYTES) {
    throw new IspaceError(ERROR_CODES.INVALID_INPUT, `改完会超过 ${MAX_FILE_BYTES / 1024} KB 上限，没有改。`);
  }
  await writeFile(f, next, 'utf8');

  /*
    回一小段改完的样子（带行号）。模型据此确认改对了，不用再 read_file 把整个
    文件读一遍——那会把省下来的 token 又花回去。
  */
  const start = lineAt(text, hits[0]!);
  const span = newS.split('\n').length;
  return `已修改 ${rel}：替换 ${all ? hits.length : 1} 处，从第 ${start} 行起。\n`
    + numbered(next, Math.max(1, start - 2), start + span + 1);
}

function indicesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** 字符下标所在的行号（从 1 起）。 */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

/** 第 from 到 to 行，带行号。最多 14 行——它是确认用的，不是第二次 read_file。 */
function numbered(text: string, from: number, to: number): string {
  const lines = text.split('\n');
  const end = Math.min(lines.length, to, from + 13);
  const out: string[] = [];
  for (let n = from; n <= end; n++) out.push(`${String(n).padStart(5)}  ${lines[n - 1] ?? ''}`);
  return out.join('\n');
}

/**
 * 没找到时给一句能照着做的话。
 *
 * 最常见的两种原因都能当场认出来：空白对不上（缩进是两格还是四格、模型
 * 自己补了个尾随空格），或者原文早被上一次修改改掉了。分别说，比一句
 * "没找到"让它少猜一轮。
 */
function missHint(text: string, oldS: string): string {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (squash(oldS) && squash(text).includes(squash(oldS))) {
    return '去掉空白差异后能对上——缩进或换行和原文不一致。先 read_file 看原文，逐字照抄。';
  }
  const first = oldS.split('\n').map((l) => l.trim()).find((l) => l.length >= 4);
  if (first) {
    const at = text.split('\n')
      .flatMap((l, i) => (l.includes(first) ? [i + 1] : []))
      .slice(0, 5);
    if (at.length) return `它的第一行出现在第 ${at.join('、')} 行，后面几行对不上。先 read_file 看看那里现在长什么样。`;
  }
  return '原文可能已经被改过了。先 read_file 或 search_files 找到现在的样子再改。';
}

// ── search_files ─────────────────────────────────────────────────────

/** 结果条数上限。再多说明搜得太宽，让模型缩小范围，而不是把上下文撑爆。 */
const MAX_SEARCH_RESULTS = 80;
/** 一次最多看这么多个文件。 */
const MAX_SEARCH_FILES = 2000;
/** 单文件超过这个大小就不搜：多半是打包产物或数据，搜出来也没法改。 */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/**
 * 每行只拿前这么多字符去匹配。
 *
 * 压缩过的 JS 一行就是几百 KB，正则在上面跑一个回溯就能卡住整个
 * deploy-service——它是单线程的，卡住的是所有人的请求。
 */
const MAX_SEARCH_LINE = 2000;

/**
 * 嵌套量词，形如 (a+)+、(\w*)*、(x+){2,}。
 *
 * 这一类是灾难性回溯的典型写法，在一行稍长的文本上就能指数级地跑下去。
 * 模型写正则不会想到这一层，所以在这里直接拒绝，让它换个写法。
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/;

async function searchFiles(ws: WorkspaceContext, args: Record<string, unknown>): Promise<string> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern) throw new IspaceError(ERROR_CODES.INVALID_INPUT, 'pattern 不能为空。');
  if (pattern.length > 300) throw new IspaceError(ERROR_CODES.INVALID_INPUT, 'pattern 太长了，300 字以内。');
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new IspaceError(
      ERROR_CODES.INVALID_INPUT,
      '这个正则带嵌套量词（如 (a+)+），可能把服务卡死。换个不嵌套的写法。',
    );
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, args.ignore_case === true ? 'i' : '');
  } catch (e) {
    throw new IspaceError(
      ERROR_CODES.INVALID_INPUT,
      `正则写错了：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const base = safePath(ws, String(args.path ?? '.'));
  if (!existsSync(base)) return `目录不存在：${args.path ?? '.'}`;
  const include = typeof args.include === 'string' && args.include.trim()
    ? globToRegExp(args.include.trim())
    : null;

  const hits: string[] = [];
  let total = 0;
  let files = 0;

  const visit = async (abs: string): Promise<void> => {
    if (files >= MAX_SEARCH_FILES) return;
    const st = await stat(abs).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      const entries = await readdir(abs, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        /* 平台草稿（_fanout 之类）只在从根搜时跳过；显式指定 path 进去搜就照搜 */
        if (abs === ws.root && e.name.startsWith('_')) continue;
        await visit(join(abs, e.name));
      }
      return;
    }
    if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) return;
    if (include && !include.test(basename(abs))) return;
    const buf = await readFile(abs);
    if (buf.includes(0)) return; // 图片、字体这类二进制
    files += 1;
    const rel = relative(ws.root, abs);
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.slice(0, MAX_SEARCH_LINE);
      if (!re.test(line)) continue;
      total += 1;
      if (hits.length < MAX_SEARCH_RESULTS) {
        const t = line.trim();
        hits.push(`${rel}:${i + 1}: ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`);
      }
    }
  };
  await visit(base);

  if (!total) return `没有匹配 /${pattern}/ 的内容（搜了 ${files} 个文件）。`;
  const more = total > hits.length
    ? `\n……共 ${total} 处，只列了前 ${hits.length} 处。用 path 或 include 缩小范围。`
    : '';
  return `${hits.join('\n')}${more}`;
}

/** *.html、*.{js,css}、page-?.md 这几种就够了。匹配的是文件名，不含目录。 */
function globToRegExp(glob: string): RegExp {
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { src += '\\{'; continue; }
      src += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
      i = end;
    } else src += escapeRe(c);
  }
  return new RegExp(`^${src}$`, 'i');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { safePath };
