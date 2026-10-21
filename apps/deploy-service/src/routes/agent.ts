import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import {
  availableFromRows, type ConnectorRow,
} from '../services/connectors-available.js';
import { getQuota, listAppsByOwner, writeAudit, type Sql } from '@ispace/db';
import {
  AgentSession, ALL_TOOLS, DESIGN_DIRECTIONS, MAX_IMAGES_PER_SESSION, TOOLS_WITH_IMAGE,
  configuredImageModels, configuredModels, createEngine, createImageGenerator, effortEnabled,
  fanoutCount, runFanout,
  type AvailableConnector, type FanoutEvent, type ImageGenerator, type ReasoningEffort,
  type SessionEvent,
  safePath,
  type ToolContext,
} from '@ispace/agent';
import { z } from 'zod';
import type { DeployInput, DeployOutcome } from '../services/deploy.js';

/**
 * Coding Agent 子系统（技术方案 §6）。
 *
 * 开发者身份的 App 首页即对话页：描述需求 → Agent 改代码 → 预览 → 二次确认部署。
 *
 * 三处与方案的实质差异，都有理由：
 *
 * 1. 引擎不是 Codex SDK。实测公司网关上 gpt-5.3-codex-spark 的工具调用
 *    arguments 恒为空，无法驱动 Agent；换 gpt-5.6 正常。方案 §6.6 要求的
 *    引擎抽象层正是为此存在，换实现不动上层。
 *
 * 2. 没有 Docker 沙箱，改为受控文件工具集。给 Agent 沙箱要么给本服务挂
 *    docker socket（开一个容器逃逸的口子），要么再起一套编排；而实际需要
 *    的能力只是"改这个项目的文件、走平台发布链路"，受控文件工具完全覆盖。
 *
 * 3. 会话存内存而非数据库。当前是单实例部署，重启丢会话可接受——用户重新
 *    描述一次即可，而为此引入会话持久化会带来消息裁剪、并发写等一堆问题。
 *    多实例部署时必须改，已在下方 NOTE 标明。
 *
 * 部署二次确认严格按方案 §6.2：审批收在平台层，手机端确认后签发一次性
 * token，部署工具校验 token 方可执行。比模型层审批更硬。
 */

const askSchema = z.object({
  sessionId: z.string().uuid().optional(),
  /**
   * 这次对话在改哪个页面（手机端底部「做点什么」顶部那条选的）。
   *
   * 不给的话模型只能从话里猜：用户说「把标题改大一点」，它得先想清楚
   * 是哪一个页面，猜错就把改动发布成了另一个 slug——用户看到的是
   * "我的页面变成两个了"。给了就没有歧义，也保证发布是覆盖而非新建。
   */
  targetSlug: z.string().max(64).optional(),
  text: z.string().min(1).max(4000),
  /**
   * 创建屏那两个菜单选的。
   *
   * 两个都只是「希望」：模型要在平台白名单里才作数（createEngine 校验），
   * 思考档位要平台开了 AGENT_EFFORT 才发给网关。前端传了而平台不支持时
   * 不报错——那不是用户的错，也不值得让一次生成失败。
   */
  model: z.string().max(64).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  images: z
    .array(z.object({ mimeType: z.string(), dataBase64: z.string() }))
    .max(4)
    .default([]),
});

/**
 * 设计扇出的产物目录（相对工作区）。
 *
 * 下划线开头是约定：发布链路按这个前缀把它整个排除在产物之外
 * （services/deploy.ts 的 copyFilter）。它是挑方向用的草案，不是页面的一
 * 部分，发出去只会让线上多出六个没人认识的地址。
 */
export const FANOUT_DIR = '_fanout';

const fanoutSchema = z.object({
  text: z.string().min(1).max(4000),
  /** 第一道问题问出来的：这页主要在哪儿看。 */
  device: z.enum(['phone', 'pc', 'both']).default('both'),
  model: z.string().max(64).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});

interface PendingDeploy {
  userId: string;
  site: string;
  summary: string;
  createdAt: number;
}

/**
 * 确认 token 的有效期。过期即失效，避免旧 token 被翻出来用。
 *
 * 30 分钟而不是原来的 10 分钟：这个令牌的使用场景是"页面做好了，人把它看一
 * 遍再决定发不发"——翻一翻预览、改两句话、去倒杯水，十分钟很容易就过了，
 * 回来点发布只看到一句「令牌无效或已过期」，而他什么都没做错。
 *
 * 放宽不动安全性质：它仍然是一次性的、绑定本人、只在服务端内存里，而且
 * 发布那一下仍要人亲自点。
 *
 * ⚠️ 它在内存里，服务重启即清空。重启后用户必须让 Agent 重新发起发布请求。
 */
const CONFIRM_TTL_MS = 30 * 60 * 1000;

/** 「代码」页一次最多显示多大的文件。再大就只给大小，不往回送内容。 */
const MAX_SHOWN_BYTES = 256 * 1024;
/** 文件树一次最多给多少条。模型不该写出几千个文件，真写了也先看前面这些。 */
const MAX_TREE_ENTRIES = 600;

/**
 * 走一遍工作区，给出扁平的路径表（前端自己摞成树）。
 *
 * 跳过 node_modules 与 .git：它们动辄上万个文件，而且不是人要看的东西。
 * `_fanout` 这类平台草稿**保留**——工作台的「代码」页本来就该让人看见
 * 那六版草案到底写了什么，它们也确实在工作区里。
 */
async function walkWorkspace(root: string): Promise<{ path: string; dir: boolean; size: number }[]> {
  const out: { path: string; dir: boolean; size: number }[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    if (out.length >= MAX_TREE_ENTRIES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_TREE_ENTRIES) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: rel, dir: true, size: 0 });
        await walk(join(dir, e.name), rel);
      } else if (e.isFile()) {
        const st = await stat(join(dir, e.name)).catch(() => null);
        out.push({ path: rel, dir: false, size: st?.size ?? 0 });
      }
    }
  }

  await walk(root, '');
  return out;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    workspaceRoot: string;
    requireAuth: (req: FastifyRequest) => Promise<User>;
    /** 发布链路。与 CLI / MCP 用的是同一个实例，发布语义只有一份。 */
    deployService: { deploy: (input: DeployInput) => Promise<DeployOutcome> };
    /**
     * 这个人此刻有没有一块活着的实时预览（创建屏开着就有，手机壳没有）。
     *
     * 查的是**服务端的真实状态**，不收前端的声明——前端能撒谎，而这句话会
     * 变成系统提示里的一段话（「你每写完一个文件它就刷新一次」）。对一个
     * 根本没有预览的会话说这句，模型会按"他正看着"去安排顺序，甚至回话里
     * 提"你右边应该已经能看到了"，而那边根本没有那块东西。
     *
     * 不传等同于没有——单测与不接预览的部署都走这一支。
     */
    hasLivePreview?: (userId: string) => boolean;
  },
): void {
  const { sql, workspaceRoot, requireAuth, deployService } = deps;
  const hasLivePreview = deps.hasLivePreview ?? (() => false);

  // NOTE(多实例)：会话与待确认 token 都在内存。横向扩容时必须外置到
  // Redis 或数据库，否则用户的下一个请求打到另一个实例就找不到会话了。
  const sessions = new Map<string, { session: AgentSession; userId: string; touched: number }>();

  /**
   * 这个人能用的连接器，喂给模型的系统提示。
   *
   * 为什么是系统提示而不是再加一个工具：见 packages/agent/src/session.ts 里
   * buildSystemPrompt 的说明。拼装与 MCP 共用 services/connectors-available.ts
   * ——两处说法不一致时，模型会在"我记得的"和"我刚查到的"之间摇摆。
   */
  async function availableConnectors(userId: string): Promise<AvailableConnector[]> {
    const rows = await sql<ConnectorRow[]>`
      SELECT slug, name, catalog_id, user_id FROM ispace.connectors
       WHERE user_id = ${userId} OR user_id IS NULL
       ORDER BY user_id IS NULL, slug
    `;
    return availableFromRows(rows);
  }

  const pending = new Map<string, PendingDeploy>();

  /** 定期清理过期会话与 token，防止内存无限增长。 */
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.touched > 60 * 60 * 1000) sessions.delete(k);
    for (const [k, v] of pending) if (now - v.createdAt > CONFIRM_TTL_MS) pending.delete(k);
  }, 5 * 60 * 1000).unref();

  /**
   * 这一次请求能生几张图。
   *
   * 计数放在**每次请求**上，不是每个会话：会话活一小时，而一次请求就是用户
   * 说的一句话。按会话算的话，一个人说十句就能生八十张——每张都是钱。
   *
   * 没配生图通道时返回 null，连同工具一起不挂（两边是同一个开关的两面）。
   */
  function makeImageGen(): ImageGenerator | null {
    const base = createImageGenerator();
    if (!base) return null;
    let used = 0;
    return async (opts) => {
      if (used >= MAX_IMAGES_PER_SESSION) {
        /* 契约里没有"通用配额"这个码，而这确实是一次被拒绝的调用 */
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          `这一轮已经生了 ${used} 张图，到上限了。把现有的用好，或者下一句话再说。`,
        );
      }
      used += 1;
      return base(opts);
    };
  }

  const makeToolCtx = (user: User, clientIp: string, drawer: ImageGenerator | null): ToolContext => ({
    ws: { root: join(workspaceRoot, user.username), username: user.username },
    platform: {
      async getQuota() {
        const q = await getQuota(sql, user.id);
        return [
          `静态空间 ${(q.storageBytesUsed / 1048576).toFixed(1)} MB / ${(q.storageBytesLimit / 1048576).toFixed(0)} MB`,
          `后端应用 ${q.backendCountUsed} / ${q.backendCountLimit} 个`,
          `数据行数 ${q.dbRowsUsed} / ${q.dbRowsLimit}`,
        ].join('\n');
      },
      async listApps() {
        const apps = await listAppsByOwner(sql, user.id);
        if (!apps.length) return '还没有已部署的应用。';
        return apps.map((a) => `${a.slug}  ${a.name}  ${a.status}`).join('\n');
      },
      async requestDeploy(site, summary) {
        // clientIp 由外层请求处理器捕获——这个闭包是给 Agent 工具集用的，
        // 调用时早已脱离 Fastify 的请求上下文。
        const confirmToken = randomBytes(16).toString('base64url');
        pending.set(confirmToken, { userId: user.id, site, summary, createdAt: Date.now() });
        await writeAudit(sql, {
          actorId: user.id, action: 'app.deploy', targetType: 'app', targetId: null,
          source: 'agent', result: 'success',
          metadata: { requested: true, site, summary },
          ip: clientIp,
        });
        return { confirmToken };
      },
      ...(drawer ? { generateImage: drawer } : {}),
    },
  });

  // ── 对话（SSE 流式）──────────────────────────────────────────────
  app.post(`${API_BASE}/agent/ask`, async (req, reply) => {
    const user = await requireAuth(req);
    /*
      原先这里按 identity 拦「非开发者」，配套的是壳设置里那个身份开关。
      现在手机端不再区分身份（对话是底部栏的一个 tab，人人可见），
      再拦就成了"点进去、打了字、发不出去"——用户没有任何办法自救，
      因为那个开关已经不存在了。

      能力边界仍在，只是换了把关的地方：Agent 的每个工具都以调用者身份
      执行，配额、归属、审计一个不少（见 makeToolCtx），发布还必须由人
      再点一次确认。
    */
    const input = askSchema.parse(req.body);

    let engine;
    try {
      engine = createEngine(process.env, {
        model: input.model,
        effort: input.effort as ReasoningEffort | undefined,
      });
    } catch {
      throw new IspaceError(
        ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
        'Agent 未配置模型通道，请联系平台管理员。',
      );
    }

    const wsRoot = join(workspaceRoot, user.username);
    await mkdir(wsRoot, { recursive: true });

    const sid = input.sessionId ?? crypto.randomUUID();
    let entry = sessions.get(sid);
    if (entry && entry.userId !== user.id) {
      // 会话 id 是 uuid，猜中概率极低，但仍要校验——否则知道 id 的人
      // 能读到别人的对话历史
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '这个会话不属于你');
    }
    /*
      生图通道配了才挂 generate_image，也才在系统提示里说"你能画"。
      两件事必须同进同出：说了却没挂，模型会写一个 <img src="assets/hero.png">
      然后发现没有那个工具，页面上留一个裂图。
    */
    const drawer = makeImageGen();

    if (!entry) {
      entry = {
        session: new AgentSession({
          engine, toolCtx: makeToolCtx(user, req.ip, drawer),
          connectors: await availableConnectors(user.id),
          livePreview: hasLivePreview(user.id),
          canDraw: drawer !== null,
          tools: drawer ? TOOLS_WITH_IMAGE : ALL_TOOLS,
        }),
        userId: user.id,
        touched: Date.now(),
      };
      sessions.set(sid, entry);
    }
    entry.touched = Date.now();

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // 关掉网关缓冲，否则 SSE 会被攒着一起发，前端看不到逐字输出
      'x-accel-buffering': 'no',
    });
    const send = (e: SessionEvent | { type: 'session'; id: string }) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    send({ type: 'session', id: sid });

    // 重建 session 以带上本次的事件回调
    const session = new AgentSession({
      engine,
      toolCtx: makeToolCtx(user, req.ip, drawer),
      connectors: await availableConnectors(user.id),
      livePreview: hasLivePreview(user.id),
      canDraw: drawer !== null,
      tools: drawer ? TOOLS_WITH_IMAGE : ALL_TOOLS,
      onEvent: send,
    });
    // 继承历史（除 system，构造时已有）
    session.messages.push(...entry.session.messages.slice(1));

    /*
      把对象作为一句前缀交给模型，而不是塞进 system。
      塞 system 会让整段历史都带着它，用户中途换了对象时，旧的那句还在
      上下文里跟新的打架。作为本轮的前缀，换了就自然只有新的生效。
    */
    const text = input.targetSlug
      ? `【本次要修改的是我已发布的页面 /${user.username}/${input.targetSlug}/，`
        + `发布时请沿用 site="${input.targetSlug}" 覆盖它，不要新建页面。】\n${input.text}`
      : input.text;

    try {
      const r = await session.send(text, input.images);
      /*
        把每一轮的结果记下来。

        线上出现过"模型一个字都不说、一个工具都不调就结束"，当时日志里只有
        一行 200 和耗时，完全看不出它是停在哪一步、用的哪个模型——查起来只能
        靠在容器里复现。这一行就是为了下次不用复现。
      */
      req.log.info({
        agent: {
          model: engine.model,
          stopReason: r.stopReason,
          turns: r.turns,
          tools: session.messages.filter((m) => m.role === 'tool').length,
          said: session.messages.some((m) => m.role === 'assistant' && m.content.trim().length > 0),
        },
      }, 'agent 一轮结束');
      entry.session.messages.length = 0;
      entry.session.messages.push(...session.messages);
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  /**
   * 设计扇出：并行跑几个方向，每个出一版自包含的 HTML。
   *
   * ┌─ 为什么单独一条路，不塞进 /agent/ask ──────────────────────────────┐
   * │ /agent/ask 是一条**会话**：有历史、有工具、会改用户的项目。扇出不  │
   * │ 是——它是 N 个互不相干的一次性任务，产物是草案而不是项目文件，而且 │
   * │ 结束之后那几个会话就该消失（留着只会把六版风格都压进后面的上下文）。│
   * │                                                                    │
   * │ 塞进去还要在那条会话里凭空多出一个"我现在在扇出"的状态机。分开之后 │
   * │ 两边都只做一件事：这条跑完就结束，用户挑中哪一版，由前端作为普通的 │
   * │ 一句话发回 /agent/ask——模型自己去 read_file 看那一版长什么样。      │
   * └────────────────────────────────────────────────────────────────────┘
   *
   * ⚠️ 这是全平台唯一一次请求跑多个模型会话的地方，N 倍开销。条数由
   * AGENT_FANOUT_N 配，前端也只在用户明确选了「生成六版视觉设计」时才打。
   */
  app.post(`${API_BASE}/agent/fanout`, async (req, reply) => {
    const user = await requireAuth(req);
    const input = fanoutSchema.parse(req.body);

    /* 先校验通道。没配就当场报，别等六个会话各报一次 */
    try {
      createEngine(process.env, { model: input.model });
    } catch {
      throw new IspaceError(
        ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
        'Agent 未配置模型通道，请联系平台管理员。',
      );
    }

    const wsRoot = join(workspaceRoot, user.username);
    await mkdir(wsRoot, { recursive: true });

    const runId = randomBytes(6).toString('base64url');
    const outRel = `${FANOUT_DIR}/${runId}`;
    const dirs = DESIGN_DIRECTIONS.slice(0, fanoutCount());

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: FanoutEvent | { type: 'run'; runId: string; dirs: unknown[] }) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };

    /*
      先把六张卡片的位置告诉前端（名字、配色、将来的路径），再开始跑。
      这样画廊一上来就是六个占位，而不是跑完一个冒出来一个——后者看起来
      像"还有几个"没人说得清。
    */
    send({
      type: 'run',
      runId,
      dirs: dirs.map((d, i) => ({
        index: i, key: d.key, name: d.name, bg: d.bg, dot: d.dot,
        path: `${outRel}/${d.key}/index.html`,
      })),
    });

    /* 客户端断开就别再烧模型了——六个会话一起跑，这一下省的是六份 */
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());

    try {
      await runFanout({
        engine: () => createEngine(process.env, {
          model: input.model,
          effort: input.effort as ReasoningEffort | undefined,
        }),
        workspaceRoot: wsRoot,
        outRel,
        prompt: input.text,
        device: input.device,
        dirs,
        onEvent: send,
        signal: abort.signal,
      });
      await writeAudit(sql, {
        actorId: user.id, action: 'agent.fanout', targetType: 'app', targetId: null,
        source: 'agent', result: 'success',
        metadata: { runId, count: dirs.length, device: input.device },
        ip: req.ip,
      });
    } catch (e) {
      send({
        type: 'dir_error', index: -1, key: '', name: '',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  /**
   * 工作区文件树与单个文件的内容（工作台的「代码」页）。
   *
   * ┌─ 为什么不让前端走预览那条路去读 ────────────────────────────────────┐
   * │ 预览伺服的是**渲染用的**字节流：HTML 会被注入 shim，响应带沙箱 CSP， │
   * │ 还会按 detectKind 换成说明页。拿它当"看源码"的接口，看到的不是模型  │
   * │ 写的那份东西。                                                      │
   * │                                                                      │
   * │ 而且预览只在创建屏开着时存在，文件树在发布之后也该能看。            │
   * └──────────────────────────────────────────────────────────────────────┘
   *
   * 边界和 Agent 的文件工具是同一条（safePath）：模型写得进哪里，这里才看得
   * 到哪里，两边说同一套话。只读，没有写入口——改文件是模型的事。
   */
  app.get(`${API_BASE}/agent/workspace`, async (req) => {
    const user = await requireAuth(req);
    const root = join(workspaceRoot, user.username);
    return { entries: await walkWorkspace(root) };
  });

  app.get(`${API_BASE}/agent/workspace/file`, async (req) => {
    const user = await requireAuth(req);
    const { path: rel } = z.object({ path: z.string().min(1).max(512) }).parse(req.query);
    const root = join(workspaceRoot, user.username);
    const abs = safePath({ root, username: user.username }, rel);

    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个文件。');
    if (st.size > MAX_SHOWN_BYTES) {
      return { path: rel, size: st.size, tooBig: true, text: '' };
    }
    const buf = await readFile(abs);
    /*
      二进制不往回送文本。前端拿到一堆乱码只会以为文件坏了——给它一个
      明确的 binary 标记，那边摆一行「这是图片/字体，右边预览里看」。
    */
    if (buf.includes(0)) return { path: rel, size: st.size, binary: true, text: '' };
    return { path: rel, size: st.size, text: buf.toString('utf8') };
  });

  // ── 二次确认：手机端点「部署上线」后调这里 ────────────────────────
  app.post(`${API_BASE}/agent/confirm`, async (req) => {
    const user = await requireAuth(req);
    const { confirmToken } = z.object({ confirmToken: z.string().min(1) }).parse(req.body);

    const p = pending.get(confirmToken);
    if (!p) {
      throw new IspaceError(
        ERROR_CODES.NOT_FOUND,
        `确认令牌无效或已过期（有效期 ${CONFIRM_TTL_MS / 60000} 分钟，服务重启也会清空）。`
        + '在左边说一句「可以发布了」，让它重新发起一次就行。',
      );
    }
    if (p.userId !== user.id) {
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '这个发布请求不属于你');
    }
    // 一次性：用掉即删，防止重放
    pending.delete(confirmToken);

    await writeAudit(sql, {
      actorId: user.id, action: 'app.deploy', targetType: 'app', targetId: null,
      source: 'agent', result: 'success',
      metadata: { confirmed: true, site: p.site, summary: p.summary },
      ip: req.ip,
    });

    return {
      ok: true,
      site: p.site,
      summary: p.summary,
      next: `已确认。请用 ai-deploy up 或 MCP 的 deploy 工具把工作区发布到 /${p.site}。`,
    };
  });

  /**
   * 确认并真的发布。
   *
   * ┌─ 为什么 /confirm 之外还要这一条 ──────────────────────────────────┐
   * │ /confirm 只是「人点头了」：它核销 token、写一条审计，然后回一句  │
   * │ 「请用 ai-deploy up 或 MCP 的 deploy 工具把工作区发到 /xxx」。在  │
   * │ 手机壳里这句话说得通——那边的人本来就是回电脑上接着用 CLI 的。    │
   * │                                                                   │
   * │ 改版稿的「创建」屏不是这样：人在浏览器里说一句话、看着预览、点   │
   * │ 「发布到我的空间」，这一下之后页面就该在线。中间再让他去装个 CLI  │
   * │ 等于这一屏没做完。所以这里把最后一步接上：核销 token，然后把工作 │
   * │ 区当产物走一遍正规发布链路（扫描、base path 校验、注入 chrome、  │
   * │ 落 release、切软链），和 CLI 发布一字不差。                       │
   * └───────────────────────────────────────────────────────────────────┘
   *
   * 二次确认没有被绕过：token 仍然由 Agent 的 request_deploy 发起、由人这
   * 一次点击核销，一次性。少掉的只是「换个工具再发一遍」。
   */
  app.post(`${API_BASE}/agent/publish`, async (req) => {
    const user = await requireAuth(req);
    const { confirmToken, name } = z
      .object({ confirmToken: z.string().min(1), name: z.string().max(32).optional() })
      .parse(req.body);

    const p = pending.get(confirmToken);
    if (!p) {
      throw new IspaceError(
        ERROR_CODES.NOT_FOUND,
        `确认令牌无效或已过期（有效期 ${CONFIRM_TTL_MS / 60000} 分钟，服务重启也会清空）。`
        + '在左边说一句「可以发布了」，让它重新发起一次就行。',
      );
    }
    if (p.userId !== user.id) {
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '这个发布请求不属于你');
    }
    pending.delete(confirmToken);

    /*
      产物就是这个人的工作区。Agent 的文件工具只能写在这里面
      （makeToolCtx 的 ws.root），所以"工作区"与"他刚做出来的东西"是同一
      回事；deploy 会把它拷进暂存目录再发，不动原件。
    */
    const outcome = await deployService.deploy({
      user,
      slug: p.site,
      srcDir: join(workspaceRoot, user.username),
      name,
      source: 'agent',
      clientIp: req.ip,
    });
    return { ...outcome, summary: p.summary };
  });

  // ── 待确认列表（手机端拉取）──────────────────────────────────────
  app.get(`${API_BASE}/agent/pending`, async (req) => {
    const user = await requireAuth(req);
    /*
      **最新的排在前面**。

      Map 的自然顺序是插入顺序，也就是最旧在前；而调用方（创建屏、手机壳）
      取的都是第一条。一个人十分钟内做了两个页面时，第一条是上一个页面的
      令牌——它马上就要过期，于是点发布报「确认令牌无效或已过期」，而他刚
      做好的那个明明还新鲜。线上实测踩过。
    */
    const items = [...pending.entries()]
      .filter(([, v]) => v.userId === user.id)
      .map(([token, v]) => ({ confirmToken: token, site: v.site, summary: v.summary, createdAt: v.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt);
    return { items };
  });

  app.get(`${API_BASE}/agent/status`, async () => {
    let configured = true;
    let model = '';
    try { model = createEngine().model; } catch { configured = false; }
    /*
      模型清单与思考档位都来自环境变量，和「配没配通道」是两件事：没配通道
      时清单仍然答得出来（前端据此知道菜单该列什么），只是点了会报没配。
    */
    return {
      configured,
      model,
      models: configuredModels(),
      effort: effortEnabled(),
      /* 生图是另一条通道，和对话模型分开配。空数组 = 平台没有这个能力 */
      imageModels: configuredImageModels(),
      activeSessions: sessions.size,
    };
  });
}
