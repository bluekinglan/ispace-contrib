import { Fragment, useEffect, useRef, useState } from 'react';
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
 * │ 2. 模型下拉和「思考」分段只在平台真的给了得选的东西时才画：模型  │
 * │    清单来自 AGENT_MODELS，思考档位要 AGENT_EFFORT 开着           │
 * │    （/agent/status 两样都返回）。只配了一条通道又没开思考时，    │
 * │    仍旧是一个灰色的名字——下拉里只有一行、点了还是它，不如不画。 │
 * │ 3. 「添加内容」五项按稿子都在，但只有第一项是通的，而且叫「上传  │
 * │    图片」不叫「上传文件」：Agent 接口收的就是图片（/agent/ask 的 │
 * │    images）。其余四项点了弹一句话说明它是干什么的——设计稿里它们 │
 * │    也只是弹提示。                                                │
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
        onStart={(text, images, choice) => setGen(freshGen(text, images, choice))}
        onToast={onToast}
      />
    );
}

/** 创建屏那两个菜单选出来的东西，一路带到 /agent/ask。 */
interface AgentChoice {
  /** 空字符串表示没得选（平台只有一条通道），让服务端用它的默认。 */
  model: string;
  /** null 表示平台没开思考档位，这次就别提它。 */
  effort: Effort | null;
}

type Effort = 'low' | 'medium' | 'high';

interface ModelOption { id: string; label: string; mult?: string }

const EFFORTS: { k: Effort; label: string }[] = [
  { k: 'low', label: '快速' },
  { k: 'medium', label: '深度思考' },
  { k: 'high', label: '最大' },
];

/**
 * 「添加内容」里的五项。
 *
 * 只有第一项真的做事——其余四项点了说一句它是干什么的。设计稿里它们也
 * 是这样：弹一句话，不是做好的功能。与其画五个按钮里四个点了没反应，
 * 不如把"它将来会是什么"说清楚。
 */
const ADDS: { label: string; icon: 'fileUp' | 'link' | 'shapes' | 'heart' | 'archive'; tip: string | null }[] = [
  { label: '上传图片', icon: 'fileUp', tip: null },
  { label: '粘贴链接', icon: 'link', tip: '贴一个网址、AI 先读一遍再动手——这一项还没接上' },
  { label: '选择 Skill', icon: 'shapes', tip: '挑一个团队沉淀的 Skill，比如「飞书表格」「审批流」——这一项还没接上' },
  { label: '收藏风格', icon: 'heart', tip: '从你收藏的页面里挑一个风格照着做——这一项还没接上' },
  { label: '导入项目', icon: 'archive', tip: '把已有的代码包导进来接着改——这一项还没接上' },
];

/** 两个菜单共用的那块白板。 */
const panel: React.CSSProperties = {
  position: 'absolute', left: 0, top: 'calc(100% + 8px)', zIndex: 31, boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column', borderRadius: 20, background: 'var(--surface-1)',
  border: '1px solid var(--border-subtle)',
  boxShadow: '0 24px 48px -16px rgba(24,23,21,.22), 0 2px 6px rgba(24,23,21,.05)',
};

const menuLabel: React.CSSProperties = {
  padding: '4px 12px 6px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
};

// ── 没开始之前 ──────────────────────────────────────────────────────────
function Idle({
  draft, setDraft, remix, onClearRemix, onStart, onToast,
}: {
  draft: string;
  setDraft: (v: string) => void;
  remix: { name: string; author: string } | null;
  onClearRemix: () => void;
  onStart: (text: string, images: AgentImage[], choice: AgentChoice) => void;
  onToast: (t: string) => void;
}) {
  const [sugTab, setSugTab] = useState(0);
  const [images, setImages] = useState<AgentImage[]>([]);
  const [menu, setMenu] = useState<null | 'add' | 'model'>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState('');
  const [effortOn, setEffortOn] = useState(false);
  const [effort, setEffort] = useState<Effort>('medium');
  const file = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void api.agentStatus()
      .then((s) => {
        /* 没配通道就连模型名都不显示——这一屏现在什么都生成不了 */
        if (!s.configured) return;
        const list = s.models ?? [];
        setModels(list);
        setModelId(list[0]?.id ?? '');
        setEffortOn(Boolean(s.effort));
      })
      .catch(() => { /* 问不到就当没有，输入框照常能用 */ });
  }, []);

  const picked = models.find((m) => m.id === modelId) ?? models[0] ?? null;
  /* 有得选才画下拉：一条通道又没开思考时，菜单里只有一行、点了还是它 */
  const pickable = picked !== null && (models.length > 1 || effortOn);

  const go = () => {
    const t = draft.trim();
    if (!t) { onToast('先说一句想做什么'); return; }
    onStart(t, images, { model: picked?.id ?? '', effort: effortOn ? effort : null });
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
          {/* 背板：点菜单以外的任何地方都关掉它。铺在菜单下面一层 */}
          {menu && (
            <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          )}

          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenu((m) => (m === 'add' ? null : 'add'))}
              title="添加内容"
              style={{
                width: 36, height: 36, border: 0, borderRadius: 'var(--radius-pill)',
                background: 'var(--surface-2)', color: 'var(--text-primary)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}
            >
              <Icon name="plus" size={18} />
            </button>
            {menu === 'add' && (
              <div style={{ ...panel, width: 240, padding: '10px 8px', gap: 2 }}>
                <span style={menuLabel}>添加内容</span>
                {ADDS.map((it, i) => (
                  <Fragment key={it.label}>
                    {i === 2 && (
                      <div style={{ height: 1, margin: '4px 6px', background: 'var(--border-tabby)' }} />
                    )}
                    <button
                      onClick={() => {
                        setMenu(null);
                        if (it.tip) onToast(it.tip);
                        else file.current?.click();
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, height: 40, padding: '0 12px',
                        border: 0, borderRadius: 12, background: 'transparent',
                        color: 'var(--text-primary)', fontSize: 'var(--text-md)',
                        cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      <Icon name={it.icon} size={18} color="var(--text-tertiary)" />
                      {it.label}
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
          </div>

          {picked && !pickable && (
            <span
              title="平台只配了这一条模型通道"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 14px',
                borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)',
                color: 'var(--text-secondary)', fontSize: 'var(--text-md)',
                fontWeight: 'var(--weight-medium)', whiteSpace: 'nowrap',
              }}
            >
              {picked.label}
            </span>
          )}

          {picked && pickable && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setMenu((m) => (m === 'model' ? null : 'model'))}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 12px 0 14px',
                  border: 0, borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)',
                  color: 'var(--text-primary)', fontSize: 'var(--text-md)',
                  fontWeight: 'var(--weight-medium)', whiteSpace: 'nowrap', cursor: 'pointer',
                }}
              >
                {picked.label}
                <Icon name="chevDown" size={15} color="var(--text-tertiary)" />
              </button>
              {menu === 'model' && (
                <div style={{ ...panel, width: 320, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px' }}>
                    <span style={menuLabel}>模型</span>
                    {models.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => { setModelId(m.id); setMenu(null); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 12px',
                          border: 0, borderRadius: 12, background: 'transparent',
                          color: 'var(--text-heading)', fontSize: 'var(--text-md)',
                          fontWeight: 'var(--weight-semibold)', cursor: 'pointer', textAlign: 'left',
                        }}
                      >
                        <span style={{ width: 18, display: 'inline-flex' }}>
                          {m.id === picked.id && (
                            <Icon name="check" size={17} color="var(--tabby-orange)" />
                          )}
                        </span>
                        <span style={{ flex: 1 }}>{m.label}</span>
                        {m.mult && (
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)',
                              fontWeight: 'var(--weight-regular)', color: 'var(--text-tertiary)',
                            }}
                          >
                            {m.mult}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {effortOn && (
                    <div
                      style={{
                        display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px 16px',
                        borderTop: '1px solid var(--border-tabby)',
                      }}
                    >
                      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>思考</span>
                      <Segment
                        options={EFFORTS}
                        value={effort}
                        onPick={(k) => setEffort(k as Effort)}
                        style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
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
  /** 模型和思考档位，整段生成都用同一个——后面追问也还是它。 */
  choice: AgentChoice;
  steps: Step[];
  /** 模型说的话，按轮次分段。 */
  says: { me: boolean; text: string }[];
  busy: boolean;
  publishedUrl: string | null;
}

const freshGen = (text: string, images: AgentImage[], choice: AgentChoice): Gen => ({
  text, images, title: titleOf(text), site: null, confirmToken: null, sessionId: null,
  choice, steps: [], says: [], busy: true, publishedUrl: null,
});

// ── 工作区实时预览 ─────────────────────────────────────────────────────
/** 预览页面回流上来的一条错误。 */
interface PreviewErr { level: string; text: string }

/** 一页最多留这么多条。页面里一个每帧抛异常的循环能在一秒里产出几十条。 */
const MAX_ERRS = 50;

/**
 * 工作区实时预览（docs/specs/2026-10-20-preview-runtime.md）。
 *
 * 做三件事：
 *   1. 开一个预览会话，拿到同源地址与取数令牌
 *   2. 和 iframe 里的 shim 握手把令牌递进去，并收它回流的报错
 *   3. 模型每写完一个文件就刷新一次（防抖）
 *
 * ┌─ 握手为什么用 event.source 比对，而不是 event.origin ───────────────┐
 * │ 预览 iframe 没有 allow-same-origin，它的 origin 是字符串 "null"。    │
 * │ 而**任何**网站开一个沙箱 iframe，发出的消息 origin 都是 "null"——    │
 * │ 按 origin 判等于谁都放进来。                                         │
 * │                                                                      │
 * │ event.source === frame.contentWindow 是对象同一性比较，这个骗不了：  │
 * │ 只有我们自己挂上去的那个 iframe 才是那个对象。令牌只递给它。         │
 * └──────────────────────────────────────────────────────────────────────┘
 */
interface PreviewKind {
  kind: 'static' | 'server' | 'build' | 'empty';
  why: string;
  signals: string[];
}

function usePreview(active: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const [kind, setKind] = useState<PreviewKind | null>(null);
  const [errs, setErrs] = useState<PreviewErr[]>([]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const token = useRef('');
  const id = useRef<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active || id.current) return;
    let alive = true;
    void api.previewOpen().then(async (r) => {
      if (!alive) return;
      id.current = r.previewId;
      token.current = r.token;
      setUrl(r.url);
      setKind(await api.previewKind(r.previewId).catch(() => null));
    }).catch(() => {
      /* 预览开不了不该拦住生成——右栏退回骨架屏，左边照常在做事 */
    });
    return () => { alive = false; };
  }, [active]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;      // ← 见上方说明，这一行是关键
      const d = e.data as { type?: string; level?: string; text?: string } | null;
      if (d?.type === 'ispace:preview-ready') {
        win.postMessage({ type: 'ispace:preview-token', token: token.current }, '*');
      } else if (d?.type === 'ispace:preview-error' && typeof d.text === 'string') {
        const one = { level: d.level ?? 'error', text: d.text };
        setErrs((xs) => (xs.length >= MAX_ERRS ? xs : [...xs, one]));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  /**
   * 收掉预览。两处调：离开这一屏时，以及发布成功之后——发布之后右栏换成了
   * 正式地址，那块工作区预览已经没人看，留着只是白占一个会话名额
   * （每人同时只有一个）。
   *
   * 主动收只是加速，真正兜底的是服务端那两条超时：浏览器崩溃、断网时
   * 这一下发不出来。所以这里失败了也不重试。
   */
  const release = () => {
    if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    const pid = id.current;
    if (!pid) return;
    id.current = null;          // 收过就不再收第二次
    token.current = '';
    const body = new Blob([JSON.stringify({ previewId: pid })], { type: 'application/json' });
    if (!navigator.sendBeacon?.('/deploy/api/preview-session/release', body)) {
      void fetch('/deploy/api/preview-session/release', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: pid }),
      }).catch(() => undefined);
    }
  };

  /* 卸载时收。用 ref 存一份，免得把 release 列进依赖让 effect 每次渲染都重挂 */
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => () => { releaseRef.current(); }, []);

  /**
   * 刷新。防抖 300ms——模型一轮里常连写五个文件，每次都刷会白闪五下。
   * 刷新同时清掉旧错误：那些是上一版页面报的，留着会让人去修已经不存在的问题。
   */
  const refresh = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      setErrs([]);
      /*
        重新判一次再刷。工作区一直在变——上一轮还是个能直接打开的单页面，
        这一轮模型加了个 server.js，右栏就该从页面换成那页说明。
      */
      const pid = id.current;
      if (pid) void api.previewKind(pid).then(setKind).catch(() => undefined);
      setRev((n) => n + 1);
    }, 300);
  };

  return { url, rev, kind, errs, frame, refresh, release, clear: () => setErrs([]) };
}

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
  /* 发布之后右栏换成正式地址，预览就不用再开着了 */
  const preview = usePreview(gen.publishedUrl === null);
  const [showErrs, setShowErrs] = useState(false);

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
        choice: gen.choice,
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
        /* 文件落盘了，右栏跟着换一版 */
        onToolDone: (name) => {
          if (name === 'write_file' || name === 'delete_file') preview.refresh();
        },
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
      /* 右栏这就换成正式地址，工作区预览没人看了，收掉它 */
      preview.release();
      onToast(`已发布到 ${r.url}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '发布失败');
    } finally { setPublishing(false); }
  };

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [gen.says, gen.steps]);

  const url = gen.publishedUrl
    ?? (gen.site ? `${location.origin}/${me.username}/${gen.site}/` : '');
  const shown = url.replace(/^https?:\/\//, '');

  /*
    iframe 真正装的东西：发布前是工作区实时预览，发布后换成正式地址。

    `?_r=` 是刷新用的——改 src 才会让 iframe 重新加载，而路径本身不能变。
    预览响应带 no-store，所以这个参数只是为了让 React 认出 src 变了。
  */
  /* 带服务端 / 要构建的项目不渲染——伺服出去是半截页面或白屏，见 preview-kind.ts */
  const renderable = preview.kind === null || preview.kind.kind === 'static'
    || preview.kind.kind === 'empty';
  const frameUrl = gen.publishedUrl
    ?? (preview.url && renderable ? `${preview.url}?_r=${preview.rev}` : null);

  /** 把预览里的报错作为一次追问发出去，让模型自己改。 */
  const fixErrors = () => {
    if (!preview.errs.length || gen.busy) return;
    const list = preview.errs.slice(0, 12).map((e) => `- ${e.text}`).join('\n');
    const text = `预览里页面报了这些错，帮我看一下并修掉：\n${list}`;
    preview.clear();
    setShowErrs(false);
    setGen((g) => ({ ...g, says: [...g.says, { me: true, text }] }));
    void run(text, []);
  };

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
            {gen.publishedUrl
              ? '已上线'
              : !renderable
                ? '这个项目不走预览'
                : !frameUrl
                  ? '正在准备预览'
                  : gen.busy ? '正在做，写一个文件这里刷一次' : '预览 · 还没发布'}
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
                /* 与详情、为你推荐一致：手机版纵向吃满 */
                height: '100%', aspectRatio: '9 / 19.5', boxSizing: 'border-box',
                padding: 9, borderRadius: 44, background: '#0d0d10',
                boxShadow: '0 40px 80px -30px rgba(0,0,0,.35)',
              }}
            >
              <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 36, overflow: 'hidden', background: 'var(--surface-1)' }}>
                <PreviewBody url={frameUrl} phone frameRef={preview.frame}
                  notice={renderable ? null : preview.kind} />
              </div>
            </div>
          ) : (
            <div
              style={{
                /* 与详情、为你推荐一致：电脑版横向吃满 */
                width: '100%', borderRadius: 16, overflow: 'hidden',
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
                <PreviewBody url={frameUrl} phone={false} frameRef={preview.frame}
                  notice={renderable ? null : preview.kind} />
              </div>
            </div>
          )}
        </div>

        {/*
          预览里页面报的错。

          不自动塞进对话：一个 favicon 404 不值得触发一轮模型调用，而且
          自动发出去会把用户正要说的话冲掉。这里只摆一条，点「让它修」
          才真的发——人决定要不要修，模型拿到的是完整的错误文本。
        */}
        {!gen.publishedUrl && preview.errs.length > 0 && (
          <div
            style={{
              flex: 'none', padding: '10px 20px', borderTop: '1px solid var(--border-tabby)',
              background: 'var(--surface-1)', display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* 用 --error 而不是 --danger：深色模式只重定义了前者 */}
              <Icon name="info" size={14} color="var(--error)" />
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-heading)', fontWeight: 'var(--weight-semibold)' }}>
                页面报了 {preview.errs.length} 个错
              </span>
              <button
                onClick={() => setShowErrs((v) => !v)}
                style={{
                  border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
                  fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
                }}
              >
                {showErrs ? '收起' : '看看'}
              </button>
              <div style={{ flex: 1 }} />
              <button
                onClick={preview.clear}
                style={{
                  height: 30, padding: '0 10px', border: '1px solid var(--border)',
                  borderRadius: 9, background: 'var(--surface-1)', color: 'var(--text-secondary)',
                  fontSize: 'var(--text-base)', cursor: 'pointer',
                }}
              >
                先不管
              </button>
              <button
                onClick={fixErrors}
                disabled={gen.busy}
                style={{
                  height: 30, padding: '0 12px', border: 0, borderRadius: 9,
                  background: gen.busy ? 'var(--surface-3)' : 'var(--accent)',
                  color: gen.busy ? 'var(--text-tertiary)' : 'var(--accent-fg)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
                  cursor: gen.busy ? 'default' : 'pointer',
                }}
              >
                让它修
              </button>
            </div>
            {showErrs && (
              <div
                className="mono"
                style={{
                  maxHeight: 108, overflow: 'auto', display: 'flex', flexDirection: 'column',
                  gap: 4, fontSize: 'var(--text-base)', lineHeight: 1.6,
                  color: 'var(--text-tertiary)', wordBreak: 'break-all',
                }}
              >
                {preview.errs.map((e, i) => <span key={i}>{e.text}</span>)}
              </div>
            )}
          </div>
        )}

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
function PreviewBody({ url, phone, frameRef, notice }: {
  url: string | null;
  phone: boolean;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  /** 不为空就说明这个项目不走预览，摆一块说明而不是骨架屏。 */
  notice: PreviewKind | null;
}) {
  /*
    不渲染的时候**说清楚为什么**，不要摆一屏骨架。

    骨架屏的意思是"正在加载"，而这里不是加载中——是平台决定不渲染它。
    摆骨架等于让人一直等一个永远不会来的东西；而白屏更糟，人会以为预览
    坏了或者模型写的东西有问题，两个方向都是错的。

    signals 也列出来，让人能自己核对判定对不对，而不是只能信结论。
  */
  if (notice) {
    return (
      <div
        style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12,
          padding: phone ? '32px 22px' : '32px 15%', textAlign: 'center',
        }}
      >
        <span
          style={{
            width: 36, height: 36, borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-3)', color: 'var(--text-tertiary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name="info" size={18} />
        </span>
        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
          {notice.kind === 'server' ? '这是个带服务端的项目' : '这个项目要先构建'}
        </span>
        <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.75, color: 'var(--text-secondary)' }}>
          {notice.why}
        </span>
        {notice.signals.length > 0 && (
          <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>
            看到了：{notice.signals.join('、')}
          </span>
        )}
      </div>
    );
  }
  if (url) {
    return (
      <iframe
        ref={frameRef}
        src={url}
        title="预览"
        /*
          沙箱与详情页、为你推荐一字不差：给脚本和表单，**不给**
          allow-same-origin——两者同时给等于没有沙箱，被预览的页面就能
          借平台的 origin 读写平台接口。预览里跑的是模型刚写出来、
          没人审过的代码，这条更要守。

          代价是页面拿不到会话 cookie，所以取数走的是服务端注入的 shim
          加一次性只读令牌（见 usePreview 与 services/preview-shim.ts）。
        */
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
  choice: AgentChoice;
  sessionId: string | null;
  onSession: (id: string) => void;
  onText: (delta: string) => void;
  onTool: (name: string, args: Record<string, unknown>) => void;
  /**
   * 一次工具调用**做完了**。预览靠它决定什么时候刷新。
   *
   * 必须用 tool_result 而不是 tool_start：start 时文件还没落盘，那一刻
   * 刷新看到的仍是上一版，人会以为"改了没生效"。
   */
  onToolDone: (name: string) => void;
  onError: (message: string) => void;
}): Promise<void> {
  const res = await fetch('/deploy/api/agent/ask', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: opts.text,
      images: opts.images.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })),
      /* 空的就别传：服务端按它自己的默认来，比传一个空串让它去校验干净 */
      ...(opts.choice.model ? { model: opts.choice.model } : {}),
      ...(opts.choice.effort ? { effort: opts.choice.effort } : {}),
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
        else if (e.type === 'tool_result') opts.onToolDone(e.name as string);
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
