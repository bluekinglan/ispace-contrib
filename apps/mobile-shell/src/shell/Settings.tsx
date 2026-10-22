import { useEffect, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text,
  TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { checkShellUpdate, downloadAndInstall, type ShellRelease } from '../runtime/shell-update';
import {
  openSystemSettings, permissionStates, setCapabilityEnabled,
  session, type Capability, type PermissionState,
} from '../runtime/bridge';
import { versionInfo } from '../runtime/channel';
import { DISPLAY_HOST } from '../config';
import { api } from '../api';
import { Icon, type IconName } from './Icon';

/**
 * 设置（移动端 v2 稿 · 09）。
 *
 * ┌─ 和改版前的差别 ──────────────────────────────────────────────────┐
 * │ 旧：一长屏开关——更新、权限、隐私、安全、关于，五组二十来行，第一   │
 * │     行是「自动接收更新」。人进来想找的（改个名字、看看空间还剩多少、 │
 * │     退出）被压在最下面。                                            │
 * │ 新：照稿是六张卡：账号 / 空间与更新 / 接入 AI / 语言 / 自动播放 /   │
 * │     退出与帮助。原来那些壳的闸门（相机麦克风开关、生物识别、回退版  │
 * │     本）没有删，收进「权限与隐私」一页——稿上没画，但它们是真的在    │
 * │     管事的开关，删了就没地方关了。                                  │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface SettingsProps {
  token: string | null;
  user: { username: string; displayName: string; email?: string | null | undefined };
  shellVersion: string;
  bundleVersion: string;
  updateChannel: string;
  quota?: { usedBytes: number; limitBytes: number } | undefined;
  /** 页面包有没有新版：null 还没查完。 */
  pageUpdate: boolean | null;
  onCheckUpdate: () => void;
  onApplyUpdate: () => void;
  autoPlay: boolean;
  onAutoPlay: (on: boolean) => void;
  autoUpdate: boolean;
  wifiOnly: boolean;
  voiceTextOnly: boolean;
  clearDraftOnLogout: boolean;
  biometricLock: boolean;
  onToggle: (key: SettingKey, v: boolean) => void;
  onRollback: () => void;
  /** 在壳里打开平台的某一页（配额、接入 AI 都在电脑端控制台里）。 */
  onOpenWeb: (path: string, title: string) => void;
  onRenamed: (displayName: string) => void;
  onLogout: () => void;
  onClose: () => void;
}

export type SettingKey =
  | 'autoUpdate' | 'wifiOnly' | 'voiceTextOnly' | 'clearDraftOnLogout' | 'biometricLock';

const CAP_LABEL: Record<Capability, { name: string; why: string }> = {
  camera: { name: '相机', why: '扫码、拍摄' },
  microphone: { name: '麦克风', why: '助手里的语音输入' },
  photos: { name: '相册', why: '给助手发截图' },
  notifications: { name: '通知', why: '发布完成、更新到端提醒' },
};

const ON = '#ee5c2a';

export function Settings(p: SettingsProps) {
  const insets = useSafeAreaInsets();
  /** 主页之外的两页。稿上只画了主页，这两页沿用同一套卡片。 */
  const [page, setPage] = useState<'main' | 'privacy' | 'help'>('main');
  const [editing, setEditing] = useState(false);
  /** 壳（APK）自身的新版本。查不到（老壳没有那个原生模块、或没网）就一直是 null。 */
  const [shellUp, setShellUp] = useState<ShellRelease | null>(null);
  useEffect(() => { void checkShellUpdate().then(setShellUp); }, []);
  /** 下载进度 0–1；null 表示还没开始。 */
  const [dl, setDl] = useState<number | null>(null);
  /** 「接入 AI」那一行：null 还没查到。 */
  const [ai, setAi] = useState<string | null>(null);
  useEffect(() => {
    void api.tokens(p.token)
      .then((r) => setAi(
        r.tokens.some((t) => t.last_used_at) ? '已连接'
          : r.tokens.length ? '令牌未使用' : '未接入',
      ))
      .catch(() => setAi(''));
  }, [p.token]);

  // 实体返回键：子页先回主页，主页再收起设置
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page !== 'main') setPage('main'); else p.onClose();
      return true;
    });
    return () => sub.remove();
  }, [page, p]);

  const back = () => (page === 'main' ? p.onClose() : setPage('main'));
  const title = page === 'main' ? '设置' : page === 'privacy' ? '权限与隐私' : '帮助中心';

  return (
    <View style={[s.root, { paddingTop: insets.top + 6 }]}>
      <View style={s.head}>
        <Pressable onPress={back} hitSlop={12} accessibilityLabel="返回">
          <Icon name="left" size={24} color="#181715" />
        </Pressable>
        <Text style={s.headTitle}>{title}</Text>
      </View>

      {/* 按页给 key：切进子页时从顶上开始，不沿用主页滑到的位置 */}
      <ScrollView key={page} contentContainerStyle={{ gap: 14, paddingHorizontal: 16, paddingBottom: insets.bottom + 120 }}>
        {page === 'main' && (
          <>
            <Card>
              <Row icon="mail" title="邮箱" value={p.user.email ?? '没有绑定'} />
              <Row icon="user" title="编辑资料" value={p.user.displayName} chevron onPress={() => setEditing(true)} />
            </Card>

            <Card>
              <Row
                icon="db" title="空间与配额" chevron
                value={p.quota ? `${mb(p.quota.usedBytes)} / ${mb(p.quota.limitBytes)}` : ''}
                onPress={() => p.onOpenWeb('/console#quota', '空间与配额')}
              />
              <Row
                icon="refreshCw" title="页面更新" chevron
                value={p.pageUpdate === null ? '检查中…' : p.pageUpdate ? '有新版本 · 点此更新' : '已是最新'}
                valueColor={p.pageUpdate ? ON : undefined}
                onPress={p.pageUpdate ? p.onApplyUpdate : p.onCheckUpdate}
              />
              {/*
                壳自身（APK）的新版。和页面更新是两回事：页面更新几 MB、就地生效；
                这个要下 90 多 MB、走系统装机——所以只在真有新版时才出这一行。
              */}
              {shellUp && (
                <Row
                  icon="refreshCw"
                  title={dl === null ? '有新版本 App' : '正在下载新版本'}
                  sub={dl === null
                    ? `${(shellUp.sizeBytes / 1048576).toFixed(0)} MB · 构建 ${shellUp.versionCode}`
                    : `${Math.round(dl * 100)}%`}
                  value={dl === null ? '更新' : ''}
                  valueColor={ON}
                  onPress={dl !== null ? undefined : () => void (async () => {
                    setDl(0);
                    const ok = await downloadAndInstall(shellUp, setDl);
                    // 下不了（老壳没有那两个原生模块、或存储写不进）就退回浏览器，
                    // 总好过点了没反应
                    if (!ok) { setDl(null); void Linking.openURL(shellUp.url); }
                  })()}
                />
              )}
            </Card>

            <Card>
              <Row
                icon="plug" title="接入 AI" chevron value={ai ?? '…'}
                onPress={() => p.onOpenWeb('/console#guide', '接入 AI')}
              />
            </Card>

            <Card>
              {/* 平台只有中文，这一行只是告诉你现在是什么，不给一个只有一个选项的列表 */}
              <Row icon="globe" title="语言" value="简体中文" />
              <Row icon="shield" title="权限与隐私" chevron onPress={() => setPage('privacy')} />
            </Card>

            <Card>
              <Row icon="play" title="自动播放动态内容" sub="刷推荐时页面自动跑起来">
                <Toggle value={p.autoPlay} onChange={p.onAutoPlay} />
              </Row>
            </Card>

            <Card>
              <Row
                icon="logout" title="退出登录" danger
                onPress={() => { void session.clear().then(p.onLogout); }}
              />
              <Row icon="help" title="帮助中心" chevron onPress={() => setPage('help')} />
            </Card>
          </>
        )}

        {page === 'privacy' && <Privacy {...p} />}
        {page === 'help' && <Help {...p} />}
      </ScrollView>

      {editing && (
        <EditProfile
          token={p.token}
          current={p.user.displayName}
          onClose={() => setEditing(false)}
          onSaved={(name) => { setEditing(false); p.onRenamed(name); }}
        />
      )}
    </View>
  );
}

/** 原先设置页的那些闸门，一个没少。 */
function Privacy(p: SettingsProps) {
  const [perms, setPerms] = useState<PermissionState[]>([]);
  const loadPerms = () => void permissionStates().then(setPerms);
  useEffect(loadPerms, []);

  return (
    <>
      <Label text="权限" />
      <Card>
        {perms.map((st) => (
          <Row
            key={st.capability}
            title={CAP_LABEL[st.capability].name}
            sub={`${CAP_LABEL[st.capability].why} · 系统${!st.granted ? '未授权' : st.limited ? '仅选中' : '已允许'}`}
          >
            <Toggle
              value={st.gateOpen}
              onChange={(x) => { void setCapabilityEnabled(st.capability, x).then(loadPerms); }}
            />
          </Row>
        ))}
        <Row title="打开系统设置" chevron onPress={() => void openSystemSettings()} />
      </Card>
      <Text style={s.note}>
        这里的开关是 App 自己的闸门：关掉后页面调用会被直接拒绝，即使系统权限仍开着。
        系统权限本身只能到系统设置里改。
      </Text>

      <Label text="隐私与安全" />
      <Card>
        <Row title="语音只留文字" sub="转写完即删音频">
          <Toggle value={p.voiceTextOnly} onChange={(x) => p.onToggle('voiceTextOnly', x)} />
        </Row>
        <Row title="退出时清除本地草稿" sub="共用手机时建议开">
          <Toggle value={p.clearDraftOnLogout} onChange={(x) => p.onToggle('clearDraftOnLogout', x)} />
        </Row>
        <Row title="指纹 / 面容解锁" sub="回到应用时验证">
          <Toggle value={p.biometricLock} onChange={(x) => p.onToggle('biometricLock', x)} />
        </Row>
      </Card>
      <Text style={s.note}>客户手机号、病历、影像属于受管数据，不要放进个人应用。</Text>

      <Label text="更新" />
      <Card>
        <Row title="自动接收更新" sub="关掉后每次都会先问你">
          <Toggle value={p.autoUpdate} onChange={(x) => p.onToggle('autoUpdate', x)} />
        </Row>
        <Row title="仅 Wi-Fi 下载" sub="页面包一般 1–3 MB">
          <Toggle value={p.wifiOnly} onChange={(x) => p.onToggle('wifiOnly', x)} />
        </Row>
        <Row title="回到上一个版本" sub="新版本不好用时自己退回" chevron onPress={p.onRollback} />
      </Card>
    </>
  );
}

/**
 * 帮助中心。平台还没有单独的帮助文档，这里只写 App 里已经有的东西
 * 怎么用，外加排查问题时要报给人的那几个版本号。
 */
function Help(p: SettingsProps) {
  const v = versionInfo();
  const tips: [string, string][] = [
    ['做一个页面', '点左下那颗圆钮，说一句想做什么。做好后会先问你，确认了才发布。'],
    ['设成手机首页', '在「我」里长按一个页面，设为手机首页，打开 App 直接就是它。'],
    ['在电脑上管理', `电脑上打开 ${DISPLAY_HOST}，版本、可见范围、数据都在控制台里。`],
    ['扫码登录', '电脑上点右上角头像 → 手机扫码登录，不用在手机上敲密码。'],
  ];
  return (
    <>
      <Card>
        {tips.map(([t, d]) => <Row key={t} title={t} sub={d} />)}
      </Card>
      <Label text="关于这台手机上的 iSpace" />
      <Card>
        <Row title="App 版本" value={`${p.shellVersion}${v.isEmbedded ? ' · 内嵌包' : ''}`} />
        <Row title="页面包" value={p.bundleVersion} />
        <Row title="更新通道" value={p.updateChannel} />
        <Row title="更新地址" value={`${DISPLAY_HOST}/updates`} />
      </Card>
    </>
  );
}

function EditProfile({
  token, current, onClose, onSaved,
}: { token: string | null; current: string; onClose: () => void; onSaved: (name: string) => void }) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = name.trim().length > 0 && name.trim() !== current;

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.updateProfile(token, name.trim());
      onSaved(r.user.displayName);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.mask} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 20 }]}>
        <Text style={s.sheetTitle}>编辑资料</Text>
        <Text style={s.sheetLabel}>显示名</Text>
        <TextInput
          style={s.sheetInput}
          value={name}
          onChangeText={setName}
          maxLength={64}
          autoFocus
          placeholder="同事看到的名字"
          placeholderTextColor="#a2a09b"
        />
        <Text style={s.sheetHint}>头像在电脑上改：右上角头像 → 个人资料。</Text>
        {err && <Text style={s.sheetErr}>{err}</Text>}
        <Pressable style={[s.save, !ok && { opacity: 0.4 }]} disabled={!ok || busy} onPress={() => void save()}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.saveText}>保存</Text>}
        </Pressable>
      </View>
    </Modal>
  );
}

const Card = ({ children }: { children: React.ReactNode }) => <View style={s.card}>{children}</View>;
const Label = ({ text }: { text: string }) => <Text style={s.label}>{text}</Text>;

function Row({
  icon, title, sub, value, valueColor, chevron, danger, onPress, children,
}: {
  icon?: IconName;
  title: string;
  sub?: string;
  value?: string;
  valueColor?: string | undefined;
  chevron?: boolean;
  danger?: boolean;
  onPress?: (() => void) | undefined;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      {icon && <Icon name={icon} size={21} color={danger ? '#cd2f3a' : '#292724'} />}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[s.rowTitle, danger && { color: '#cd2f3a' }]}>{title}</Text>
        {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
      </View>
      {value ? <Text style={[s.rowValue, valueColor ? { color: valueColor } : null]} numberOfLines={1}>{value}</Text> : null}
      {children}
      {chevron && <Icon name="chevRight" size={16} color="#a2a09b" />}
    </>
  );
  return onPress
    ? <Pressable style={s.row} onPress={onPress}>{body}</Pressable>
    : <View style={s.row}>{body}</View>;
}

/** 稿上的开关是橙色的；系统 Switch 默认是主题绿，和这套界面不搭。 */
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ false: '#e4e1d9', true: ON }}
      thumbColor="#ffffff"
    />
  );
}

const mb = (n: number): string => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f6f4ee' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 22, paddingHorizontal: 22, paddingTop: 6, paddingBottom: 14 },
  headTitle: { fontSize: 20, fontWeight: '700', color: '#181715' },

  card: { borderRadius: 24, backgroundColor: '#fff', paddingVertical: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56,
    paddingHorizontal: 20, paddingVertical: 8,
  },
  rowTitle: { fontSize: 16, fontWeight: '600', color: '#181715' },
  rowSub: { fontSize: 13, lineHeight: 19, color: '#72706a' },
  rowValue: { maxWidth: 190, fontSize: 14, color: '#72706a' },

  label: { fontSize: 13, fontWeight: '600', color: '#72706a', marginLeft: 8, marginTop: 6, marginBottom: -4 },
  note: { fontSize: 12.5, lineHeight: 19, color: '#72706a', marginHorizontal: 8 },

  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,.42)' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 20, paddingTop: 22, gap: 10,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: '#181715' },
  sheetLabel: { fontSize: 13, color: '#72706a', marginTop: 4 },
  sheetInput: {
    height: 52, borderRadius: 16, paddingHorizontal: 16, backgroundColor: '#f3f1ec',
    fontSize: 16, color: '#181715',
  },
  sheetHint: { fontSize: 12.5, color: '#a2a09b' },
  sheetErr: { fontSize: 13, color: '#cd2f3a' },
  save: {
    height: 52, marginTop: 6, borderRadius: 26, backgroundColor: ON,
    alignItems: 'center', justifyContent: 'center',
  },
  saveText: { fontSize: 16, fontWeight: '700', color: '#fff' },
});
