import { Fragment, useEffect, useRef, useState } from 'react';
import { Icon } from '@ispace/ui';
import { api } from './api';
import { Segment } from './detail';

/**
 * 输入框里那两颗：「+ 添加内容」和模型胶囊。
 *
 * 开场那个大输入框和工作台左下角的输入框是同一套（新稿两处画的是同一个组
 * 件，只是大小和菜单弹出的方向不同）：开场的在页面上半截，菜单往下弹；工作
 * 台的贴着屏幕底，菜单往上弹，不然会被裁掉。
 *
 * 每颗自己管自己的开合，各带一张铺满屏幕的背板：点菜单以外的任何地方都关
 * 掉它。两颗不会同时开着——第一颗的背板在上面一层，点第二颗其实点的是背板。
 */

export type Effort = 'low' | 'medium' | 'high';

export interface ModelOption { id: string; label: string; mult?: string }

/** 选出来的模型和思考档位，一路带到 /agent/ask。 */
export interface AgentChoice {
  /** 空字符串表示没得选（平台只有一条通道），让服务端用它的默认。 */
  model: string;
  /** null 表示平台没开思考档位，这次就别提它。 */
  effort: Effort | null;
}

export interface AgentImage { name: string; mimeType: string; dataBase64: string }

export const EFFORTS: { k: Effort; label: string }[] = [
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

/** 两个菜单共用的那块白板。up 为真时贴在按钮上方弹出。 */
const panel = (up: boolean): React.CSSProperties => ({
  position: 'absolute', left: 0, zIndex: 31, boxSizing: 'border-box',
  ...(up ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
  display: 'flex', flexDirection: 'column', borderRadius: 20, background: 'var(--surface-1)',
  border: '1px solid var(--border-subtle)',
  boxShadow: '0 24px 48px -16px rgba(24,23,21,.22), 0 2px 6px rgba(24,23,21,.05)',
});

const menuLabel: React.CSSProperties = {
  padding: '4px 12px 6px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
};

const Backdrop = ({ onClose }: { onClose: () => void }) => (
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
);

/** 平台配了哪些模型、开没开思考档位。问不到就当没有，输入框照常能用。 */
export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [effortOn, setEffortOn] = useState(false);
  useEffect(() => {
    void api.agentStatus()
      .then((s) => {
        /* 没配通道就连模型名都不显示——这一屏现在什么都生成不了 */
        if (!s.configured) return;
        setModels(s.models ?? []);
        setEffortOn(Boolean(s.effort));
      })
      .catch(() => { /* 问不到就当没有 */ });
  }, []);
  return { models, effortOn };
}

export async function toAgentImage(f: File): Promise<AgentImage> {
  const buf = await f.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return { name: f.name, mimeType: f.type || 'image/png', dataBase64: btoa(bin) };
}

/** 「+ 添加内容」。上传图片是真的；其余四项弹一句说明。 */
export function AddButton({ up = false, size = 36, onImages, onToast }: {
  up?: boolean;
  size?: number;
  onImages: (imgs: AgentImage[]) => void;
  onToast: (t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);

  return (
    <div style={{ position: 'relative', flex: 'none' }}>
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
          onImages(next);
        }}
      />
      {open && <Backdrop onClose={() => setOpen(false)} />}
      <button
        onClick={() => setOpen((v) => !v)}
        title="添加内容"
        style={{
          width: size, height: size, border: 0, borderRadius: 'var(--radius-pill)',
          background: 'var(--surface-2)', color: 'var(--text-primary)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}
      >
        <Icon name="plus" size={size >= 36 ? 18 : 17} />
      </button>
      {open && (
        <div style={{ ...panel(up), width: 240, padding: '10px 8px', gap: 2 }}>
          <span style={menuLabel}>添加内容</span>
          {ADDS.map((it, i) => (
            <Fragment key={it.label}>
              {i === 2 && (
                <div style={{ height: 1, margin: '4px 6px', background: 'var(--border-tabby)' }} />
              )}
              <button
                onClick={() => {
                  setOpen(false);
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
  );
}

/**
 * 模型胶囊。
 *
 * 有得选才画下拉：一条通道又没开思考时，菜单里只有一行、点了还是它，于是
 * 只摆一个灰色的名字。平台一条通道都没配时什么都不画。
 */
export function ModelPill({
  models, effortOn, modelId, effort, onModel, onEffort, up = false, size = 36,
}: {
  models: ModelOption[];
  effortOn: boolean;
  modelId: string;
  effort: Effort;
  onModel: (id: string) => void;
  onEffort: (e: Effort) => void;
  up?: boolean;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const picked = models.find((m) => m.id === modelId) ?? models[0] ?? null;
  if (!picked) return null;
  const pickable = models.length > 1 || effortOn;

  if (!pickable) {
    return (
      <span
        title="平台只配了这一条模型通道"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: size, padding: '0 14px',
          borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)',
          color: 'var(--text-secondary)', fontSize: 'var(--text-md)',
          fontWeight: 'var(--weight-medium)', whiteSpace: 'nowrap',
        }}
      >
        {picked.label}
      </span>
    );
  }

  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      {open && <Backdrop onClose={() => setOpen(false)} />}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: size, maxWidth: '100%',
          padding: '0 12px 0 14px', border: 0, borderRadius: 'var(--radius-pill)',
          background: 'var(--surface-2)', color: 'var(--text-primary)', fontSize: 'var(--text-md)',
          fontWeight: 'var(--weight-medium)', whiteSpace: 'nowrap', cursor: 'pointer',
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{picked.label}</span>
        <Icon name="chevDown" size={15} color="var(--text-tertiary)" />
      </button>
      {open && (
        <div style={{ ...panel(up), width: 320, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px' }}>
            <span style={menuLabel}>模型</span>
            {models.map((m) => (
              <button
                key={m.id}
                onClick={() => { onModel(m.id); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 12px',
                  border: 0, borderRadius: 12,
                  background: m.id === picked.id ? 'var(--surface-2)' : 'transparent',
                  color: 'var(--text-heading)', fontSize: 'var(--text-md)',
                  fontWeight: 'var(--weight-semibold)', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <span style={{ width: 18, display: 'inline-flex' }}>
                  {m.id === picked.id && <Icon name="check" size={17} color="var(--tabby-orange)" />}
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
                onPick={(k) => onEffort(k as Effort)}
                style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 输入框下面那一排图片。点 × 去掉一张。 */
export function ImageChips({ images, onRemove }: { images: AgentImage[]; onRemove: (i: number) => void }) {
  if (!images.length) return null;
  return (
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
            onClick={() => onRemove(i)}
            title="去掉这张"
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
  );
}
