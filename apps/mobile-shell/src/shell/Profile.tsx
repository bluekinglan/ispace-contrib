import { useCallback, useEffect, useState } from 'react';
import {
  Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import type { AuthorProfile, Post } from '@ispace/contracts';
import { absCover, api, type Listing } from '../api';

/**
 * 我（移动端 v2 稿 · 08 我）。
 *
 * 改版前这一格直接是设置页——一屏开关。新稿把它改成了一个人的主页：
 * 头像、关注/粉丝/帖子、下面三栏（页面 / 帖子 / 喜欢），设置收进右上角
 * 那颗齿轮。理由是这一版有了社区：有了关注和帖子，"我"就不再只是一堆
 * 偏好设置，而是别人能看到的那个我。
 *
 * ┌─ 三栏的数据都来自已经拉过的那两份 ────────────────────────────────┐
 * │ 页面：/marketplace 里 mine 的那些 + 壳已经知道的我的页面          │
 * │ 帖子：/posts 里 mine 的那些                                        │
 * │ 喜欢：/marketplace 里 liked 的那些                                 │
 * │ 没有为这三栏各加一条接口——它们是同一份数据的三种筛法，而手机上    │
 * │ 多一次请求就多一次转圈。                                           │
 * └────────────────────────────────────────────────────────────────────┘
 */
export interface PageTile {
  key: string;
  name: string;
  letter: string;
  cover: string | null;
  /** 别人分享/我装的那些带作者名，自己的不带。 */
  owner?: string | undefined;
  path: string;
}

export function Profile({
  token, username, displayName, spaceUrl, quota, pages,
  onOpenPath, onSettings, onConsole, onAuthor,
}: {
  token: string | null;
  username: string;
  displayName: string;
  spaceUrl: string;
  /** 顶上那颗容量 chip。没拿到就不显示，不写 0。 */
  quota?: { usedBytes: number; limitBytes: number } | undefined;
  /**
   * 「页面」那一栏。用壳已经加载好的那份（自己的 + 同事分享的 + 从探索
   * 添加的），而不是从 /marketplace 里筛 mine——后者只有公开的那些，
   * 作者自己最常点开的恰恰是还没公开的那几个。
   */
  pages: PageTile[];
  onOpenPath: (path: string, name: string) => void;
  onSettings: () => void;
  onConsole: () => void;
  onAuthor: (username: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'pages' | 'posts' | 'likes'>('pages');
  const [profile, setProfile] = useState<AuthorProfile | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    void api.author(token, username).then((r) => setProfile(r.profile)).catch(() => setProfile(null));
    void api.marketplace(token).then((r) => setListings(r.listings)).catch(() => setListings([]));
    void api.posts(token, 'recommend')
      .then((r) => setPosts(r.posts.filter((p) => p.mine)))
      .catch(() => setPosts([]))
      .finally(() => setRefreshing(false));
  }, [token, username]);
  useEffect(load, [load]);

  const liked = listings.filter((l) => l.liked);

  const stats: [string, string][] = [
    ['关注', String(profile?.stats.followees ?? 0)],
    ['粉丝', String(profile?.stats.followers ?? 0)],
    ['帖子', String(profile?.stats.posts ?? 0)],
  ];

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
        refreshControl={(
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#ee5c2a" />
        )}
      >
        <View style={[s.head, { paddingTop: insets.top + 10 }]}>
          <View style={s.headBar}>
            <Text style={s.headTitle}>个人资料</Text>
            <Pressable onPress={onSettings} hitSlop={12} accessibilityLabel="设置">
              <GearGlyph />
            </Pressable>
          </View>

          <View style={s.idRow}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{lastChar(displayName)}</Text>
            </View>
            <View style={{ flex: 1, gap: 10 }}>
              <View style={s.nameRow}>
                <Text style={s.name}>{displayName}</Text>
                <Text style={s.handle}>@{username}</Text>
              </View>
              <View style={s.statRow}>
                {stats.map(([k, v]) => (
                  <Pressable key={k} style={s.stat} onPress={() => onAuthor(username)}>
                    <Text style={s.statV}>{v}</Text>
                    <Text style={s.statK}>{k}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={s.chips}>
                <Text style={s.chip}>{spaceUrl.replace(/^https?:\/\//, '')}</Text>
                {quota && (
                  <Text style={s.chip}>
                    {mb(quota.usedBytes)} / {mb(quota.limitBytes)}
                  </Text>
                )}
              </View>
            </View>
          </View>

          <View style={s.tabs}>
            {([['pages', '页面'], ['posts', '帖子'], ['likes', '喜欢']] as const).map(([k, label]) => (
              <Pressable key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => setTab(k)} accessibilityRole="tab">
                <Text style={[s.tabText, tab === k && s.tabTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={s.quickRow}>
          <Pressable style={[s.quick, s.quickBrand]} onPress={onConsole}>
            <Text style={s.quickTitle}>创作者中心</Text>
            <Text style={s.quickSub}>
              {profile ? `${profile.stats.visits} 次访问 ›` : '版本、可见范围、数据 ›'}
            </Text>
          </Pressable>
          <Pressable style={s.quick} onPress={onConsole}>
            <Text style={s.quickTitle}>页面与版本</Text>
            <Text style={s.quickSub}>回滚、下架 ›</Text>
          </Pressable>
        </View>

        <View style={s.grid}>
          {tab === 'pages' && (pages.length === 0
            ? <Empty text="还没有页面。点左下那颗圆钮，说一句想做什么。" />
            : pages.map((pg) => (
              <Tile
                key={pg.key}
                name={pg.name}
                letter={pg.letter}
                cover={pg.cover}
                sub={pg.owner}
                onPress={() => onOpenPath(pg.path, pg.name)}
              />
            )))}

          {tab === 'likes' && (liked.length === 0
            ? <Empty text="还没有喜欢过的页面。在探索里点那颗心。" />
            : liked.map((l) => (
              <Tile
                key={l.id}
                name={l.name}
                letter={l.icon_letter}
                cover={absCover(l.cover_path)}
                sub={l.owner_name}
                onPress={() => onOpenPath(`/${l.owner_username}/${l.slug}/`, l.name)}
              />
            )))}

          {tab === 'posts' && (posts.length === 0
            ? <Empty text="还没发过动态。去社区里发一条。" />
            : posts.map((p) => (
              <View key={p.id} style={s.postCard}>
                <Text style={s.postBody} numberOfLines={4}>{p.body}</Text>
                <Text style={s.postMeta}>♥ {p.likeCount} · 💬 {p.commentCount}</Text>
              </View>
            )))}
        </View>
      </ScrollView>
    </View>
  );
}

function Tile({
  name, letter, cover, sub, onPress,
}: {
  name: string; letter: string; cover: string | null; sub?: string | undefined; onPress: () => void;
}) {
  return (
    <Pressable style={s.tile} onPress={onPress} accessibilityLabel={name}>
      {cover
        ? <Image source={{ uri: cover }} style={s.tileCover} resizeMode="cover" />
        : (
          <View style={[s.tileCover, s.tileFallback]}>
            <Text style={s.tileLetter}>{letter}</Text>
          </View>
        )}
      <Text style={s.tileName} numberOfLines={1}>{name}</Text>
      {sub && <Text style={s.tileSub} numberOfLines={1}>{sub}</Text>}
    </Pressable>
  );
}

const Empty = ({ text }: { text: string }) => <Text style={s.empty}>{text}</Text>;

function GearGlyph() {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={3} stroke="#292724" strokeWidth={1.9} />
      <Path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        stroke="#292724" strokeWidth={1.9} strokeLinejoin="round"
      />
    </Svg>
  );
}

function lastChar(name: string): string {
  const t = (name || '').trim();
  if (!t) return '·';
  return /[一-龥]/.test(t) ? t.slice(-1) : t.slice(0, 1).toUpperCase();
}

const mb = (n: number): string => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f6f4ee' },
  head: { backgroundColor: '#fff', paddingHorizontal: 18, paddingBottom: 18 },
  headBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headTitle: { fontSize: 19, fontWeight: '700', color: '#181715' },

  idRow: { flexDirection: 'row', gap: 16, paddingTop: 22 },
  avatar: {
    width: 82, height: 82, borderRadius: 41, backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 32, fontWeight: '700', color: '#181715' },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  name: { fontSize: 21, fontWeight: '800', color: '#181715' },
  handle: { fontSize: 15, color: '#72706a' },
  statRow: { flexDirection: 'row' },
  stat: { flex: 1 },
  statV: { fontSize: 19, fontWeight: '700', color: '#181715' },
  statK: { fontSize: 13, color: '#72706a' },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    height: 28, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#f3f1ec',
    color: '#54524e', fontSize: 13, lineHeight: 28,
  },

  tabs: {
    flexDirection: 'row', marginTop: 20, padding: 5, borderRadius: 30,
    backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(24,23,21,.08)',
  },
  tab: { flex: 1, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: '#f3f1ec' },
  tabText: { fontSize: 17, fontWeight: '700', color: '#181715' },
  tabTextOn: { color: '#ee5c2a' },

  quickRow: { flexDirection: 'row', gap: 10, padding: 14 },
  quick: {
    flex: 1, height: 96, borderRadius: 20, backgroundColor: '#fff',
    justifyContent: 'center', paddingHorizontal: 18, gap: 6,
  },
  quickBrand: { backgroundColor: '#fbe4da' },
  quickTitle: { fontSize: 17, fontWeight: '800', color: '#181715' },
  quickSub: { fontSize: 13, color: '#54524e' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 14 },
  tile: { width: '48%', gap: 6 },
  tileCover: { width: '100%', height: 150, borderRadius: 20, backgroundColor: '#e4e1d9' },
  tileFallback: { alignItems: 'center', justifyContent: 'center' },
  tileLetter: { fontSize: 32, fontWeight: '800', color: 'rgba(24,23,21,.45)' },
  tileName: { fontSize: 14, fontWeight: '600', color: '#181715', paddingHorizontal: 2 },
  tileSub: { fontSize: 12, color: '#72706a', paddingHorizontal: 2 },

  postCard: { width: '100%', padding: 16, borderRadius: 20, backgroundColor: '#fff', gap: 8 },
  postBody: { fontSize: 15, lineHeight: 23, color: '#181715' },
  postMeta: { fontSize: 13, color: '#72706a' },

  empty: { padding: 24, fontSize: 14, lineHeight: 22, color: '#72706a' },
});
