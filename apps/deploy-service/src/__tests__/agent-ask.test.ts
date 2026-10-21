import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import type { Engine, EngineEvent, EngineMessage } from '@ispace/agent';
import { registerAgentRoutes } from '../routes/agent.js';
import { snapshotsFor } from '../routes/agent-harness.js';
import type { DeployInput } from '../services/deploy.js';
import { MemoryAgentStore } from '../services/agent-store.js';
import { SessionWorkspaces } from '../services/session-workspace.js';
import { Workspaces } from '../services/workspaces.js';
import { publish, tempStorage, withFiles } from './release-fixture.js';

/**
 * 一句话从进门到落盘：/agent/ask 的整条接线。
 *
 * 引擎换成按脚本出事件的假引擎，其余全是真的——真的工作区目录、真的发布前
 * 自检（发布链路那套扫描）、真的快照、内存版会话存储。要钉住的是这些零件
 * **接在一起**之后的行为：
 *   - 附件落到这条会话的 _uploads/，文字交给了模型
 *   - 每一句开工前拍了快照，撤回能退回去
 *   - 历史存下来了，下一句接得上
 *   - 自检没过拿不到发布令牌；过了，发布的是这条会话的工作区，并记下页面
 *   - 「改 /这个页面/」找回的是当初那个工作区；没有工作区的，从线上拷一份，
 *     并告诉模型这些文件哪来的（拷不了的，告诉它发出去会整页替换）
 */

type Script = EngineEvent[][];

/** 按排队的脚本出事件；每一次 run 吃掉一段。顺手记下模型每次被喂了什么。 */
class ScriptedEngine implements Engine {
  readonly name = 'scripted';
  readonly model = 'test';
  constructor(private readonly queue: Script, private readonly fed: EngineMessage[][]) {}
  async *run(input: { messages: EngineMessage[] }): AsyncGenerator<EngineEvent> {
    this.fed.push(input.messages.map((m) => ({ ...m })));
    for (const e of this.queue.shift() ?? [{ type: 'done' as const }]) yield e;
  }
}

const call = (name: string, args: Record<string, unknown>, id = name): EngineEvent =>
  ({ type: 'tool_call', call: { id, name, arguments: args } });
const say = (t: string): EngineEvent[] => [{ type: 'text', delta: t }, { type: 'done' }];

/** 只够这几条路由用的假 sql：查连接器返回空、写审计吞掉。 */
const fakeSql = Object.assign(async () => [], { json: (x: unknown) => x }) as never;

describe('/agent/ask 整条接线', () => {
  let app: ReturnType<typeof Fastify>;
  let sw: SessionWorkspaces;
  const queue: Script = [];
  const fed: EngineMessage[][] = [];
  const deployed: DeployInput[] = [];
  const me = { id: 'u-me', username: 'lixiao' } as User;
  const storage = tempStorage();

  beforeAll(async () => {
    sw = new SessionWorkspaces(new MemoryAgentStore(), new Workspaces(mkdtempSync(join(tmpdir(), 'ispace-ask-'))), storage);
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const maybe = err as { issues?: unknown };
      if (maybe.issues) return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT });
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerAgentRoutes(app, {
      sql: fakeSql,
      workspaceRoot: '/unused',
      sessionWorkspaces: sw,
      requireAuth: async (req: FastifyRequest) => {
        if (req.headers['x-test-user'] !== 'me') throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return me;
      },
      deployService: {
        deploy: async (input) => {
          deployed.push(input);
          return {
            app: { id: 'app-1', slug: input.slug } as never,
            release: { id: 'rel-1' } as never,
            url: `http://localhost/${input.user.username}/${input.slug}/`,
          };
        },
      },
      screenshot: null,
      makeEngine: () => new ScriptedEngine(queue, fed),
    });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  const post = (url: string, payload: unknown) => app.inject({
    method: 'POST', url: `/deploy/api${url}`, headers: { 'x-test-user': 'me' }, payload,
  });
  /** 发一句话，把 SSE 拆成事件。 */
  const ask = async (payload: Record<string, unknown>, script: Script) => {
    queue.push(...script);
    const res = await post('/agent/ask', payload);
    const events = res.body.split('\n\n').filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
    return { res, events };
  };
  const newSession = async () => (await post('/agent/session', {})).json().sessionId as string;
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('附件存进这条会话的 _uploads/，文字交给模型；文件写进它自己的工作区；历史存下来', async () => {
    const sid = await newSession();
    const { events } = await ask({
      sessionId: sid, text: '照这份需求做个周报页',
      files: [{ name: '需求.md', mimeType: 'text/markdown', dataBase64: b64('# 周报\n每周一更新') }],
    }, [
      [call('write_file', { path: 'index.html', content: '<h1>周报</h1>' }), { type: 'done' }],
      say('做好了'),
    ]);

    expect(events[0]).toEqual({ type: 'session', id: sid });
    expect(events[1]).toMatchObject({ type: 'attachments', files: [{ path: '_uploads/需求.md', kind: 'text' }] });
    const dir = sw.ws.dir('lixiao', sid);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<h1>周报</h1>');
    expect(readFileSync(join(dir, '_uploads', '需求.md'), 'utf8')).toContain('每周一更新');

    const firstUser = fed[fed.length - 2]!.find((m) => m.role === 'user')!;
    expect(firstUser.content).toContain('照这份需求做个周报页');
    expect(firstUser.content).toContain('# 周报');
    expect(firstUser.content).toContain('不会跟着页面发布');

    const rec = (await sw.store.get(sid))!;
    expect(rec.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(rec.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('下一句接得上历史；撤回把文件和对话一起退回这一句之前', async () => {
    const sid = await newSession();
    await ask({ sessionId: sid, text: '第一版' }, [
      [call('write_file', { path: 'index.html', content: 'v1' }), { type: 'done' }], say('好'),
    ]);
    await ask({ sessionId: sid, text: '改成第二版' }, [
      [call('edit_file', { path: 'index.html', old_string: 'v1', new_string: 'v2' }), { type: 'done' }], say('改了'),
    ]);
    /* 第二句时模型看到了第一句的历史 */
    expect(fed.at(-2)!.some((m) => m.content === '第一版')).toBe(true);
    const dir = sw.ws.dir('lixiao', sid);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('v2');

    const undo = await post('/agent/undo', { sessionId: sid });
    expect(undo.json()).toMatchObject({ label: '改成第二版' });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('v1');
    expect((await sw.store.get(sid))!.messages.some((m) => m.content.includes('改成第二版'))).toBe(false);
    expect((await snapshotsFor(sw, 'lixiao', sid).list()).filter((m) => m.sessionId === sid)).toHaveLength(1);
  });

  it('自检没过拿不到令牌；改干净了才有，发布发的是这条会话的工作区，并记下页面', async () => {
    const sid = await newSession();
    const { events } = await ask({ sessionId: sid, text: '做个天气页然后发布' }, [
      [call('write_file', { path: 'index.html', content: '<div id="b"></div>\n<script>b.innerHTML = data.html;</script>' }), { type: 'done' }],
      [call('request_deploy', { site: 'tianqi', summary: '天气页' }), { type: 'done' }],
      say('被拦了，我改'),
    ]);
    const deployResult = events.find((e) => e.type === 'tool_result' && e.name === 'request_deploy')!;
    expect(String(deployResult.result)).toContain('发布请求没有提交');
    expect(String(deployResult.result)).toContain('index.html:2:innerHTML-from-variable');
    let pend = (await app.inject({ method: 'GET', url: '/deploy/api/agent/pending', headers: { 'x-test-user': 'me' } })).json();
    expect(pend.items).toEqual([]);

    await ask({ sessionId: sid, text: '修掉再发' }, [
      [call('edit_file', { path: 'index.html', old_string: 'b.innerHTML = data.html', new_string: 'b.textContent = data.text' }), { type: 'done' }],
      [call('check_publishable', {}), { type: 'done' }],
      [call('request_deploy', { site: 'tianqi', summary: '天气页' }), { type: 'done' }],
      say('等你确认'),
    ]);
    pend = (await app.inject({ method: 'GET', url: '/deploy/api/agent/pending', headers: { 'x-test-user': 'me' } })).json();
    expect(pend.items).toHaveLength(1);

    const pub = await post('/agent/publish', { confirmToken: pend.items[0].confirmToken });
    expect(pub.statusCode).toBe(200);
    expect(deployed.at(-1)!.srcDir).toBe(sw.ws.dir('lixiao', sid));
    expect((await sw.store.get(sid))!.slug).toBe('tianqi');

    /* 手机壳里说「改 /tianqi/」：新会话，找回的是同一个工作区 */
    const { events: ev2 } = await ask({ targetSlug: 'tianqi', text: '标题改大' }, [say('好')]);
    const other = String(ev2[0]!.id);
    expect(other).not.toBe(sid);
    expect((await sw.store.get(other))!.workspace).toBe(sid);
  });

  it('改一个 CLI 发的页面：工作区从线上拷来，模型被告知；拷不了的，告诉它发出去会整页替换', async () => {
    await publish(storage, 'lixiao', 'cli-page', 1, withFiles({ 'index.html': '<head></head><h1>CLI 发的</h1>' }));
    const { events } = await ask({ targetSlug: 'cli-page', text: '标题改成红色' }, [
      [call('read_file', { path: 'index.html' }), { type: 'done' }],
      say('好'),
    ]);
    const read = events.find((e) => e.type === 'tool_result' && e.name === 'read_file')!;
    expect(String(read.result)).toContain('<h1>CLI 发的</h1>');
    expect(String(read.result)).not.toContain('data-ispace-shell');
    const told = fed.at(-2)!.filter((m) => m.role === 'user').at(-1)!.content;
    expect(told).toContain('线上版本的文件');

    await publish(storage, 'lixiao', 'next-page', 1, withFiles({ 'index.html': '<h1>x</h1>', '_next/a.js': 'x' }));
    await ask({ targetSlug: 'next-page', text: '改个字' }, [say('好')]);
    const warned = fed.at(-1)!.filter((m) => m.role === 'user').at(-1)!.content;
    expect(warned).toContain('_next');
    expect(warned).toContain('整页替换线上版本');
  });

  it('两次创建是两个工作区，第二个页面的文件不会混进第一个', async () => {
    const a = await newSession();
    const b = await newSession();
    await ask({ sessionId: a, text: 'A' }, [[call('write_file', { path: 'a.html', content: 'A' }), { type: 'done' }], say('ok')]);
    await ask({ sessionId: b, text: 'B' }, [[call('write_file', { path: 'b.html', content: 'B' }), { type: 'done' }], say('ok')]);
    expect(existsSync(join(sw.ws.dir('lixiao', a), 'b.html'))).toBe(false);
    expect(existsSync(join(sw.ws.dir('lixiao', b), 'a.html'))).toBe(false);
  });

  it('文件树与单个文件按会话取', async () => {
    const sid = await newSession();
    await ask({ sessionId: sid, text: 'x' }, [[call('write_file', { path: 'only-here.html', content: 'hi' }), { type: 'done' }], say('ok')]);
    const tree = await app.inject({ method: 'GET', url: `/deploy/api/agent/workspace?sessionId=${sid}`, headers: { 'x-test-user': 'me' } });
    expect(tree.json().entries.map((e: { path: string }) => e.path)).toContain('only-here.html');
    const file = await app.inject({ method: 'GET', url: `/deploy/api/agent/workspace/file?sessionId=${sid}&path=only-here.html`, headers: { 'x-test-user': 'me' } });
    expect(file.json().text).toBe('hi');
  });

  it('附件超个数是 4xx，而且在开流之前就拒绝', async () => {
    const one = { name: 'a.txt', mimeType: 'text/plain', dataBase64: b64('x') };
    const res = await post('/agent/ask', { text: 'x', files: Array(7).fill(one) });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
