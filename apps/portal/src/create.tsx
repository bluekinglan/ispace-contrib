import { useEffect, useRef, useState } from 'react';
import type { User } from '@ispace/contracts';
import { Icon, copyText } from '@ispace/ui';
import { api } from './api';
import { Segment } from './detail';
import { type Device } from './wall';

/**
 * 创建（改版稿 §创建 / §创建 · 生成）。
 *
 * 两态一屏：没开始生成时是「今天想做个什么页面？」加一个输入框；一旦开始，
 * 左边变成对话 + 进度，右边是预览和发布。
 *
 * ┌─ 和设计稿的差别，以及为什么 ──────────────────────────────────────┐
 * │ 1. 进度不是稿上那四步固定文案（理解需求 / 设计数据表 / 写页面 /   │
 * │    发布前检查），而是 Agent 真正做的事：它每调一次工具，这里就多  │
 * │    一行「写 index.html」。编四步假进度条，等于把"正在发生什么"换  │
 * │    成了一段动画——而真实的那几行恰恰是用户看得懂、也该看到的。    │
 * │ 2. 模型是一个灰色的名字，不是可选的下拉。平台只配了一条模型通道   │
 * │    （/agent/status 返回它），给个假下拉只会让人以为能换。        │
 * │ 3. 「添加内容」菜单稿上有五项，这里只留「上传图片」——Agent 接口  │
 * │    真正支持的就是图片（/agent/ask 的 images）。其余四项在设计稿里 │
 * │    也只是弹一句提示，不是做好的功能。                            │
 * └──────────────────────────────────────────────────────────────────┘
 */
export function Create({
  me, initialDraft, remix, onClearRemix, onMine, onToast,
}: {
  me: User;
  /** 从探索页那句话或「做同款」带进来的初稿。 */
  initialDraft: string;
  remix: { name: string; author: string } | null;
  onClearRemix: () => void;
  onMine: () => void;
  onToast: (t: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [gen, setGen] = useState<Gen | null>(null);

  useEffect(() => { setDraft(initialDraft); }, [initialDraft]);

  return gen
    ? (
      <Generating
        me={me}
        gen={gen}
        /* 收窄成「拿着当前的 Gen 算一个新的」：Generating 里不存在 gen 为空的情形 */
        setGen={(fn) => setGen((g) => (g ? fn(g) : g))}
        onMine={onMine}
        onToast={onToast}
      />
    )
    : (
      <Idle
        draft={draft} setDraft={setDraft} remix={remix} onClearRemix={onClearRemix}
        onStart={(text, images) => setGen(freshGen(text, images))}
        onToast={onToast}
      />
    );
}

// ── 没开始之前 ──────────────────────────────────────────────────────────
function Idle({
  draft, setDraft, remix, onClearRemix, onStart, onToast,
}: {
  draft: string;
  setDraft: (v: string) => void;
  remix: { name: string; author: string } | null;
  onClearRemix: () => void;
  onStart: (text: string, images: AgentImage[]) => void;
  onToast: (t: string) => void;
}) {
  const [sugTab, setSugTab] = useState(0);
  const [images, setImages] = useState<AgentImage[]>([]);
  const [model, setModel] = useState<string>('');
  const file = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void api.agentStatus()
      .then((s) => setModel(s.configured ? s.model : ''))
      .catch(() => setModel(''));
  }, []);

  const go = () => {
    const t = draft.trim();
    if (!t) { onToast('先说一句想做什么'); return; }
    onStart(t, images);
  };

  const mcp = `claude mcp add ai-deploy --transport http ${location.origin}/deploy/mcp`;
  const group = SUGS[sugTab]!;

  return (
    <div
      style={{
        maxWidth: 860, margin: '0 auto', padding: '9vh 32px 96px', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26,
      }}
    >
      <h1
        style={{
          margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500,
          fontSize: 'clamp(32px, 4vw, 50px)', lineHeight: 1.15,
          color: 'var(--text-heading)', textAlign: 'center',
        }}
      >
        今天想做个什么页面？
      </h1>

      <div
        style={{
          width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          gap: 8, padding: '16px 14px 12px 20px', borderRadius: 22,
          background: 'var(--surface-1)', border: '1px solid var(--prompt-border)',
          boxShadow: 'var(--prompt-sh)',
        }}
      >
        {remix && (
          <span
            style={{
              alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, height: 28,
              padding: '0 4px 0 10px', borderRadius: 'var(--radius-pill)',
              background: 'var(--brand-wash)', color: 'var(--text-heading)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
            }}
          >
            <Icon name="remix" size={13} />
            基于 {remix.author} 的「{remix.name}」
            <button
              onClick={onClearRemix}
              title="不基于它"
              style={{
                width: 22, height: 22, border: 0, borderRadius: 'var(--radius-pill)',
                background: 'transparent', color: 'var(--text-secondary)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}
            >
              <Icon name="close" size={13} />
            </button>
          </span>
        )}

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            go();
          }}
          rows={3}
          placeholder="说说它给谁用、要解决什么、数据从哪来。越具体，第一版越接近你要的。"
          style={{
            width: '100%', boxSizing: 'border-box', padding: 0, border: 0, outline: 'none',
            resize: 'none', background: 'transparent', fontSize: 15, lineHeight: 1.7,
            color: 'var(--text-primary)', fontFamily: 'inherit',
          }}
        />

        {images.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {images.map((im, i) => (
              <span
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 6px 0 10px',
                  borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)',
                  fontSize: 'var(--text-base)', color: 'var(--text-secondary)',
                }}
              >
                <Icon name="image" size={13} />{im.name}
                <button
                  onClick={() => setImages((prev) => prev.filter((_, k) => k !== i))}
                  style={{
                    width: 20, height: 20, border: 0, borderRadius: 'var(--radius-pill)',
                    background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={async (e) => {
              const picked = [...(e.target.files ?? [])].slice(0, 4);
              e.target.value = '';
              const next: AgentImage[] = [];
              for (const f of picked) next.push(await toAgentImage(f));
              setImages((prev) => [...prev, ...next].slice(0, 4));
            }}
          />
          <button
            onClick={() => file.current?.click()}
            title="上传图片"
            style={{
              width: 36, height: 36, border: 0, borderRadius: 'var(--radius-pill)',
              background: 'var(--surface-2)', color: 'var(--text-primary)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="plus" size={18} />
          </button>
          {model && (
            <span
              title="平台配置的模型通道，暂不支持切换"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 14px',
                borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)',
                color: 'var(--text-secondary)', fontSize: 'var(--text-md)',
                fontWeight: 'var(--weight-medium)', whiteSpace: 'nowrap',
              }}
            >
              {model}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={go}
            title="开始生成"
            style={{
              width: 38, height: 38, border: 0, borderRadius: 'var(--radius-pill)',
              background: draft.trim() ? 'var(--cta)' : 'var(--surface-3)',
              color: draft.trim() ? 'var(--cta-fg)' : 'var(--text-tertiary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="up" size={18} />
          </button>
        </div>
      </div>

      <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
        <span style={{ marginRight: 8, fontWeight: 'var(--weight-bold)', color: 'var(--text-secondary)' }}>Tips</span>
        页面自带数据库和登录，不用自己配后端。
        <a
          href="/console#backend"
          style={{ marginLeft: 8, color: 'var(--text-secondary)', textDecoration: 'underline', textUnderlineOffset: 3 }}
        >
          详情
        </a>
      </div>

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          {SUGS.map((g, i) => {
            const on = i === sugTab;
            return (
              <button
                key={g.label}
                onClick={() => setSugTab(i)}
                style={{
                  height: 34, padding: '0 14px', border: 0, borderRadius: 'var(--radius-pill)',
                  background: on ? 'var(--surface-3)' : 'transparent',
                  color: on ? 'var(--text-heading)' : 'var(--text-tertiary)',
                  fontSize: 'var(--text-base)',
                  fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                  cursor: on ? 'default' : 'pointer',
                }}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '2px 24px' }}>
          {group.items.map((s) => (
            <button
              key={s.title}
              onClick={() => setDraft(`做一个${s.title}：${s.detail}`)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 12px',
                border: 0, borderRadius: 10, background: 'transparent', color: 'var(--text-secondary)',
                fontSize: 'var(--text-md)', cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-2)';
                e.currentTarget.style.color = 'var(--text-heading)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--text-secondary)';
              }}
            >
              <Icon name="bulb" size={16} />{s.title}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          width: '100%', boxSizing: 'border-box', marginTop: 30, padding: 24, borderRadius: 22,
          background: 'var(--surface-sidebar)', display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
              已经在用 Claude 或 Codex？
            </span>
            <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              装一次 iSpace 连接，之后在对话里说「发到我的空间」，页面就上线了。
            </span>
          </div>
          <a
            href="/console#guide"
            style={{
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)', whiteSpace: 'nowrap',
            }}
          >
            完整接入指引 →
          </a>
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 10px 10px 16px',
            borderRadius: 14, background: 'var(--dark-bg)',
          }}
        >
          <span
            className="mono"
            style={{
              flex: 1, minWidth: 0, overflow: 'auto', whiteSpace: 'nowrap',
              fontSize: 'var(--text-base)', color: 'rgba(255,255,255,.88)',
            }}
          >
            {mcp}
          </span>
          <button
            onClick={() => void copyText(mcp).then((ok) => onToast(ok ? '命令已复制，在终端运行一次就好' : '复制不了，手动选中吧'))}
            style={{
              flex: 'none', height: 32, padding: '0 12px', border: 0, borderRadius: 9,
              background: 'rgba(255,255,255,.1)', color: '#fff', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            复制
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 生成中 / 生成完 ─────────────────────────────────────────────────────
interface AgentImage { name: string; mimeType: string; dataBase64: string }

interface Step { key: string; title: string; detail: string; done: boolean }

interface Gen {
  /** 第一句话。显示在左栏顶上那个气泡里。 */
  text: string;
  images: AgentImage[];
  title: string;
  /** Agent 发起发布请求时才知道要发到哪个 slug。 */
  site: string | null;
  confirmToken: string | null;
  sessionId: string | null;
  steps: Step[];
  /** 模型说的话，按轮次分段。 */
  says: { me: boolean; text: string }[];
  busy: boolean;
  publishedUrl: string | null;
}

const freshGen = (text: string, images: AgentImage[]): Gen => ({
  text, images, title: titleOf(text), site: null, confirmToken: null, sessionId: null,
  steps: [], says: [], busy: true, publishedUrl: null,
});

function Generating({
  me, gen, setGen, onMine, onToast,
}: {
  me: User;
  gen: Gen;
  setGen: (fn: (g: Gen) => Gen) => void;
  onMine: () => void;
  onToast: (t: string) => void;
}) {
  const [dev, setDev] = useState<Device>('phone');
  const [vis, setVis] = useState<'private' | 'shared' | 'public'>('private');
  const [follow, setFollow] = useState('');
  const [publishing, setPublishing] = useState(false);
  const log = useRef<HTMLDivElement | null>(null);

  /*
    第一句话在挂载时发出去，只发一次。

    守卫用 ref 而不是 state：严格模式会把 effect 跑两遍，而 setGen 是异步的
    ——第二遍读到的 started 还是 false，于是发了两次，对话里出现两条一模一样
    的回答（实测如此）。ref 的写入是同步的，第二遍立刻就能看见。
  */
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void run(gen.text, gen.images);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (text: string, images: AgentImage[]) => {
    setGen((g) => ({ ...g, busy: true }));
    try {
      await streamAsk({
        text,
        images,
        sessionId: gen.sessionId,
        onSession: (id) => setGen((g) => ({ ...g, sessionId: id })),
        onText: (delta) => setGen((g) => {
          const says = [...g.says];
          const last = says[says.length - 1];
          if (last && !last.me) says[says.length - 1] = { me: false, text: last.text + delta };
          else says.push({ me: false, text: delta });
          return { ...g, says };
        }),
        onTool: (name, args) => setGen((g) => ({
          ...g,
          /* 前一步到此为止——工具是顺序调的，新的一步开始就说明上一步做完了 */
          steps: [...g.steps.map((s) => ({ ...s, done: true })), toStep(name, args)],
          site: name === 'request_deploy' && typeof args.site === 'string' ? args.site : g.site,
        })),
        onError: (m) => {
          /*
            错误要留在对话里，不能只弹一个会自己消失的 toast：这一屏的左栏
            此刻只有用户自己那句话，toast 一淡出，他看到的就是"我说了一句，
            然后什么都没发生"。最常见的那条错误（平台没配模型通道）尤其
            需要留着——那不是重试能解决的，得去找管理员。
          */
          setGen((g) => ({ ...g, says: [...g.says, { me: false, text: `出错了：${m}` }] }));
          onToast(`出错了：${m}`);
        },
      });
    } finally {
      /* 发布请求的 token 在流结束后问服务端要——它是 Agent 调工具时生成的 */
      const pend = await api.agentPending().catch(() => ({ items: [] }));
      setGen((g) => ({
        ...g,
        busy: false,
        steps: g.steps.map((s) => ({ ...s, done: true })),
        confirmToken: pend.items[0]?.confirmToken ?? g.confirmToken,
        site: pend.items[0]?.site ?? g.site,
      }));
    }
  };

  const sendFollow = async () => {
    const t = follow.trim();
    if (!t || gen.busy) return;
    setFollow('');
    setGen((g) => ({ ...g, says: [...g.says, { me: true, text: t }] }));
    await run(t, []);
  };

  const publish = async () => {
    if (!gen.confirmToken || publishing) return;
    setPublishing(true);
    try {
      const r = await api.agentPublish(gen.confirmToken, gen.title);
      /*
        可见范围是发布之后的一次独立改动：发布链路本身只管"把东西放上去"，
        谁能看是 apps.visibility 那一列的事（和控制台里改它走同一条接口）。
      */
      if (vis !== 'private') await api.setVisibility(r.app.id, vis).catch(() => undefined);
      if (vis === 'public') await api.publishToMarket(r.app.id).catch(() => undefined);
      setGen((g) => ({ ...g, publishedUrl: r.url, confirmToken: null, site: r.app.slug }));
      onToast(`已发布到 ${r.url}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '发布失败');
    } finally { setPublishing(false); }
  };

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [gen.says, gen.steps]);

  const url = gen.publishedUrl
    ?? (gen.site ? `${location.origin}/${me.username}/${gen.site}/` : '');
  const shown = url.replace(/^https?:\/\//, '');

  return (
    <div style={{ height: '100%', minHeight: 560, display: 'flex' }}>
      {/* ── 左：对话与进度 ───────────────────────────────────────── */}
      <div
        style={{
          width: 'min(440px, 46%)', flex: 'none', display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border-tabby)',
        }}
      >
        <div style={{ padding: '4px 28px 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontFamily: 'var(--font-serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.2, color: 'var(--text-heading)' }}>
            {gen.title}
          </span>
          {shown && (
            <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              {shown}
            </span>
          )}
        </div>

        <div
          ref={log}
          style={{
            flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 28px 20px',
            display: 'flex', flexDirection: 'column', gap: 22,
          }}
        >
          <Bubble text={gen.text} />
          {gen.steps.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {gen.steps.map((s, i) => (
                <div key={`${s.key}-${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <span
                    style={{
                      width: 24, height: 24, flex: 'none', borderRadius: 'var(--radius-pill)',
                      background: s.done ? 'var(--success-subtle)' : 'var(--brand-wash)',
                      color: s.done ? 'var(--success)' : 'var(--tabby-orange)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Icon name={s.done ? 'check' : 'rotate'} size={13} />
                  </span>
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
                    <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
                      {s.title}
                    </span>
                    {s.detail && (
                      <span
                        className="mono"
                        style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)', wordBreak: 'break-all' }}
                      >
                        {s.detail}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {gen.says.map((m, i) => (
            m.me
              ? <Bubble key={i} text={m.text} />
              : (
                <div key={i} style={{ fontSize: 'var(--text-md)', lineHeight: 1.75, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                  {m.text}
                </div>
              )
          ))}
          {gen.busy && (
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>正在做…</span>
          )}
        </div>

        <div style={{ padding: '14px 20px 20px' }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 50, padding: '0 7px 0 16px',
              borderRadius: 16, background: 'var(--surface-1)', border: '1px solid var(--border)',
              boxShadow: '0 1px 3px rgba(0,0,0,.04)',
            }}
          >
            <input
              value={follow}
              onChange={(e) => setFollow(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                void sendFollow();
              }}
              placeholder={gen.busy ? '等这一轮做完再改' : '说说哪里要改，比如「换班加一个备注栏」'}
              disabled={gen.busy}
              style={{
                flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
                fontSize: 'var(--text-md)', color: 'var(--text-primary)', fontFamily: 'inherit',
              }}
            />
            <button
              onClick={() => void sendFollow()}
              title="发送"
              disabled={gen.busy}
              style={{
                width: 36, height: 36, flex: 'none', border: 0, borderRadius: 'var(--radius-pill)',
                background: gen.busy ? 'var(--surface-3)' : 'var(--cta)',
                color: gen.busy ? 'var(--text-tertiary)' : 'var(--cta-fg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: gen.busy ? 'default' : 'pointer',
              }}
            >
              <Icon name="up" size={17} />
            </button>
          </div>
        </div>
      </div>

      {/* ── 右：预览与发布 ───────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-sidebar)' }}>
        <div style={{ height: 60, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 20px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
            <Icon
              name={gen.publishedUrl ? 'check' : gen.busy ? 'rotate' : 'info'}
              size={15}
              color={gen.publishedUrl ? 'var(--success)' : 'var(--tabby-orange)'}
            />
            {gen.publishedUrl ? '已上线' : gen.busy ? '正在做，做完这里能预览' : '预览 · 还没发布'}
          </span>
          <Segment
            options={[
              { k: 'phone', label: '手机', icon: 'phone' },
              { k: 'pc', label: '电脑', icon: 'monitor' },
            ]}
            value={dev}
            onPick={(k) => setDev(k as Device)}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 24px 24px' }}>
          {dev === 'phone' ? (
            <div
              style={{
                height: '100%', maxHeight: 640, aspectRatio: '9 / 19.5', boxSizing: 'border-box',
                padding: 9, borderRadius: 44, background: '#0d0d10',
                boxShadow: '0 40px 80px -30px rgba(0,0,0,.35)',
              }}
            >
              <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 36, overflow: 'hidden', background: 'var(--surface-1)' }}>
                <PreviewBody url={gen.publishedUrl} phone />
              </div>
            </div>
          ) : (
            <div
              style={{
                width: '100%', maxWidth: 900, borderRadius: 16, overflow: 'hidden',
                background: 'var(--surface-1)',
                boxShadow: '0 40px 80px -30px rgba(0,0,0,.3), 0 0 0 1px rgba(0,0,0,.06)',
              }}
            >
              <div
                style={{
                  height: 38, display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px',
                  background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ display: 'flex', gap: 6, width: 46 }}>
                  {[0, 1, 2].map((k) => (
                    <span key={k} style={{ width: 10, height: 10, borderRadius: 'var(--radius-pill)', background: 'var(--surface-3)' }} />
                  ))}
                </div>
                <div
                  className="mono"
                  style={{
                    flex: 1, maxWidth: 440, height: 24, margin: '0 auto', borderRadius: 8,
                    background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
                    whiteSpace: 'nowrap', overflow: 'hidden',
                  }}
                >
                  {shown || '还没有地址'}
                </div>
                <div style={{ width: 46 }} />
              </div>
              <div style={{ position: 'relative', aspectRatio: '16 / 10', background: 'var(--surface-1)' }}>
                <PreviewBody url={gen.publishedUrl} phone={false} />
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            flex: 'none', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '14px 20px', borderTop: '1px solid var(--border-tabby)',
            background: 'var(--surface-canvas)',
          }}
        >
          {gen.publishedUrl ? (
            <>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
                <span
                  style={{
                    width: 22, height: 22, borderRadius: 'var(--radius-pill)',
                    background: 'var(--success-subtle)', color: 'var(--success)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Icon name="check" size={13} />
                </span>
                已发布
              </span>
              <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{shown}</span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => void copyText(gen.publishedUrl!).then((ok) => onToast(ok ? '地址已复制' : gen.publishedUrl!))}
                style={{
                  height: 40, padding: '0 14px', border: '1px solid var(--border-hover)',
                  borderRadius: 12, background: 'var(--surface-1)', color: 'var(--text-heading)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                复制地址
              </button>
              <button
                onClick={onMine}
                style={{
                  height: 40, padding: '0 16px', border: 0, borderRadius: 12,
                  background: 'var(--accent)', color: 'var(--accent-fg)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                去我的作品
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>谁能看</span>
              <Segment
                options={[
                  { k: 'private', label: '仅自己' },
                  { k: 'shared', label: '指定同事' },
                  { k: 'public', label: '全公司' },
                ]}
                value={vis}
                onPick={(k) => setVis(k as 'private')}
              />
              <div style={{ flex: 1 }} />
              {gen.confirmToken ? (
                <button
                  onClick={() => void publish()}
                  disabled={publishing}
                  style={{
                    height: 42, padding: '0 20px', border: 0, borderRadius: 12,
                    background: 'var(--cta)', color: 'var(--cta-fg)', fontSize: 'var(--text-md)',
                    fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                  }}
                >
                  {publishing ? '正在发布…' : '发布到我的空间'}
                </button>
              ) : (
                <span
                  title={gen.busy ? '' : '让它把页面写完，或者在左边说一句「可以发布了」'}
                  style={{
                    height: 42, padding: '0 20px', borderRadius: 12, background: 'var(--surface-3)',
                    color: 'var(--text-tertiary)', fontSize: 'var(--text-md)',
                    fontWeight: 'var(--weight-semibold)', display: 'flex', alignItems: 'center',
                  }}
                >
                  {gen.busy ? '生成中…' : '还没准备好发布'}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 发布前没有预览可看。
 *
 * 真实链路里，页面在"发布"之前只是用户工作区里的几个文件，没有任何地址能
 * 渲染它——设计稿那块骨架屏画的就是这个状态，这里照着摆。发布之后换成真
 * 页面的 iframe。
 */
function PreviewBody({ url, phone }: { url: string | null; phone: boolean }) {
  if (url) {
    return (
      <iframe
        src={url}
        title="预览"
        sandbox="allow-scripts allow-forms allow-popups"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    );
  }
  const bar = (w: string, h: number, r: number, bg: string) => (
    <div style={{ width: w, height: h, borderRadius: r, background: bg }} />
  );
  return phone ? (
    <div style={{ position: 'absolute', inset: 0, padding: '52px 18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {bar('55%', 22, 6, 'var(--surface-3)')}
      {bar('80%', 11, 4, 'var(--surface-2)')}
      {bar('100%', 128, 16, 'var(--surface-2)')}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {bar('100%', 72, 12, 'var(--surface-2)')}
        {bar('100%', 72, 12, 'var(--surface-2)')}
      </div>
      {bar('70%', 11, 4, 'var(--surface-2)')}
      {bar('46%', 11, 4, 'var(--surface-2)')}
    </div>
  ) : (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', gap: 18, padding: 24 }}>
      <div style={{ width: '22%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {bar('100%', 18, 5, 'var(--surface-3)')}
        {bar('100%', 11, 4, 'var(--surface-2)')}
        {bar('100%', 11, 4, 'var(--surface-2)')}
        {bar('70%', 11, 4, 'var(--surface-2)')}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {bar('40%', 24, 6, 'var(--surface-3)')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {bar('100%', 80, 12, 'var(--surface-2)')}
          {bar('100%', 80, 12, 'var(--surface-2)')}
          {bar('100%', 80, 12, 'var(--surface-2)')}
        </div>
        <div style={{ flex: 1, borderRadius: 14, background: 'var(--surface-2)' }} />
      </div>
    </div>
  );
}

function Bubble({ text }: { text: string }) {
  return (
    <div
      style={{
        alignSelf: 'flex-end', maxWidth: '88%', padding: '14px 16px',
        borderRadius: '18px 18px 6px 18px', background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)', fontSize: 'var(--text-md)',
        lineHeight: 1.7, color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}

// ── 与 Agent 的那条流 ───────────────────────────────────────────────────
/**
 * 逐字读 /agent/ask 的 SSE。
 *
 * 浏览器这边能真流式读（fetch + ReadableStream），所以不像手机壳那样要等
 * 整段回来再切——那边 React Native 的 fetch 不支持流式 body。
 */
async function streamAsk(opts: {
  text: string;
  images: AgentImage[];
  sessionId: string | null;
  onSession: (id: string) => void;
  onText: (delta: string) => void;
  onTool: (name: string, args: Record<string, unknown>) => void;
  onError: (message: string) => void;
}): Promise<void> {
  const res = await fetch('/deploy/api/agent/ask', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: opts.text,
      images: opts.images.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    /*
      服务端的错误是 {code, message} 的 JSON。整段打出来，用户看到的是
      一行带引号和花括号的东西——而 message 本身恰恰是写给他看的那句话
      （「Agent 未配置模型通道，请联系平台管理员」）。
    */
    const raw = await res.text().catch(() => '');
    let msg = raw.slice(0, 200);
    try {
      const body = JSON.parse(raw) as { message?: string };
      if (body.message) msg = body.message;
    } catch { /* 不是 JSON 就用原文 */ }
    opts.onError(msg || `接口返回 ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    /*
      SSE 的一帧以空行结束。按 \n\n 切，剩下的半帧留在 buf 里等下一个
      chunk——不留的话，一条正好被 TCP 切成两半的 JSON 会被丢掉。
    */
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line.slice(5)) as Record<string, unknown>; } catch { continue; }
        if (e.type === 'session') opts.onSession(e.id as string);
        else if (e.type === 'text') opts.onText(e.delta as string);
        else if (e.type === 'tool_start') opts.onTool(e.name as string, (e.args ?? {}) as Record<string, unknown>);
        else if (e.type === 'error') opts.onError(String(e.message));
      }
    }
  }
}

/** 工具名 → 人话。看不懂的工具名原样显示，总比吞掉好。 */
function toStep(name: string, args: Record<string, unknown>): Step {
  const path = typeof args.path === 'string' ? args.path : '';
  const map: Record<string, [string, string]> = {
    list_files: ['看看空间里有什么', ''],
    read_file: ['读文件', path],
    write_file: ['写文件', path],
    delete_file: ['删文件', path],
    get_quota: ['查一下配额', ''],
    list_apps: ['看已有的页面', ''],
    request_deploy: ['准备发布', typeof args.site === 'string' ? `/${args.site}/` : ''],
  };
  const [title, detail] = map[name] ?? [name, ''];
  return { key: name, title, detail, done: false };
}

/** 从第一句话里取个标题。和设计稿同一套削法：去掉「做一个」，截到第一个标点。 */
function titleOf(text: string): string {
  const m = text.replace(/^(请|帮我)?(做|写|搭)(一个|个)?/, '').split(/[：:，,。；;\s]/)[0];
  return (m || '新页面').slice(0, 14);
}

async function toAgentImage(f: File): Promise<AgentImage> {
  const buf = await f.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return { name: f.name, mimeType: f.type || 'image/png', dataBase64: btoa(bin) };
}

// ── 建议清单 ────────────────────────────────────────────────────────────
/** 文案照设计稿 SUGS 原样搬。它是产品文案，不是演示数据。 */
const SUGS: { label: string; items: { title: string; detail: string }[] }[] = [
  {
    label: '团队协作',
    items: [
      { title: '组里的值班排班表', detail: '每周轮一次，每个人能看到自己哪天值班；临时换班要对方确认，节假日自动跳过。' },
      { title: '周会议题收集', detail: '大家随时提议题、投票排序，周会开始前自动生成议程。' },
      { title: '新人入职清单', detail: '按天列出第一周要做的事，导师能看到进度。' },
      { title: '团建去哪投票', detail: '列出三到五个备选，每人投两票，截止后公布结果。' },
      { title: '共享设备借还', detail: '登记投影仪、相机这类公用设备，谁借走了、什么时候还一目了然。' },
      { title: '会议纪要归档', detail: '按会议归档纪要和待办，待办到期提醒负责人。' },
    ],
  },
  {
    label: '数据看板',
    items: [
      { title: '每日销售简报', detail: '每天早上汇总昨天的成交、回款和新增线索，和上周同期对比。' },
      { title: '客服工单趋势', detail: '按类型统计每天的工单量和平均处理时长，异常的日子标出来。' },
      { title: '招聘进度漏斗', detail: '从投递、筛选、面试到录用，每个岗位一条漏斗。' },
      { title: '预算执行情况', detail: '按部门展示预算和实际花费，超过 80% 的标黄。' },
      { title: '项目延期预警', detail: '列出所有项目的里程碑，快到期还没完成的提前一周提醒。' },
      { title: '活动报名统计', detail: '实时显示报名人数、部门分布和签到率。' },
    ],
  },
  {
    label: '工作提效',
    items: [
      { title: '周报自动汇总', detail: '读这周的日程和工单，生成「做了什么、卡在哪、下周计划」三段草稿。' },
      { title: '差旅报销计算', detail: '选城市、天数和职级，按差标算出能报多少。' },
      { title: '合同到期提醒', detail: '导入合同台账，到期前 30 天和 7 天各提醒一次。' },
      { title: '会议纪要整理', detail: '粘贴会议记录，整理成结论和待办，标出负责人。' },
      { title: '发票信息识别', detail: '上传发票照片，识别抬头、金额和税号，导出表格。' },
      { title: '审批进度追踪', detail: '列出我发起的审批卡在谁那里、卡了几天。' },
    ],
  },
  {
    label: '生活',
    items: [
      { title: '午饭吃什么', detail: '收录园区周边的店，按距离和人均筛，摇一下随机选一家。' },
      { title: '拼车上下班', detail: '按住的小区匹配同路同事，约好时间和上车点。' },
      { title: '闲置物品交换', detail: '同事之间发布闲置，标价或免费送，约好在公司交接。' },
      { title: '同事生日提醒', detail: '每月初列出本月过生日的同事，当天提醒大家送祝福。' },
      { title: '健身组队打卡', detail: '三到五人组队，每天传一张运动照片打卡。' },
      { title: '园区班车时刻', detail: '显示每条班车线路下一班几点、在哪上车。' },
    ],
  },
  {
    label: '小游戏',
    items: [
      { title: '打字速度挑战', detail: '60 秒内敲一段真实代码，按速度和准确率算分，出排行榜。' },
      { title: '代码评审转盘', detail: '从组里随机抽一位同事做评审，最近抽过的人跳过。' },
      { title: '年会抽奖', detail: '导入名单，分轮抽奖，抽中的人不重复。' },
      { title: '咖啡续命榜', detail: '每天点一下记一杯，周五出全组排行。' },
      { title: '团队知识竞答', detail: '出十道和业务有关的题，限时作答，实时排名。' },
      { title: '程序员节寻宝', detail: '在内网页面里藏线索，解出来的人进排行榜。' },
    ],
  },
];
