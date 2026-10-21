import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { extractZip } from '@ispace/storage';
import type { EngineMessage } from '@ispace/agent';
import { registerAgentHarnessRoutes, snapshotsFor } from '../routes/agent-harness.js';
import { MemoryAgentStore } from '../services/agent-store.js';
import { SessionWorkspaces } from '../services/session-workspace.js';
import { sessionTitle, toView, userText } from '../services/session-view.js';
import { Workspaces } from '../services/workspaces.js';
import { zipDir } from '../services/zip.js';

/**
 * 创建屏顶栏那几颗：历史会话、版本记录、导出代码、复制为新页面。
 */

describe('库里的对话 → 给人看的对话流', () => {
  const msgs: EngineMessage[] = [
    {
      role: 'user',
      content: '【本次要修改的是我已发布的页面 /lixiao/zhoubao/，发布时请沿用 site="zhoubao" 覆盖它，不要新建页面。】\n'
        + '【工作区已切换到这个页面的文件。先 list_files 看看现在有什么，别照着前面的对话改。】\n'
        + '把标题改大\n（这里原本附了 1 张图，已不在上下文里。）'
        + '\n\n【我附了 2 个文件。它们存在 _uploads/ 下，不会跟着页面发布】\n'
        + '- 需求.md（存在 _uploads/需求.md）的文字内容：\n<<<\n# 周报\n>>>\n'
        + '- logo.png：图片，随这条消息附上了（存在 _uploads/logo.png）。',
    },
    { role: 'assistant', content: '我先看看', toolCalls: [{ id: 'a', name: 'read_file', arguments: { path: 'index.html' } }] },
    { role: 'tool', content: '<h1>周报</h1>', toolCallId: 'a' },
    { role: 'user', content: '（这是 screenshot_preview 截到的页面，平台自动附上的，不是用户发的消息。）' },
    { role: 'assistant', content: '改好了' },
    { role: 'user', content: '【前情提要】之前的对话太长……' },
    { role: 'user', content: '再加个备注栏' },
  ];

  it('只留人说的和模型说的：平台垫的前缀、附件块、截图消息、前情提要都不显示', () => {
    const v = toView(msgs);
    expect(v.map((s) => [s.me, s.text])).toEqual([
      [true, '把标题改大'],
      [false, '我先看看\n\n改好了'],
      [true, '再加个备注栏'],
    ]);
  });

  it('附件块里存进 _uploads/ 的文件认回来，刷新之后还点得开', () => {
    expect(toView(msgs)[0]!.files).toEqual([
      { name: '需求.md', path: '_uploads/需求.md', size: 0, mimeType: 'text/markdown' },
      { name: 'logo.png', path: '_uploads/logo.png', size: 0, mimeType: 'image/png' },
    ]);
  });

  it('用户自己以【开头的话不被削掉（只削整行的平台说明，而且至少留一行）', () => {
    expect(userText('【急】')).toBe('【急】');
    expect(userText('【急】周报页\n第二行')).toBe('【急】周报页\n第二行');
  });

  it('标题取第一句话的头一截', () => {
    expect(sessionTitle('做一个组里的值班排班表，每周轮一次')).toBe('组里的值班排班表');
    expect(sessionTitle('')).toBe('没有标题的页面');
  });
});

describe('打包 zip', () => {
  it('打出来的是标准 zip：平台自己的解压（yauzl）解得开，中文文件名与二进制原样', async () => {
    const src = mkdtempSync(join(tmpdir(), 'ispace-zip-'));
    mkdirSync(join(src, 'assets'));
    writeFileSync(join(src, 'index.html'), '<h1>值班</h1>'.repeat(200));
    writeFileSync(join(src, 'assets', '图标.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    mkdirSync(join(src, '_fanout'));
    writeFileSync(join(src, '_fanout', 'x.html'), 'draft');

    const buf = await zipDir(src, (rel) => !rel.startsWith('_'));
    const zipPath = join(mkdtempSync(join(tmpdir(), 'ispace-zipout-')), 'a.zip');
    writeFileSync(zipPath, buf!);
    const out = mkdtempSync(join(tmpdir(), 'ispace-unzip-'));
    await extractZip(zipPath, out);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('<h1>值班</h1>'.repeat(200));
    expect([...readFileSync(join(out, 'assets', '图标.png'))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    expect(existsSync(join(out, '_fanout'))).toBe(false);
  });

  it('空目录返回 null', async () => {
    expect(await zipDir(mkdtempSync(join(tmpdir(), 'ispace-zip-')), () => true)).toBeNull();
  });
});

describe('顶栏那几颗的接口', () => {
  let app: ReturnType<typeof Fastify>;
  let sw: SessionWorkspaces;
  let clock = 1_000;
  const busy = new Set<string>();
  const me = { id: 'u-me', username: 'lixiao' } as User;
  const other = { id: 'u-other', username: 'wangkai' } as User;
  const who: Record<string, User> = { me, other };

  beforeAll(async () => {
    sw = new SessionWorkspaces(
      new MemoryAgentStore(() => (clock += 1000)),
      new Workspaces(mkdtempSync(join(tmpdir(), 'ispace-hist-'))),
    );
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const maybe = err as { issues?: unknown };
      if (maybe.issues) return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT });
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerAgentHarnessRoutes(app, {
      requireAuth: async (req: FastifyRequest) => {
        const u = who[String(req.headers['x-test-user'] ?? '')];
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return u;
      },
      sessionWorkspaces: sw,
      isBusy: (id) => busy.has(id),
    });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  const req = (method: 'GET' | 'POST', url: string, payload?: unknown, user = 'me') => app.inject({
    method, url: `/deploy/api${url}`, headers: { 'x-test-user': user },
    ...(payload === undefined ? {} : { payload }),
  });

  /** 造一条会话：写个文件、存两句话。 */
  const made = async (first: string, user = me) => {
    const r = await sw.begin(user);
    writeFileSync(join(sw.ws.dir(user.username, r.workspace), 'index.html'), `<h1>${first}</h1>`);
    await sw.store.save(r.id, { messages: [{ role: 'user', content: first }, { role: 'assistant', content: '好' }] });
    return r;
  };

  it('历史会话：只列自己的、说过话的，新的在前，带标题', async () => {
    await sw.begin(me); // 开了创建屏就走了，一句话没说
    const a = await made('做一个值班排班表');
    const b = await made('做个午饭吃什么');
    await made('别人的页面', other);
    const items = (await req('GET', '/agent/sessions')).json().items as { id: string; title: string }[];
    expect(items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(items.map((i) => i.title)).toEqual(['午饭吃什么', '值班排班表']);
  });

  it('点开一条会话：给人看的对话流；不是自己的拒绝', async () => {
    const a = await made('做一个值班排班表');
    const v = (await req('GET', `/agent/session/${a.id}`)).json();
    expect(v.says).toEqual([{ me: true, text: '做一个值班排班表' }, { me: false, text: '好' }]);
    expect(v.title).toBe('值班排班表');
    expect((await req('GET', `/agent/session/${a.id}`, undefined, 'other')).statusCode).toBe(403);
    expect((await req('GET', '/agent/session/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('复制为新页面：文件拷进新工作区（不带 node_modules），对话与快照从头开始', async () => {
    const a = await made('原页面');
    const dir = sw.ws.dir('lixiao', a.workspace);
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '');
    await snapshotsFor(sw, 'lixiao', a.workspace).take({ sessionId: a.id, messageCount: 0, label: 'x' });

    const res = await req('POST', `/agent/session/${a.id}/fork`, {});
    const id = res.json().sessionId as string;
    const copy = (await sw.store.get(id))!;
    expect(copy.workspace).not.toBe(a.workspace);
    expect(copy.messages).toEqual([]);
    const cdir = sw.ws.dir('lixiao', copy.workspace);
    expect(readFileSync(join(cdir, 'index.html'), 'utf8')).toBe('<h1>原页面</h1>');
    expect(existsSync(join(cdir, 'node_modules'))).toBe(false);
    expect(await snapshotsFor(sw, 'lixiao', copy.workspace).list()).toEqual([]);

    busy.add(a.id);
    expect((await req('POST', `/agent/session/${a.id}/fork`, {})).statusCode).toBe(422);
    busy.delete(a.id);
  });

  it('版本记录：只列这条会话的，新的在前；退回到更早一步，之后的快照一并作废', async () => {
    const r = await sw.begin(me);
    const dir = sw.ws.dir('lixiao', r.workspace);
    const snaps = snapshotsFor(sw, 'lixiao', r.workspace);
    const msgs: EngineMessage[] = [];
    for (const [i, word] of ['第一句', '第二句', '第三句'].entries()) {
      await snaps.take({ sessionId: r.id, messageCount: msgs.length, label: word });
      writeFileSync(join(dir, 'index.html'), `v${i + 1}`);
      msgs.push({ role: 'user', content: word }, { role: 'assistant', content: `好${i + 1}` });
    }
    await sw.store.save(r.id, { messages: msgs });

    const list = (await req('GET', `/agent/versions?sessionId=${r.id}`)).json().items as { seq: number; label: string }[];
    expect(list.map((v) => v.label)).toEqual(['第三句', '第二句', '第一句']);

    /* 退回到「第二句」之前：文件是 v1，对话只剩第一轮，第二、三句的快照都没了 */
    const res = await req('POST', '/agent/restore', { sessionId: r.id, seq: list[1]!.seq });
    expect(res.json()).toMatchObject({ label: '第二句', left: 1 });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('v1');
    expect((await sw.store.get(r.id))!.messages.map((m) => m.content)).toEqual(['第一句', '好1']);
    const after = (await req('GET', `/agent/versions?sessionId=${r.id}`)).json().items as { label: string }[];
    expect(after.map((v) => v.label)).toEqual(['第一句']);

    expect((await req('POST', '/agent/restore', { sessionId: r.id, seq: list[0]!.seq })).statusCode).toBe(404);
    expect((await req('GET', `/agent/versions?sessionId=${r.id}`, undefined, 'other')).statusCode).toBe(403);
  });

  it('导出代码：zip 里是页面产物，不带草稿与附件；空工作区 404', async () => {
    const a = await made('导出');
    const dir = sw.ws.dir('lixiao', a.workspace);
    mkdirSync(join(dir, '_uploads'));
    writeFileSync(join(dir, '_uploads', '内部数据.xlsx'), 'secret');
    const res = await req('GET', `/agent/workspace/zip?sessionId=${a.id}&name=${encodeURIComponent('值班表')}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('值班表'));
    const zipPath = join(mkdtempSync(join(tmpdir(), 'ispace-dl-')), 'p.zip');
    writeFileSync(zipPath, res.rawPayload);
    const out = mkdtempSync(join(tmpdir(), 'ispace-dlx-'));
    await extractZip(zipPath, out);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('<h1>导出</h1>');
    expect(existsSync(join(out, '_uploads'))).toBe(false);

    const empty = await sw.begin(me);
    expect((await req('GET', `/agent/workspace/zip?sessionId=${empty.id}`)).statusCode).toBe(404);
  });
});
