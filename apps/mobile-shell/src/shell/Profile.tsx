import { useCallback, useEffect, useState } from 'react';
import {
  Image, Modal, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AuthorProfile, Post } from '@ispace/contracts';
import { absCover, api, type Listing } from '../api';
import type { RecentPage } from '../runtime/bridge';
import { Icon } from './Icon';

/**
 * 我（移动端 v2 稿 · 08 我）。
 *
 * 改版前这一格直接是设置页——一屏开关。新稿把它改成了一个人的主页：
 * 头像、关注/粉丝/帖子、下面三栏（页面 / 帖子 / 喜欢），设置收进右上角
 * 那颗齿轮。理由是这一版有了社区：有了关注和帖子，"我"就不再只是一堆
 * 偏好设置，而是别人能看到的那个我。
 *
 * ┌─ 三栏各放什么 ────────────────────────────────────────────────────┐
 * │ 页面：底下再分三小格——我的（自己做的 + 添加的）、喜欢（在探索里点  │
 * │       过心的页面）、最近（这台手机上最近打开的）                    │
 * │ 帖子：我发的动态                                                   │
 * │ 喜欢：我点过心的动态。页面的「喜欢」已经在上面那一小格里了，这里     │
 * │       再放一遍页面就是同一份东西摆两处                              │
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
  /** 自己做的才能交给助手改。 */
  editable: boolean;
}

export function Profile({
  token, username, displayName, spaceUrl, quota, pages, recent, homeKey,
  onOpenPath, onSettings, onConsole, onAuthor, onExpand, onScan, onSetHome, onEdit,
}: {
  token: string | null;
  username: string;
  displayName: string;
  spaceUrl: string;
  /** 顶上那颗容量 chip。没拿到就不显示，不写 0。 */
  quota?: { usedBytes: number; limitBytes: number } | undefined;
  /**
   * 「我的」那一小格。用壳已经加载好的那份（自己的 + 同事分享的 + 从探索
   * 添加的），而不是从 /marketplace 里筛 mine——后者只有公开的那些，
   * 作者自己最常点开的恰恰是还没公开的那几个。
   */
  pages: PageTile[];
  recent: RecentPage[];
  /** 当前设成「手机首页」的那个页面的 key。 */
  homeKey: string | null;
  onOpenPath: (path: string, name: string, cover: string | null) => void;
  onSettings: () => void;
  onConsole: () => void;
  onAuthor: (username: string) => void;
  /** 「扩容」：去控制台提额申请那一块。 */
  onExpand: () => void;
  /** 左上角那颗：扫电脑上页面的二维码，在手机上打开。 */
  onScan: () => void;
  onSetHome: (key: string | null) => void;
  onEdit: (key: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'pages' | 'posts' | 'likes'>('pages');
  const [shelf, setShelf] = useState<'mine' | 'liked' | 'recent'>('mine');
  const [profile, setProfile] = useState<AuthorProfile | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  /** 长按出来的那张小卡：对这个页面能做什么。 */
  const [menu, setMenu] = useState<PageTile | null>(null);

  const load = useCallback(() => {
    void api.author(token, username).then((r) => setProfile(r.profile)).catch(() => setProfile(null));
    void api.marketplace(token).then((r) => setListings(r.listings)).catch(() => setListings([]));
    void api.posts(token, 'recommend')
      .then((r) => setPosts(r.posts))
      .catch(() => setPosts([]))
      .finally(() => setRefreshing(false));
  }, [token, username]);
  useEffect(load, [load]);

  const liked = listings.filter((l) => l.liked);
  const myPosts = posts.filter((p) => p.mine);
  const likedPosts = posts.filter((p) => p.liked);

  const stats: [string, string][] = [
    ['关注', String(profile?.stats.followees ?? 0)],
    ['粉丝', String(profile?.stats.followers ?? 0)],
    ['帖子', String(profile?.stats.posts ?? 0)],
  ];

  const shelves: [typeof shelf, string, number][] = [
    ['mine', '我的', pages.length], ['liked', '喜欢', liked.length], ['recent', '最近', recent.length],
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
            <Pressable onPress={onScan} hitSlop={10} accessibilityLabel="扫一扫">
              <Icon name="qr" size={23} />
            </Pressable>
            <Text style={s.headTitle}>个人资料</Text>
            <Pressable
              onPress={() => void Share.share({ message: `${displayName} 的 iSpace：${spaceUrl}` })}
              hitSlop={10}
              accessibilityLabel="分享我的主页"
            >
              <Icon name="share" size={23} />
            </Pressable>
            <Pressable onPress={onSettings} hitSlop={10} accessibilityLabel="设置">
              <Icon name="settings" size={23} />
            </Pressable>
          </View>

          <View style={s.idRow}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{lastChar(displayName)}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
              <View style={s.nameRow}>
                <Text style={s.name} numberOfLines={1}>{displayName}</Text>
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
                {profile?.department && <Text style={s.chip}>{profile.department}</Text>}
                {quota && (
                  <Text style={[s.chip, s.chipMono]}>
                    {mb(quota.usedBytes)} / {mb(quota.limitBytes)}
                  </Text>
                )}
                <Pressable style={s.chipCta} onPress={onExpand} accessibilityLabel="申请扩容">
                  <Text style={s.chipCtaText}>扩容</Text>
                </Pressable>
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

        {tab === 'pages' && (
          <View style={s.shelves}>
            {shelves.map(([k, label, n]) => (
              <Pressable key={k} style={[s.shelf, shelf === k && s.shelfOn]} onPress={() => setShelf(k)}>
                <Text style={[s.shelfText, shelf === k && s.shelfTextOn]}>{label}</Text>
                <Text style={[s.shelfN, shelf === k && s.shelfTextOn]}>{n}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={s.grid}>
          {tab === 'pages' && (
            <>
              <Pressable style={[s.quick, s.quickBrand]} onPress={onConsole}>
                <Text style={s.quickTitle}>创作者中心</Text>
                <Text style={s.quickSub}>
                  {profile ? `${profile.stats.visits.toLocaleString()} 次访问` : '版本、可见范围、数据'}
                  {' ›'}
                </Text>
              </Pressable>
              {/*
                稿上这一格是「草稿箱」。助手的对话现在落库了，但"草稿"在这里
                说的是没发布的页面——那一份在控制台「页面与版本」里，这一格直通过去。
              */}
              <Pressable style={[s.quick, s.quickPlain]} onPress={onConsole}>
                <Text style={s.quickTitle}>页面与版本</Text>
                <Text style={s.quickSub}>回滚、下架 ›</Text>
              </Pressable>

              {shelf === 'mine' && (pages.length === 0
                ? <Empty text="还没有页面。点左下那颗圆钮，说一句想做什么。" />
                : pages.map((pg) => (
                  <Tile
                    key={pg.key}
                    name={pg.name}
                    letter={pg.letter}
                    cover={pg.cover}
                    sub={pg.owner}
                    home={homeKey === pg.key}
                    onPress={() => onOpenPath(pg.path, pg.name, pg.cover)}
                    onLongPress={() => setMenu(pg)}
                  />
                )))}

              {shelf === 'liked' && (liked.length === 0
                ? <Empty text="还没有喜欢过的页面。在探索里点那颗心。" />
                : liked.map((l) => (
                  <Tile
                    key={l.id}
                    name={l.name}
                    letter={l.icon_letter}
                    cover={absCover(l.cover_path)}
                    sub={l.owner_name}
                    onPress={() => onOpenPath(`/${l.owner_username}/${l.slug}/`, l.name, absCover(l.cover_path))}
                  />
                )))}

              {shelf === 'recent' && (recent.length === 0
                ? <Empty text="这台手机上还没打开过页面。" />
                : recent.map((r) => (
                  <Tile
                    key={r.path}
                    name={r.name}
                    letter={r.name.slice(0, 1)}
                    cover={r.cover}
                    onPress={() => onOpenPath(r.path, r.name, r.cover)}
                  />
                )))}
            </>
          )}

          {tab === 'posts' && (myPosts.length === 0
            ? <Empty text="还没发过动态。去社区里发一条。" />
            : myPosts.map((p) => <PostCard key={p.id} post={p} />))}

          {tab === 'likes' && (likedPosts.length === 0
            ? <Empty text="还没喜欢过谁的动态。在社区里点那颗心。" />
            : likedPosts.map((p) => <PostCard key={p.id} post={p} />))}
        </View>
      </ScrollView>

      <Modal visible={menu !== null} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={s.mask} onPress={() => setMenu(null)}>
          <View style={[s.menu, { marginBottom: insets.bottom + 24 }]}>
            <Text style={s.menuTitle} numberOfLines={1}>{menu?.name}</Text>
            <MenuRow
              label={menu && homeKey === menu.key ? '不再作为手机首页' : '设为手机首页'}
              note="打开 App 直接就是它"
              onPress={() => { if (menu) onSetHome(homeKey === menu.key ? null : menu.key); setMenu(null); }}
            />
            {menu?.editable && (
              <MenuRow
                label="让助手改它"
                note="说一句想怎么改，确认后覆盖这个页面"
                onPress={() => { if (menu) onEdit(menu.key); setMenu(null); }}
              />
            )}
            <MenuRow
              label="打开"
              onPress={() => { if (menu) onOpenPath(menu.path, menu.name, menu.cover); setMenu(null); }}
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function Tile({
  name, letter, cover, sub, home, onPress, onLongPress,
}: {
  name: string; letter: string; cover: string | null; sub?: string | undefined; home?: boolean;
  onPress: () => void; onLongPress?: () => void;
}) {
  return (
    <Pressable style={s.tile} onPress={onPress} onLongPress={onLongPress} accessibilityLabel={name}>
      <View style={s.tileCover}>
        {cover
          ? <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          : <Text style={s.tileLetter}>{letter}</Text>}
        {home && <Text style={s.homeTag}>手机首页</Text>}
      </View>
      <Text style={s.tileName} numberOfLines={1}>{name}</Text>
      {sub && <Text style={s.tileSub} numberOfLines={1}>{sub}</Text>}
    </Pressable>
  );
}

function PostCard({ post }: { post: Post }) {
  return (
    <View style={s.postCard}>
      <Text style={s.postBody} numberOfLines={4}>{post.body}</Text>
      <View style={s.postMeta}>
        <Icon name="heart" size={16} color="#72706a" />
        <Text style={s.postMetaText}>{post.likeCount}</Text>
        <Icon name="msg" size={16} color="#72706a" />
        <Text style={s.postMetaText}>{post.commentCount}</Text>
      </View>
    </View>
  );
}

function MenuRow({ label, note, onPress }: { label: string; note?: string; onPress: () => void }) {
  return (
    <Pressable style={s.menuRow} onPress={onPress}>
      <Text style={s.menuLabel}>{label}</Text>
      {note && <Text style={s.menuNote}>{note}</Text>}
    </Pressable>
  );
}

const Empty = ({ text }: { text: string }) => <Text style={s.empty}>{text}</Text>;

function lastChar(name: string): string {
  const t = (name || '').trim();
  if (!t) return '·';
  return /[一-龥]/.test(t) ? t.slice(-1) : t.slice(0, 1).toUpperCase();
}

const mb = (n: number): string => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f6f4ee' },
  head: { backgroundColor: '#fff', paddingHorizontal: 18, paddingBottom: 18 },
  headBar: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 19, fontWeight: '700', color: '#181715' },

  idRow: { flexDirection: 'row', gap: 16, paddingTop: 22 },
  avatar: {
    width: 82, height: 82, borderRadius: 41, backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 0 0 4px #ffffff, 0 0 0 5px #f3f1ec',
  },
  avatarText: { fontSize: 32, fontWeight: '700', color: '#181715' },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  name: { flexShrink: 1, fontSize: 21, fontWeight: '800', color: '#181715' },
  handle: { fontSize: 15, color: '#72706a' },
  statRow: { flexDirection: 'row' },
  stat: { flex: 1 },
  statV: { fontSize: 19, fontWeight: '700', color: '#181715', fontVariant: ['tabular-nums'] },
  statK: { fontSize: 13, color: '#72706a' },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    height: 28, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#f3f1ec',
    color: '#54524e', fontSize: 13, fontWeight: '600', lineHeight: 28, overflow: 'hidden',
  },
  chipMono: { color: '#292724', fontVariant: ['tabular-nums'] },
  chipCta: { height: 28, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#ee5c2a', justifyContent: 'center' },
  chipCtaText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  tabs: {
    flexDirection: 'row', marginTop: 20, padding: 5, borderRadius: 30, backgroundColor: '#fff',
    boxShadow: '0 0 0 1px rgba(24,23,21,.08), 0 6px 16px -10px rgba(24,23,21,.25)',
  },
  tab: { flex: 1, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: '#f3f1ec' },
  tabText: { fontSize: 17, fontWeight: '700', color: '#181715' },
  tabTextOn: { color: '#ee5c2a' },

  shelves: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 2 },
  shelf: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 16,
    borderRadius: 18, backgroundColor: '#ebe8e1',
  },
  shelfOn: { backgroundColor: '#ee5c2a' },
  shelfText: { fontSize: 15, fontWeight: '600', color: '#72706a' },
  shelfN: { fontSize: 15, fontWeight: '500', color: '#72706a', fontVariant: ['tabular-nums'] },
  shelfTextOn: { color: '#fff', fontWeight: '700' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 14 },
  quick: {
    width: '48.5%', height: 150, borderRadius: 20, padding: 18, justifyContent: 'center', gap: 6,
  },
  quickBrand: { backgroundColor: '#fbe4da' },
  quickPlain: { backgroundColor: '#fff' },
  quickTitle: { fontSize: 19, fontWeight: '800', color: '#181715' },
  quickSub: { fontSize: 14, color: '#54524e' },

  tile: { width: '48.5%', gap: 6 },
  tileCover: {
    width: '100%', height: 150, borderRadius: 20, overflow: 'hidden', backgroundColor: '#e4e1d9',
    alignItems: 'center', justifyContent: 'center',
  },
  tileLetter: { fontSize: 32, fontWeight: '800', color: 'rgba(24,23,21,.45)' },
  homeTag: {
    position: 'absolute', top: 10, left: 10, height: 24, paddingHorizontal: 8, borderRadius: 7,
    backgroundColor: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 24, color: '#181715', overflow: 'hidden',
  },
  tileName: { fontSize: 14, fontWeight: '600', color: '#181715', paddingHorizontal: 2 },
  tileSub: { fontSize: 12, color: '#72706a', paddingHorizontal: 2 },

  postCard: { width: '100%', padding: 16, borderRadius: 20, backgroundColor: '#fff', gap: 10 },
  postBody: { fontSize: 15, lineHeight: 23, color: '#181715' },
  postMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  postMetaText: { fontSize: 13, color: '#72706a', marginRight: 14 },

  empty: { width: '100%', padding: 24, fontSize: 14, lineHeight: 22, color: '#72706a' },

  mask: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,.42)', paddingHorizontal: 12 },
  menu: { borderRadius: 24, backgroundColor: '#fff', paddingVertical: 8 },
  menuTitle: { fontSize: 14, color: '#72706a', paddingHorizontal: 20, paddingVertical: 10 },
  menuRow: { paddingHorizontal: 20, paddingVertical: 14, gap: 2 },
  menuLabel: { fontSize: 16, fontWeight: '600', color: '#181715' },
  menuNote: { fontSize: 13, color: '#72706a' },
});
