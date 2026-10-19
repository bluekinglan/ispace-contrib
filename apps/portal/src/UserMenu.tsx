import { useCallback, useEffect, useState } from 'react';
import type { User } from '@ispace/contracts';
import { AvatarMenu, Button, Dialog, fmtBytes, Icon, QrCode, copyText } from '@ispace/ui';
import { api, type ApkRelease } from './api';
import { ProfileDialog } from './Profile';

/**
 * 点头像弹出的那张菜单，连同它打开的三个弹窗。
 *
 * 从 App.tsx 的顶栏里拆出来，是因为不止一处要用：「我的页面」顶栏、1024
 * 活动页的头图右上角。两处各写一份，迟早一处多一项、一处少一项——用户
 * 点同一个头像得到两张不一样的菜单，会以为其中一张坏了。
 *
 * 菜单项和弹窗状态都在这里；调用方只给「是谁」和「窄不窄」。
 */
export function UserMenu({ user, onUser, phone, size }: {
  user: User;
  /** 改完资料把新的 user 推回去，头像和名字立刻跟着变。 */
  onUser: (u: User) => void;
  /** 手机档：顶栏那颗「下载 App」被收掉了，菜单里补上。 */
  phone: boolean;
  size?: number;
}) {
  const [qrOpen, setQrOpen] = useState(false);
  const [apkOpen, setApkOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  return (
    <>
      <AvatarMenu
        name={user.displayName}
        src={user.avatarUrl}
        size={size}
        subtitle={`${location.host}/${user.username}`}
        items={[
          { label: '个人资料', onClick: () => setProfileOpen(true) },
          { label: '我的空间', href: `/${user.username}/` },
          { label: '控制台', href: '/console' },
          /* 顶栏那颗按钮在手机档被收掉了，这里补上，功能不丢 */
          ...(phone ? [{ label: '下载手机 App', onClick: () => setApkOpen(true) }] : []),
          { label: '手机扫码登录', onClick: () => setQrOpen(true) },
          {
            label: '退出登录',
            danger: true,
            /*
              无论服务端那一步成不成都要离开当前页。
              写成 .then(...) 的话请求一失败就什么都不发生，
              用户看到的是"点了没反应"，连条错误都没有。
              会话 cookie 是 HttpOnly，前端清不掉，所以真失败时也得
              走到 / 让人看见自己还登着，而不是停在原地猜。

              回根路径而不是留在原地：留在 /{user}/ 会立刻被未登录
              引导页接管，看起来像"退出失败又弹回来了"。
            */
            onClick: () => {
              void api.logout().catch(() => undefined).finally(() => location.replace('/'));
            },
          },
        ]}
      />
      {qrOpen && <QrLoginDialog onClose={() => setQrOpen(false)} />}
      {apkOpen && <AppDownloadDialog onClose={() => setApkOpen(false)} />}
      {profileOpen && (
        <ProfileDialog
          user={user}
          onUser={onUser}
          onClose={() => setProfileOpen(false)}
        />
      )}
    </>
  );
}

/**
 * 手机扫码登录（设计稿第 10 屏「扫码登录」的桌面侧）。
 *
 * 流向：**已登录的桌面**生成二维码，**未登录的手机**扫它换会话。
 * 手机有摄像头、桌面有会话，各出各的——不用在手机上敲一遍密码。
 *
 * 码 60 秒过期、用一次即毁。倒计时要显式画出来：二维码长得都一样，
 * 不标剩余时间的话，用户扫一个已过期的码只会得到一句"无效"，
 * 然后以为功能坏了。
 */
function QrLoginDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const mint = useCallback(() => {
    setErr(null); setCode(null);
    void api.mintQrCode()
      .then((r) => { setCode(r.code); setLeft(r.expiresIn); })
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(mint, [mint]);

  // 每秒走一格。到 0 不自动续——桌面挂着这个弹窗没人看时，
  // 自动续等于持续不断地铸有效登录码，白白扩大被拍屏的窗口。
  useEffect(() => {
    if (!code || left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [code, left]);

  const expired = code !== null && left <= 0;

  return (
    <Dialog
      open
      title="手机扫码登录"
      description="打开 iSpace 手机 App，在登录页点「扫码登录」，对准这个码。"
      onClose={onClose}
      width={360}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-8)' }}>
        {err ? (
          <p style={{ margin: 0, color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</p>
        ) : !code ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>生成中…</p>
        ) : (
          <div style={{ position: 'relative' }}>
            <QrCode text={`ispace-login:${code}`} size={180} />
            {expired && (
              <div style={{
                position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                background: 'rgba(252,252,248,.92)', borderRadius: 'var(--radius-8)',
              }}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>已过期</span>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
          {code && !expired && (
            <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              {left} 秒内有效，扫一次即失效
            </span>
          )}
          {expired && <Button size="sm" variant="primary" onClick={mint}>重新生成</Button>}
        </div>

        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.6 }}>
          扫码即以你的身份登录那台手机。生成记录会进审计日志。
        </p>
      </div>
    </Dialog>
  );
}

/**
 * 下载手机 App（安卓）。
 *
 * 与「扫码登录」正好相反：那边是桌面出码、手机换会话；这边是桌面出码、
 * 手机拿安装包。二维码里放的是 apk 的**完整地址**——手机不在这个页面上，
 * 相对路径它补不出 origin。
 *
 * 这条下载路径刻意不需要登录（Caddyfile 的 handle /dist/*，落在带
 * forward_auth 的 @userapp 之前）。要求先登录的话，人得先在手机浏览器里
 * 敲一遍公司邮箱密码才能装 App，而装 App 本来就是为了不用再敲密码。
 *
 * 版本号、体积、更新时间都显式列出：装机包这种东西，用户唯一能自查的
 * 就是"我下的是不是最新的那一个"，不给版本号就只能靠猜。
 */
export function AppDownloadDialog({ onClose }: { onClose: () => void }) {
  const [rel, setRel] = useState<ApkRelease | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.apkRelease()
      .then(setRel)
      .catch((e: Error) => setErr(e.message));
  }, []);

  // origin 而不是写死域名：平台 http/https 都能进，写死一个会让另一边扫出来
  // 的码指向错误的协议——http 页面上扫出 https 链接，手机上大概率连不上。
  const url = rel ? `${location.origin}${rel.url}` : '';

  return (
    <Dialog
      open
      title="下载手机 App"
      description="用手机扫码，或复制链接在手机浏览器里打开。装完在登录页点「扫码登录」即可。"
      onClose={onClose}
      width={380}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-8)' }}>
        {err ? (
          <p style={{ margin: 0, color: 'var(--danger)', fontSize: 'var(--text-sm)', textAlign: 'center', lineHeight: 1.6 }}>
            {err}
            <br />
            安装包可能还没发布，找管理员跑一次 14-publish-apk.sh。
          </p>
        ) : !rel ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>读取版本信息…</p>
        ) : (
          <>
            <QrCode text={url} size={180} label="安卓安装包下载地址的二维码" />

            {/* 版本 / 体积 / 更新时间。三项都是用户下载前会想确认的。 */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexWrap: 'wrap', gap: 'var(--space-6)',
              fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
            }}>
              <span className="num">v{rel.version}（{rel.versionCode}）</span>
              <span style={{ color: 'var(--text-tertiary)' }}>·</span>
              <span className="num">{fmtBytes(rel.sizeBytes)}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>·</span>
              <span className="num">{fmtLocalTime(rel.builtAt)}</span>
            </div>

            {/* 链接明文摆出来：扫不了码的人（比如手机没相机权限）得能照着敲。 */}
            <div style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
              background: 'var(--surface-2)', borderRadius: 'var(--radius-8)',
              padding: 'var(--space-6) var(--space-8)',
            }}>
              <span className="mono" style={{
                flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{url}</span>
              {/*
                走 copyText 而不是 navigator.clipboard：平台跑在明文 HTTP 上时
                后者根本不存在，读属性那一步就抛，表现为按钮点了没反应。
                两条路都失败时明确让用户手动选中，不装作复制成功。
              */}
              <Button size="sm" onClick={() => {
                void copyText(url).then((ok) => {
                  setCopied(ok);
                  if (ok) setTimeout(() => setCopied(false), 1600);
                  else setMsg('复制不了，请手动选中上面的地址');
                });
              }}>
                {copied ? '已复制' : '复制链接'}
              </Button>
            </div>

            <a href={rel.url} download={rel.file} style={{ width: '100%', textDecoration: 'none' }}>
              <Button variant="primary" style={{ width: '100%' }}>
                <Icon name="mobile" size={13} />
                在这台电脑上下载
              </Button>
            </a>

            {msg && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{msg}</div>
            )}

            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.6 }}>
              仅安卓。安装时若提示「未知来源」，在系统设置里允许当前浏览器安装即可。
              <br />
              <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>
                sha256 {rel.sha256.slice(0, 16)}…
              </span>
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * 按本地时区显示一个 UTC 时刻。
 *
 * 不用 fmtDate：它是直接切 ISO 字符串的，而 version.json 里的时间带 Z，
 * 切出来是 UTC。北京时间的同事会看到一个早 8 小时的"更新时间"，
 * 刚发完版就显示成昨晚发的。
 */
function fmtLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
