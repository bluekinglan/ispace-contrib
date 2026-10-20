import { useCallback, useEffect, useState } from 'react';
import { Toast } from '@ispace/ui';
import { api, type BackendListing, type InstalledBackend } from '../api';

/**
 * 同事共享的后端（「后端与数据」屏的一节）。
 *
 * ┌─ 它为什么在这儿 ──────────────────────────────────────────────────┐
 * │ 改版前，别人上架的后端和别人上架的页面一起摆在门户的「创意市场」。  │
 * │ 新稿的「探索」是一面卡片墙——每张卡点开能看、能试玩、能做同款，     │
 * │ 而后端是一个跑着的容器，没有可看的界面，三个动作一个都不成立。      │
 * │                                                                    │
 * │ 所以它挪到了这里：人来「后端与数据」本来就是为了后端的事，在自己的  │
 * │ 后端下面紧跟着「同事共享的」，是同一类东西的两栏。                  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 添加同样只是建一个引用：原作者更新，你下次请求就是新版；他下架，引用
 * 随之失效。和页面那边是同一套语义。
 */
export function SharedBackends() {
  const [listings, setListings] = useState<BackendListing[]>([]);
  const [mine, setMine] = useState<InstalledBackend[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.backendMarketplace().then((r) => setListings(r.listings)).catch(() => setListings([]));
    void api.installedBackends().then((r) => setMine(r.installed)).catch(() => setMine([]));
  }, []);
  useEffect(load, [load]);

  /* 自己上架的那几条不摆在这一节：它们就在上面「后端应用」里 */
  const others = listings.filter((b) => !b.mine);
  if (others.length === 0 && mine.length === 0) return null;

  const toggle = async (b: BackendListing) => {
    setBusy(b.id);
    try {
      if (b.installed) {
        await api.uninstallBackendFromMarket(b.backend_id);
        setMsg(`已移除「${b.name}」`);
      } else {
        await api.installBackendFromMarket(b.backend_id);
        setMsg(`已添加「${b.name}」，地址在下面`);
      }
      load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  };

  const urlOf = (owner: string, name: string) => `/svc/${owner}/${name}/`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
          同事共享的后端
        </span>
        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
          添加之后可以在自己的页面里直接请求它的地址，不用再问作者要。
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--border-tabby)' }}>
        {others.map((b) => {
          const installed = mine.find((m) => m.name === b.name && m.owner_username === b.owner_username);
          return (
            <div
              key={b.id}
              style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1.4fr) auto auto',
                alignItems: 'center', gap: 14, padding: '14px 4px',
                borderTop: '1px solid var(--border-tabby)', fontSize: 'var(--text-base)',
              }}
            >
              <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{b.name}</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{b.owner_name}</span>
              </span>
              {/* 装了才给地址：没装的人拿到地址也请求不动（authz 会挡） */}
              {installed ? (
                <a className="mono" href={urlOf(b.owner_username, b.name)} style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {urlOf(b.owner_username, b.name)}
                </a>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>添加后显示地址</span>
              )}
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                <span
                  style={{
                    width: 6, height: 6, borderRadius: 'var(--radius-pill)',
                    background: b.status === 'running' ? 'var(--tabby-teal)' : 'var(--warning)',
                  }}
                />
                {b.status === 'running' ? '运行中' : b.status}
              </span>
              <button
                disabled={busy === b.id}
                onClick={() => void toggle(b)}
                style={{
                  height: 30, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 9,
                  background: 'var(--surface-1)', color: 'var(--text-primary)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                {b.installed ? '移除' : '添加'}
              </button>
            </div>
          );
        })}
        {others.length === 0 && (
          <span style={{ padding: '14px 4px', borderTop: '1px solid var(--border-tabby)', color: 'var(--text-tertiary)' }}>
            还没有同事把后端共享出来。
          </span>
        )}
      </div>

      {msg && <Toast message={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
