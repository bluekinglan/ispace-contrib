import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Dimensions, Keyboard, Modal, Platform, Pressable, RefreshControl, ScrollView,
  Share, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Post } from '@ispace/contracts';
import { api } from '../api';
import { API_BASE } from '../config';
import { Icon, type IconName } from './Icon';

/**
 * 社区（移动端 v2 稿 · 05 社区 / 06 发帖）。
 *
 * 改版前手机上没有这一屏。它补的是「页面做完之后」那一段：做完一个东西，
 * 总得有地方说一句——而说一句的地方，顺带也是别人发现这个页面的地方。
 * 所以每条动态可以附一个自己的页面，卡片上带一颗「去试试」。
 *
 * 两栏：推荐（全公司）与关注（只看我关注的人）。关注那栏不含自己——
 * 自己发的在「我」里有一整栏，混进来只会把别人的挤下去（服务端也是
 * 这么过滤的，见 routes/social.ts）。
 */

/** 发帖时能附上的页面：只有自己的（服务端也只收自己的）。 */
export interface MyApp { app_id: string; name: string }

export function Community({
  token, me, myApps, onOpenApp, onAuthor, onBell, onRemix,
}: {
  token: string | null;
  /** 发帖页左上那颗头像。 */
  me: { displayName: string };
  myApps: MyApp[];
  onOpenApp: (owner: string, slug: string, name: string) => void;
  onAuthor: (username: string) => void;
  /** 右上角那颗铃：通知都在「消息」里。 */
  onBell: () => void;
  /** 动态下面那颗「做同款」：带着这个页面去助手。 */
  onRemix: (seed: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [feed, setFeed] = useState<'recommend' | 'following'>('recommend');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [composing, setComposing] = useState(false);
  /** null：没在搜。空串：搜索框开着但还没打字。 */
  const [query, setQuery] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.posts(token, feed)
      .then((r) => setPosts(r.posts))
      .catch(() => setPosts([]))
      .finally(() => setRefreshing(false));
  }, [token, feed]);
  useEffect(load, [load]);

  const toggleLike = async (p: Post) => {
    try {
      const r = p.liked ? await api.unlikePost(token, p.id) : await api.likePost(token, p.id);
      setPosts((prev) => (prev ?? []).map((x) => (
        x.id === p.id ? { ...x, liked: r.liked, likeCount: r.likeCount } : x
      )));
    } catch { /* 点赞失败不打断看动态的人 */ }
  };

  /* 搜的是这一栏已经拉下来的动态：人、正文、附的页面名。动态量还没大到要服务端搜 */
  const q = (query ?? '').trim().toLowerCase();
  const shown = !posts ? null : !q ? posts : posts.filter((p) =>
    [p.body, p.author.displayName, p.author.username, p.app?.name ?? '']
      .some((x) => x.toLowerCase().includes(q)));

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 6 }]}>
        {query === null ? (
          <>
            {([['recommend', '推荐'], ['following', '关注']] as const).map(([k, label]) => (
              <Pressable key={k} onPress={() => { setPosts(null); setFeed(k); }} accessibilityRole="tab">
                <Text style={[s.headerTab, feed === k && s.headerTabOn]}>{label}</Text>
                <View style={[s.headerDot, feed !== k && { opacity: 0 }]} />
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            <Pressable onPress={onBell} hitSlop={10} accessibilityLabel="通知">
              <Icon name="bell" size={23} />
            </Pressable>
            <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="搜索">
              <Icon name="search" size={23} />
            </Pressable>
          </>
        ) : (
          <View style={s.search}>
            <Icon name="search" size={18} color="#72706a" />
            <TextInput
              style={s.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="搜人、动态、页面"
              placeholderTextColor="#a2a09b"
              autoFocus
              returnKeyType="search"
            />
            <Pressable onPress={() => setQuery(null)} hitSlop={10}>
              <Text style={s.searchCancel}>取消</Text>
            </Pressable>
          </View>
        )}
      </View>

      {shown === null ? (
        <View style={s.center}><ActivityIndicator color="#ee5c2a" /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor="#ee5c2a"
            />
          )}
        >
          {shown.length === 0 && (
            <Text style={s.empty}>
              {q ? '没有搜到。换个词试试。'
                : feed === 'following'
                  ? '你关注的人还没发过动态。去探索里点开一个页面，从作者页关注他。'
                  : '还没有人发过动态。你可以是第一个。'}
            </Text>
          )}
          {shown.map((p) => (
            <View key={p.id} style={s.post}>
              <Pressable onPress={() => onAuthor(p.author.username)} accessibilityLabel={p.author.displayName}>
                <View style={[s.avatar, { backgroundColor: washOf(p.author.username) }]}>
                  <Text style={s.avatarText}>{lastChar(p.author.displayName)}</Text>
                </View>
              </Pressable>
              <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
                <Text style={s.meta} numberOfLines={1}>
                  <Text style={s.metaName}>{p.author.displayName}</Text>
                  {p.app ? ' · 发布了一个新页面 · ' : ' · '}
                  {ago(p.createdAt)}
                </Text>
                <Text style={s.body}>{p.body}</Text>

                {p.app && (
                  <View style={s.appCard}>
                    <View style={[s.appTile, { backgroundColor: washOf(p.app.slug) }]}>
                      <Text style={s.appTileText}>{p.app.iconLetter}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={s.appName} numberOfLines={1}>{p.app.name}</Text>
                      <Text style={s.appDesc} numberOfLines={1}>{p.app.description ?? '点开看看'}</Text>
                    </View>
                    <Pressable
                      style={s.appGo}
                      onPress={() => onOpenApp(p.app!.owner, p.app!.slug, p.app!.name)}
                    >
                      <Text style={s.appGoText}>去试试</Text>
                    </Pressable>
                  </View>
                )}

                <View style={s.actions}>
                  <View style={s.action}>
                    <Icon name="msg" size={19} color="#54524e" />
                    <Text style={s.actionText}>{p.commentCount}</Text>
                  </View>
                  {p.app && (
                    <Pressable
                      hitSlop={8}
                      accessibilityLabel="做同款"
                      onPress={() => onRemix(`做一个和「${p.app!.name}」类似的页面：`)}
                    >
                      <Icon name="remix" size={19} color="#54524e" />
                    </Pressable>
                  )}
                  <Pressable style={s.action} onPress={() => void toggleLike(p)} hitSlop={8} accessibilityLabel="喜欢">
                    <Icon
                      name="heart" size={19}
                      color={p.liked ? '#ee5c2a' : '#54524e'}
                      fill={p.liked ? '#ee5c2a' : undefined}
                    />
                    <Text style={[s.actionText, p.liked && s.actionOn]}>{p.likeCount}</Text>
                  </Pressable>
                  <Pressable
                    hitSlop={8}
                    accessibilityLabel="分享"
                    onPress={() => void Share.share({
                      message: p.app
                        ? `${p.body}\n${API_BASE}/${p.app.owner}/${p.app.slug}/`
                        : `${p.author.displayName}：${p.body}`,
                    })}
                  >
                    <Icon name="share" size={19} color="#54524e" />
                  </Pressable>
                </View>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <Pressable
        style={[s.fab, { bottom: insets.bottom + 104 }]}
        onPress={() => setComposing(true)}
        accessibilityLabel="发动态"
      >
        <Icon name="plus" size={28} color="#fff" strokeWidth={2.2} />
      </Pressable>

      {composing && (
        <Compose
          token={token}
          me={me}
          myApps={myApps}
          onClose={() => setComposing(false)}
          onPosted={() => { setComposing(false); setPosts(null); load(); }}
        />
      )}
    </View>
  );
}

/**
 * 发帖（06）。稿上是一整屏：左上关闭、右上发布，头像跟着一行输入，
 * 键盘上方浮一条工具栏。
 */
function Compose({
  token, me, myApps, onClose, onPosted,
}: {
  token: string | null;
  me: { displayName: string };
  myApps: MyApp[];
  onClose: () => void;
  onPosted: () => void;
}) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState('');
  const [appId, setAppId] = useState<string | null>(null);
  /** 「附上页面」那排展开了没有。附了一个就一直亮着，让人看得见附的是什么。 */
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  /*
    键盘高度自己盯，理由同助手那一屏：安卓 edge-to-edge 下窗口不缩，工具栏
    得自己贴到键盘顶上。autoFocus 在 Modal 里不可靠（Modal 动画还没走完就
    聚焦，键盘起不来），所以等它打开再手动聚焦一次。
  */
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => {
      setKb(Math.max(0, Dimensions.get('screen').height - e.endCoordinates.screenY));
    });
    const b = Keyboard.addListener(hideEvt, () => setKb(0));
    const t = setTimeout(() => inputRef.current?.focus(), 350);
    return () => { a.remove(); b.remove(); clearTimeout(t); };
  }, []);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr(null);
    try {
      await api.createPost(token, body, appId ?? undefined);
      onPosted();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /*
    工具栏照稿六颗。动态目前只存文字和一个页面引用——拍照、图片、话题、
    圈人点了说一句还不支持（和电脑端工作台「添加内容」那几项同一个处理），
    @ 直接往正文里插一个 @。附页面那颗是真的。
  */
  const notYet = (what: string) => {
    setHint(`${what}还不支持，动态目前只能发文字和附一个页面`);
    setTimeout(() => setHint(null), 2500);
  };
  const tools: { icon: IconName; label: string; on?: boolean; press: () => void }[] = [
    { icon: 'camera', label: '拍照', press: () => notYet('拍照') },
    { icon: 'image', label: '图片', press: () => notYet('发图片') },
    { icon: 'grid', label: '附上页面', on: true, press: () => setPicking((x) => !x) },
    { icon: 'shapes', label: '话题', press: () => notYet('话题') },
    { icon: 'users', label: '圈人', press: () => notYet('圈人') },
    { icon: 'at', label: '提到', press: () => setText((x) => `${x}@`) },
  ];

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[s.composeRoot, { paddingTop: insets.top + 12 }]}>
        <View style={s.composeBar}>
          <Pressable style={s.composeClose} onPress={onClose} accessibilityLabel="关闭">
            <Icon name="x" size={20} color="#181715" />
          </Pressable>
          <Pressable
            style={[s.composeSend, text.trim() ? s.composeSendOn : null]}
            onPress={() => void send()}
            disabled={!text.trim() || busy}
          >
            <Text style={[s.composeSendText, text.trim() ? s.composeSendTextOn : null]}>
              {busy ? '发布中…' : '发布'}
            </Text>
          </Pressable>
        </View>

        <View style={s.composeMain}>
          <View style={[s.avatar, { backgroundColor: '#ffede0' }]}>
            <Text style={s.avatarText}>{lastChar(me.displayName)}</Text>
          </View>
          <TextInput
            ref={inputRef}
            style={s.composeInput}
            value={text}
            onChangeText={setText}
            placeholder="想分享点什么？"
            placeholderTextColor="#a2a09b"
            selectionColor="#ee5c2a"
            cursorColor="#ee5c2a"
            multiline
            maxLength={2000}
          />
        </View>

        {err && <Text style={s.composeErr}>{err}</Text>}

        <View style={{ marginBottom: kb > 0 ? kb + 10 : insets.bottom + 12, gap: 10 }}>
          {(picking || appId) && (
            <ScrollView
              horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
              keyboardShouldPersistTaps="handled"
            >
              {myApps.length === 0 && <Text style={s.dim}>你还没有发布过页面。</Text>}
              {myApps.map((a) => {
                const on = appId === a.app_id;
                return (
                  <Pressable
                    key={a.app_id}
                    style={[s.chip, on && s.chipOn]}
                    onPress={() => setAppId(on ? null : a.app_id)}
                  >
                    <Text style={[s.chipText, on && s.chipTextOn]}>{a.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {hint && <Text style={s.dim}>{hint}</Text>}
          <View style={s.tools}>
            {tools.map((t) => (
              <Pressable key={t.label} onPress={t.press} hitSlop={6} accessibilityLabel={t.label}>
                <Icon name={t.icon} size={22} color={t.on ? '#ee5c2a' : '#292724'} />
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** 头像与页面小方块的底色：按名字取一个暖色，同一个人每次都是同一个色。 */
const WASHES = ['#ffede0', '#f5ecd5', '#e4e1d9', '#fbe4da', '#eef0e4', '#f1f0fb'];
function washOf(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return WASHES[h % WASHES.length]!;
}

function lastChar(name: string): string {
  const t = (name || '').trim();
  if (!t) return '·';
  return /[一-龥]/.test(t) ? t.slice(-1) : t.slice(0, 1).toUpperCase();
}

/** 「3 小时前」。动态流上写绝对时间会让人去算差值。 */
function ago(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 18, paddingBottom: 10, minHeight: 50 },
  headerTab: { fontSize: 20, fontWeight: '700', color: '#a2a09b' },
  headerTabOn: { color: '#181715', fontWeight: '800' },
  headerDot: { alignSelf: 'center', marginTop: 4, width: 6, height: 6, borderRadius: 3, backgroundColor: '#ee5c2a' },
  search: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 42,
    paddingLeft: 14, paddingRight: 4, borderRadius: 21, backgroundColor: '#f3f1ec',
  },
  searchInput: { flex: 1, fontSize: 15, color: '#181715', paddingVertical: 0 },
  searchCancel: { fontSize: 15, color: '#54524e', paddingHorizontal: 10 },

  empty: { padding: 32, fontSize: 15, lineHeight: 24, color: '#72706a', textAlign: 'center' },

  post: { flexDirection: 'row', gap: 12, paddingVertical: 16, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: '#f3f1ec' },
  avatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 17, fontWeight: '700', color: '#181715' },
  meta: { fontSize: 14, color: '#72706a' },
  metaName: { fontSize: 15, color: '#181715', fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 23, color: '#181715' },

  appCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12,
    borderRadius: 18, backgroundColor: '#f3f1ec',
  },
  appTile: {
    width: 44, height: 44, borderRadius: 12, backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
  },
  appTileText: { fontSize: 17, fontWeight: '700', color: '#181715' },
  appName: { fontSize: 15, fontWeight: '700', color: '#181715' },
  appDesc: { fontSize: 13, color: '#72706a' },
  appGo: {
    height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: '#fff', justifyContent: 'center',
    boxShadow: '0 0 0 1px rgba(24,23,21,.08)',
  },
  appGoText: { fontSize: 14, fontWeight: '700', color: '#ee5c2a' },

  actions: { flexDirection: 'row', alignItems: 'center', gap: 28, paddingTop: 2 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  actionText: { fontSize: 14, color: '#54524e' },
  actionOn: { color: '#ee5c2a', fontWeight: '700' },

  fab: {
    position: 'absolute', right: 18, width: 58, height: 58, borderRadius: 29,
    backgroundColor: '#ee5c2a', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 12px 24px -10px rgba(238,92,42,.9)',
  },

  composeRoot: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 16 },
  composeBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  composeClose: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 10px rgba(24,23,21,.1), 0 0 0 1px rgba(24,23,21,.05)',
  },
  composeSend: { height: 42, paddingHorizontal: 20, borderRadius: 21, backgroundColor: '#f3f1ec', justifyContent: 'center' },
  composeSendOn: { backgroundColor: '#ee5c2a' },
  composeSendText: { fontSize: 16, fontWeight: '700', color: '#a2a09b' },
  composeSendTextOn: { color: '#fff' },
  composeMain: { flex: 1, flexDirection: 'row', gap: 12, paddingTop: 18 },
  composeInput: {
    flex: 1, paddingTop: 10, fontSize: 18, lineHeight: 26, color: '#181715', textAlignVertical: 'top',
  },
  composeErr: { fontSize: 14, color: '#cd2f3a', marginBottom: 8 },

  tools: {
    flexDirection: 'row', alignItems: 'center', gap: 20, alignSelf: 'flex-start',
    height: 54, paddingHorizontal: 20, borderRadius: 27, backgroundColor: '#fff',
    boxShadow: '0 8px 24px -12px rgba(24,23,21,.3), 0 0 0 1px rgba(24,23,21,.06)',
  },
  chip: { height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: '#f3f1ec', justifyContent: 'center' },
  chipOn: { backgroundColor: '#ee5c2a' },
  chipText: { fontSize: 14, color: '#54524e' },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  dim: { fontSize: 13.5, color: '#72706a' },
});
