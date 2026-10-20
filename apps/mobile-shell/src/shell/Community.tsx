import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import type { Post } from '@ispace/contracts';
import { api, type Listing } from '../api';

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
export function Community({
  token, myApps, onOpenApp, onAuthor,
}: {
  token: string | null;
  /** 发帖时能附上的页面：只有自己的（服务端也只收自己的）。 */
  myApps: Listing[];
  onOpenApp: (owner: string, slug: string, name: string) => void;
  onAuthor: (username: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [feed, setFeed] = useState<'recommend' | 'following'>('recommend');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [composing, setComposing] = useState(false);

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

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 6 }]}>
        {([['recommend', '推荐'], ['following', '关注']] as const).map(([k, label]) => (
          <Pressable key={k} onPress={() => { setPosts(null); setFeed(k); }} accessibilityRole="tab">
            <Text style={[s.headerTab, feed === k && s.headerTabOn]}>{label}</Text>
            {feed === k && <View style={s.headerDot} />}
          </Pressable>
        ))}
      </View>

      {posts === null ? (
        <View style={s.center}><ActivityIndicator color="#ee5c2a" /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor="#ee5c2a"
            />
          )}
        >
          {posts.length === 0 && (
            <Text style={s.empty}>
              {feed === 'following'
                ? '你关注的人还没发过动态。去探索里点开一个页面，从作者页关注他。'
                : '还没有人发过动态。你可以是第一个。'}
            </Text>
          )}
          {posts.map((p) => (
            <View key={p.id} style={s.post}>
              <Pressable onPress={() => onAuthor(p.author.username)} accessibilityLabel={p.author.displayName}>
                <View style={s.avatar}>
                  <Text style={s.avatarText}>{lastChar(p.author.displayName)}</Text>
                </View>
              </Pressable>
              <View style={{ flex: 1, gap: 8 }}>
                <Text style={s.meta} numberOfLines={1}>
                  <Text style={s.metaName}>{p.author.displayName}</Text>
                  {p.app ? ' · 发布了一个新页面 · ' : ' · '}
                  {ago(p.createdAt)}
                </Text>
                <Text style={s.body}>{p.body}</Text>

                {p.app && (
                  <View style={s.appCard}>
                    <View style={s.appTile}>
                      <Text style={s.appTileText}>{p.app.iconLetter}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
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
                  <Text style={s.action}>💬 {p.commentCount}</Text>
                  <Pressable onPress={() => void toggleLike(p)} accessibilityLabel="喜欢">
                    <Text style={[s.action, p.liked && s.actionOn]}>♥ {p.likeCount}</Text>
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
        <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
          <Path d="M5 12h14M12 5v14" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" />
        </Svg>
      </Pressable>

      {composing && (
        <Compose
          token={token}
          myApps={myApps}
          onClose={() => setComposing(false)}
          onPosted={() => { setComposing(false); setPosts(null); load(); }}
        />
      )}
    </View>
  );
}

/** 发帖（06）。稿上是一整屏：头像、一块空白、底下一条工具栏。 */
function Compose({
  token, myApps, onClose, onPosted,
}: {
  token: string | null;
  myApps: Listing[];
  onClose: () => void;
  onPosted: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [appId, setAppId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr(null);
    try {
      await api.createPost(token, body, appId ?? undefined);
      onPosted();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[s.composeRoot, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <View style={s.composeBar}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="关闭">
            <Text style={s.composeClose}>✕</Text>
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

        <TextInput
          style={s.composeInput}
          value={text}
          onChangeText={setText}
          placeholder="想分享点什么？"
          placeholderTextColor="#a2a09b"
          multiline
          autoFocus
          maxLength={2000}
        />

        {err && <Text style={s.composeErr}>{err}</Text>}

        {/*
          附页面只能附自己的。稿上这一排是一条工具栏（相机、图片、页面、
          @……）——相机和图片这里没做：动态目前只存文字和一个页面引用，
          做个按钮点下去说"还不支持"，不如先不摆。
        */}
        <Text style={s.composeLabel}>附上我的一个页面</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
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
      </View>
    </Modal>
  );
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
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: 18, paddingHorizontal: 18, paddingBottom: 10 },
  headerTab: { fontSize: 20, fontWeight: '700', color: '#a2a09b' },
  headerTabOn: { color: '#181715', fontWeight: '800' },
  headerDot: { alignSelf: 'center', marginTop: 4, width: 6, height: 6, borderRadius: 3, backgroundColor: '#ee5c2a' },

  empty: { padding: 32, fontSize: 15, lineHeight: 24, color: '#72706a', textAlign: 'center' },

  post: { flexDirection: 'row', gap: 12, padding: 16, borderBottomWidth: 1, borderBottomColor: '#f3f1ec' },
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
  appGo: { height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: '#fff', justifyContent: 'center' },
  appGoText: { fontSize: 14, fontWeight: '700', color: '#ee5c2a' },

  actions: { flexDirection: 'row', gap: 28, paddingTop: 2 },
  action: { fontSize: 14, color: '#54524e' },
  actionOn: { color: '#ee5c2a', fontWeight: '700' },

  fab: {
    position: 'absolute', right: 18, width: 58, height: 58, borderRadius: 29,
    backgroundColor: '#ee5c2a', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#ee5c2a', shadowOpacity: 0.5, shadowRadius: 12,
    shadowOffset: { width: 0, height: 10 }, elevation: 6,
  },

  composeRoot: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 16, gap: 12 },
  composeBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  composeClose: { fontSize: 20, color: '#181715', paddingHorizontal: 6 },
  composeSend: { height: 42, paddingHorizontal: 20, borderRadius: 21, backgroundColor: '#f3f1ec', justifyContent: 'center' },
  composeSendOn: { backgroundColor: '#ee5c2a' },
  composeSendText: { fontSize: 16, fontWeight: '700', color: '#a2a09b' },
  composeSendTextOn: { color: '#fff' },
  composeInput: { flex: 1, fontSize: 18, lineHeight: 28, color: '#181715', textAlignVertical: 'top' },
  composeErr: { fontSize: 14, color: '#cd2f3a' },
  composeLabel: { fontSize: 13, color: '#72706a' },

  chip: { height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: '#f3f1ec', justifyContent: 'center' },
  chipOn: { backgroundColor: '#ee5c2a' },
  chipText: { fontSize: 14, color: '#54524e' },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  dim: { fontSize: 14, color: '#72706a' },
});
