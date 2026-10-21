import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { numEnv, type Engine } from './engine.js';
import { AgentSession } from './session.js';

/**
 * 设计扇出（新稿「创建 · 工作台」的第二段）。
 *
 * ┌─ 这一步在解决什么 ──────────────────────────────────────────────────┐
 * │ 一句话描述和一个成品页面之间，最说不清楚的是**长什么样**。原来的流  │
 * │ 程里模型自己挑一种风格直接做，人看到第一版才发现"不是我要的那种感   │
 * │ 觉"，于是整页重做——重做的成本比重新挑一次高得多。                  │
 * │                                                                      │
 * │ 扇出把这一步前置：几个方向并排出，人用眼睛挑一个，再照它往下做。    │
 * │ 每个方向只出一个自包含的 HTML，几轮就收，比做一个完整页面便宜得多。  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 这是整个平台里**唯一一处一次请求跑多个模型会话**的地方。N 个方向就是
 * N 倍的模型开销，所以：默认条数由平台配（AGENT_FANOUT_N），每个方向的轮次
 * 上限压到很低（DIR_MAX_TURNS），而且只有用户在第一道问题里明确选了「生成
 * 六版视觉设计」才会走到这里。不要把它变成默认路径。
 */

/** 一个视觉方向。名字与配色照新稿的 DIRS。 */
export interface DesignDirection {
  key: string;
  name: string;
  /** 卡片底色，用于还没生成好时的占位，也作为这一版的基调交给模型。 */
  bg: string;
  /** 这一版的主色。 */
  dot: string;
  /** 交给模型的一句话风格纲领。 */
  brief: string;
}

export const DESIGN_DIRECTIONS: DesignDirection[] = [
  {
    key: 'paper', name: '暖色纸感', bg: '#fbf3e0', dot: '#ee5c2a',
    brief: '暖米底色、近似纸张的质感，衬线标题，大量留白，强调阅读的安定感。',
  },
  {
    key: 'card', name: '清爽卡片', bg: '#ebf2fd', dot: '#316dc7',
    brief: '浅蓝灰底，内容分块落在白色圆角卡片里，层级靠阴影区分，干净利落。',
  },
  {
    key: 'dash', name: '数据仪表', bg: '#e4e1d9', dot: '#54524e',
    brief: '信息密度高，等宽数字，指标与表格优先，装饰克制到几乎没有。',
  },
  {
    key: 'night', name: '夜间黑板', bg: '#282522', dot: '#a26000',
    brief: '深色底、暖色高亮，像一块黑板；对比强，适合长时间盯着看。',
  },
  {
    key: 'mag', name: '杂志排版', bg: '#f1f0fb', dot: '#7a5fc9',
    brief: '大标题压住版面，栏宽错落，像一本杂志的跨页，强调编排的节奏。',
  },
  {
    key: 'sticker', name: '活泼贴纸', bg: '#e8f8ee', dot: '#008233',
    brief: '圆润的形状、明快的绿色点缀、轻微的投影，像一张张贴纸拼起来的。',
  },
];

/**
 * 「基于这一版再出」的几种（新稿方案卡片底部的 ✦、微调条的四颗和「更多类似」）。
 *
 * 方向纲领放在服务端，前端只说要哪一种：brief 是要进系统提示的，让前端传一段
 * 自由文本进来，等于每个按钮都能被改成任意提示词——没有必要开这个口子。
 *
 * 颜色只是卡片还没出来时的占位底色；「近似」「变体」沿用原稿那一版的。
 */
export type VariantKind = 'vary' | 'like' | 'bold' | 'warm' | 'simple' | 'night';

export const VARIANT_KINDS: Record<VariantKind, {
  label: string; brief: string; count: number; bg?: string; dot?: string;
}> = {
  vary: {
    label: '变体', count: 1,
    brief: '保留原稿的配色、字体和整体气质，换一种版式或信息编排，让人看到同一种感觉的另一种排法。',
  },
  like: {
    label: '近似', count: 2,
    brief: '和原稿非常接近：同一套配色与字体，只在布局细节和组件形态上做不同的取舍。',
  },
  bold: {
    label: '更大胆', count: 1, dot: '#cd2f3a',
    brief: '在原稿基础上更大胆：更强的对比、更大的标题、更有冲击力的用色，但结构别散。',
  },
  warm: {
    label: '更温暖', count: 1, bg: '#ffede0', dot: '#ee5c2a',
    brief: '在原稿基础上更温暖：偏暖的底色与主色，形状圆润一点，读起来更有亲和力。',
  },
  simple: {
    label: '简化', count: 1, bg: '#efece6', dot: '#72706a',
    brief: '在原稿基础上做减法：去掉次要的装饰和信息，留下最该看的那几样，留白更多。',
  },
  night: {
    label: '夜间版', count: 1, bg: '#282522', dot: '#a26000',
    brief: '同样的结构做一个深色版本：深底、暖色高亮，对比清楚但别生硬。',
  },
};

/** 原稿那一版。key / bg / dot 来自它那张卡片，html 是它写出来的那份文件。 */
export interface VariantBase {
  key: string;
  name: string;
  bg: string;
  dot: string;
}

/**
 * 某一种「再出」要跑哪几个方向。
 *
 * key 只取原稿 key 的第一段再接上种类：变体的变体一路叠下去，key 会越来越
 * 长（paper-bold-like-a-vary…）。每次扇出都写进自己的 runId 目录，同一次里
 * 不撞名就够了。名字同理只留第一段：「暖色纸感 · 近似 A」，而不是
 * 「暖色纸感 · 更大胆 · 近似 A」。
 */
export function variantDirections(base: VariantBase, kind: VariantKind): DesignDirection[] {
  const k = VARIANT_KINDS[kind];
  const root = base.key.split('-')[0] || 'base';
  const short = base.name.split(' · ')[0] || base.name;
  const one = (suffix: string, tag: string): DesignDirection => ({
    key: `${root}-${kind}${suffix}`,
    name: `${short} · ${k.label}${tag}`,
    bg: k.bg ?? base.bg,
    dot: k.dot ?? base.dot,
    brief: k.brief,
  });
  if (k.count === 1) return [one('', '')];
  return Array.from({ length: k.count }, (_, i) => {
    const letter = String.fromCharCode(65 + i);
    return one(`-${letter.toLowerCase()}`, ` ${letter}`);
  });
}

/** 原稿进系统提示的上限。一版草案一般十几 KB；再大就截，别把上下文撑爆。 */
const BASE_HTML_MAX = 40_000;

/** 每个方向最多跑几轮。出一个单文件页面用不了几轮，跑飞了也就到此为止。 */
const DIR_MAX_TURNS = 4;

/** 平台配的条数。超出方向表就按方向表的长度来。 */
export function fanoutCount(env: NodeJS.ProcessEnv = process.env): number {
  /* 空串不能当 0：那会把六个方向悄悄缩成一个——见 numEnv 的说明 */
  const raw = numEnv(env.AGENT_FANOUT_N, DESIGN_DIRECTIONS.length);
  return Math.max(1, Math.min(DESIGN_DIRECTIONS.length, Math.round(raw)));
}

export type FanoutEvent =
  | { type: 'dir_start'; index: number; key: string; name: string }
  | { type: 'dir_done'; index: number; key: string; name: string; turns: number; ms: number; path: string }
  | { type: 'dir_error'; index: number; key: string; name: string; message: string }
  | { type: 'all_done'; ok: number; failed: number };

export interface FanoutOptions {
  /**
   * 每个方向用一个独立的 Engine 实例。共用一个也行，但独立的更容易限速。
   *
   * 把方向传进来，是为了让调用方（以及测试）能按方向区别对待——六个方向
   * 是并行起的，谁先拿到引擎取决于前面那个 mkdir 谁先完成，靠调用次序去
   * 对号入座是不稳的（测试里实打实时过时不过）。
   */
  engine: (d: DesignDirection) => Engine;
  /** 工作区根目录的绝对路径。产物写在它下面的 outRel 里。 */
  workspaceRoot: string;
  /** 产物相对目录，如 `_fanout/ab12`。每个方向写 `<outRel>/<key>/index.html`。 */
  outRel: string;
  /** 用户那句话。 */
  prompt: string;
  /** 手机为主 / 电脑为主 / 两边都要。影响每一版的布局基调。 */
  device: 'phone' | 'pc' | 'both';
  dirs: DesignDirection[];
  /**
   * 基于哪一版再出。给了就把原稿整份放进每个方向的系统提示——比让它自己
   * read_file 省一轮，也不用为此多给一个读文件的工具。
   */
  base?: { name: string; html: string };
  onEvent?: (e: FanoutEvent) => void;
  signal?: AbortSignal;
}

const DEVICE_LINE = {
  phone: '主要在手机上看：竖屏优先，单列，点击目标别小于 44px。',
  pc: '主要在电脑上看：可以用更宽的版心和多列，信息密度可以高一些。',
  both: '手机和电脑都要能看：用能自然塌成一列的布局。',
};

function systemPromptFor(
  d: DesignDirection,
  device: FanoutOptions['device'],
  outPath: string,
  base?: FanoutOptions['base'],
): string {
  const html = base && base.html.length > BASE_HTML_MAX
    ? `${base.html.slice(0, BASE_HTML_MAX)}\n<!-- 后面截掉了 -->`
    : base?.html;
  const from = base
    ? `
这一版是在「${base.name}」那一版的基础上改的。保留它的内容和大的骨架，按上面的方向调整视觉。原稿：
<原稿>
${html}
</原稿>
`
    : '';
  return `你是 iSpace 平台的视觉方向设计师。用户描述了他想要的页面，你只负责出**一个方向的视觉草案**。

这一版的方向是「${d.name}」：${d.brief}
基调色：底 ${d.bg}，主色 ${d.dot}。
${DEVICE_LINE[device]}
${from}
硬性要求：
- **只写一个文件**：\`${outPath}\`。用 write_file 写，写完就结束，不要再调别的工具。
- 这个文件必须自包含：样式写在 <style> 里，不引外部 CSS/JS/字体/图片，不发任何网络请求。
  它是给人**看一眼挑方向**用的，不是最终页面。
- 用中文写真实感的占位内容（标题、几条示例数据），不要 Lorem ipsum，也不要写
  「这里是标题」这种占位话——人要靠它判断"做出来大概是这个样子"。
- 页面要能在一屏到两屏内说清楚这个方向长什么样，不要做成一个完整应用。
- 不写交互逻辑，顶多一点 CSS 过渡。

写完用一句话说明这一版的取舍，不超过 30 个字。`;
}

/**
 * 并行跑若干方向，每个方向写一个自包含 HTML。
 *
 * 全部并行而不是排队：人在等的是"六张卡片陆续出现"，排队会把最后一张拖到
 * 六倍的时间。单个方向失败不影响其余——它那张卡片标成失败，其余照常可挑。
 */
export async function runFanout(opts: FanoutOptions): Promise<{ ok: number; failed: number }> {
  const emit = opts.onEvent ?? (() => {});
  let ok = 0;
  let failed = 0;

  await Promise.all(opts.dirs.map(async (d, index) => {
    const rel = `${opts.outRel}/${d.key}/index.html`;
    const started = Date.now();
    emit({ type: 'dir_start', index, key: d.key, name: d.name });

    try {
      await mkdir(join(opts.workspaceRoot, opts.outRel, d.key), { recursive: true });
      const session = new AgentSession({
        engine: opts.engine(d),
        toolCtx: {
          ws: { root: opts.workspaceRoot, username: '' },
          platform: {
            getQuota: async () => '',
            listApps: async () => '',
            requestDeploy: async () => { throw new Error('设计方向不发布'); },
          },
        },
        systemPrompt: systemPromptFor(d, opts.device, rel, opts.base),
        /* 只给写文件：这一步不需要读、不需要删，更不需要发布 */
        tools: [WRITE_ONLY],
        maxTurns: DIR_MAX_TURNS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      const r = await session.send(opts.prompt);
      /*
        模型可能一轮都没写就说完了（它有时会"先问一句"）。那样这张卡片没有
        东西可看——与其让人点开一个 404，不如当场补一个说明页，并算作失败。
      */
      const wrote = session.messages.some(
        (m) => m.role === 'assistant' && (m.toolCalls ?? []).some((c) => c.name === 'write_file'),
      );
      if (!wrote) {
        await writeFile(join(opts.workspaceRoot, rel), placeholder(d), 'utf8');
        throw new Error('这一版没有写出页面');
      }
      ok += 1;
      emit({
        type: 'dir_done', index, key: d.key, name: d.name,
        turns: r.turns, ms: Date.now() - started, path: rel,
      });
    } catch (e) {
      failed += 1;
      emit({
        type: 'dir_error', index, key: d.key, name: d.name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }));

  emit({ type: 'all_done', ok, failed });
  return { ok, failed };
}

/** 一张没出来的卡片里放什么。比空白好：它说明了发生了什么。 */
function placeholder(d: DesignDirection): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${d.name}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${d.bg};
color:#292724;font:14px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif;text-align:center}
p{margin:6px 0;color:#6b6762;font-size:13px}</style>
<div><strong>${d.name}</strong><p>这一版没能出来，换一个方向看看。</p></div>`;
}

/**
 * 扇出阶段唯一可用的工具。
 *
 * 不复用 FILE_TOOLS 里的那条：那条的说明是写给改项目的场景的（「父目录会
 * 自动创建」），而这里要把"只许写这一个文件"说在工具本身上——模型读工具
 * 说明比读系统提示更认真。
 */
const WRITE_ONLY = {
  name: 'write_file',
  description: '写入这一版的页面文件。只写系统提示里指定的那一个路径，写完即可结束。',
  parameters: {
    type: 'object' as const,
    properties: {
      path: { type: 'string' as const, description: '系统提示里给的那个路径，原样填' },
      content: { type: 'string' as const, description: '完整的 HTML' },
    },
    required: ['path', 'content'],
  },
};
