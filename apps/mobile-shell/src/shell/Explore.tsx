import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Dimensions, FlatList, Image, Modal, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import type { Comment } from '@ispace/contracts';
import { absCover, api, type Listing } from '../api';

/**
 * 探索（移动端 v2 稿 · 03 推荐 / 04 做同款）。
 *
 * ┌─ 它替掉了什么 ────────────────────────────────────────────────────┐
 * │ 旧的「创意集市」是一列卡片：封面缩略图 + 名字 + 作者 + 一颗「添加」。│
 * │ 新稿把它改成整屏一个——一次只看一个页面，上下滑着刷。手机上那一列    │
 * │ 卡片的问题是：每张都小得看不出页面长什么样，于是"装不装"全靠名字    │
 * │ 猜。整屏铺开之后，封面才真的起到了封面的作用。                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 没有封面的页面铺一块底色加一行字，而不是跳过它——跳过等于让没截图的人
 * 永远排不上，而封面是发布时自动截的，新页面往往还没截到。
 */
export function Explore({
  token, onOpen, onRemix, onAuthor, onInstalled,
}: {
  token: string | null;
  /** 「去试试」：用 WebView 打开这个页面。 */
  onOpen: (l: Listing) => void;
  /** 「做同款」：带着提示词去助手那一屏。 */
  onRemix: (l: Listing) => void;
  onAuthor: (username: string) => void;
  /** 装了别人的页面之后，壳要重拉一次自己的页面列表。 */
  onInstalled: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'recommend' | 'event'>('recommend');
  const [sheet, setSheet] = useState<Listing | null>(null);
  const { height } = Dimensions.get('window');

  const load = useCallback(() => {
    setLoading(true);
    void api.marketplace(token)
      .then((r) => setItems(r.listings))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [token]);
  useEffect(load, [load]);

  /* 「1024」那一格只看带 1024 分类的作品，和电脑端那颗带点的分类是同一批 */
  const shown = tab === 'event'
    ? items.filter((l) => (l.category ?? '').includes('1024'))
    : items;

  const setLiked = (appId: string, liked: boolean, likeCount: number) => {
    setItems((prev) => prev.map((l) => (l.app_id === appId ? { ...l, liked, like_count: likeCount } : l)));
  };

  if (loading) {
    return (
      <View style={[s.full, s.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={s.full}>
      <FlatList
        data={shown}
        keyExtractor={(l) => l.id}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
        ListEmptyComponent={(
          <View style={[{ height }, s.center]}>
            <Text style={s.emptyText}>
              {tab === 'event' ? '还没有 1024 作品。' : '还没有同事把页面分享到全公司。'}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Card
            item={item}
            height={height}
            token={token}
            onOpen={() => onOpen(item)}
            onAuthor={() => onAuthor(item.owner_username)}
            onSheet={() => setSheet(item)}
            onLiked={setLiked}
          />
        )}
      />

      {/* 顶上那粒胶囊。浮在封面上，所以带一层半透明白底 */}
      <View style={[s.top, { paddingTop: insets.top + 10 }]} pointerEvents="box-none">
        <View style={s.topPill}>
          {([['recommend', '推荐'], ['event', '1024']] as const).map(([k, label]) => (
            <Pressable key={k} onPress={() => setTab(k)} accessibilityRole="tab">
              <Text style={[s.topTab, tab === k ? s.topTabOn : null]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {sheet && (
        <RemixSheet
          item={sheet}
          token={token}
          onClose={() => setSheet(null)}
          onRemix={() => { const l = sheet; setSheet(null); onRemix(l); }}
          onInstalled={(appId, installed) => {
            setItems((prev) => prev.map((l) => (l.app_id === appId ? { ...l, installed } : l)));
            setSheet((prev) => (prev && prev.app_id === appId ? { ...prev, installed } : prev));
            onInstalled();
          }}
        />
      )}
    </View>
  );
}

function Card({
  item, height, token, onOpen, onAuthor, onSheet, onLiked,
}: {
  item: Listing;
  height: number;
  token: string | null;
  onOpen: () => void;
  onAuthor: () => void;
  onSheet: () => void;
  onLiked: (appId: string, liked: boolean, likeCount: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const cover = absCover(item.cover_path);
  const [busy, setBusy] = useState(false);

  const toggleLike = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = item.liked ? await api.unlike(token, item.app_id) : await api.like(token, item.app_id);
      onLiked(item.app_id, r.liked, r.likeCount);
    } catch { /* 点赞失败就当没点：这一下不值得打断看页面的人 */ } finally { setBusy(false); }
  };

  return (
    <Pressable style={[s.card, { height }]} onPress={onOpen} accessibilityLabel={`打开 ${item.name}`}>
      {cover
        ? <Image source={{ uri: cover }} style={s.cover} resizeMode="cover" />
        : (
          <View style={[s.cover, s.center, { backgroundColor: '#e4e1d9' }]}>
            <Text style={s.coverText}>{item.name}</Text>
            <Text style={s.coverHint}>还没有封面 · 点开看看</Text>
          </View>
        )}

      {/* 右侧动作栏。贴着底栏上方，和稿上一致 */}
      <View style={[s.rail, { bottom: insets.bottom + 108 }]}>
        <Pressable onPress={onAuthor} style={s.railAvatar} accessibilityLabel={item.owner_name}>
          <Text style={s.railAvatarText}>{lastChar(item.owner_name)}</Text>
        </Pressable>
        <RailBtn label={String(item.like_count)} onPress={() => void toggleLike()}>
          <HeartGlyph filled={item.liked} />
        </RailBtn>
        <RailBtn label={String(item.comment_count)} onPress={onSheet}>
          <MsgGlyph />
        </RailBtn>
        <RailBtn label="做同款" onPress={onSheet}>
          <WandGlyph />
        </RailBtn>
      </View>

      {/* 左下那块信息。和动作栏同一条基线 */}
      <View style={[s.info, { bottom: insets.bottom + 108 }]} pointerEvents="none">
        <Text style={s.infoName}>{item.name}</Text>
        <Text style={s.infoBy}>{item.owner_name} · {item.install_count} 人在用</Text>
      </View>
    </Pressable>
  );
}

/**
 * 上拉的那张卡（04 做同款）。
 *
 * 两栏：评论和做同款。稿上默认停在「做同款」——人滑到这儿、点了那根魔杖，
 * 想做的就是照着做一个；评论是顺带看一眼的东西。
 */
function RemixSheet({
  item, token, onClose, onRemix, onInstalled,
}: {
  item: Listing;
  token: string | null;
  onClose: () => void;
  onRemix: () => void;
  onInstalled: (appId: string, installed: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const [installing, setInstalling] = useState(false);
  const [tab, setTab] = useState<'comments' | 'remix'>(item.source_prompt ? 'remix' : 'comments');
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const sending = useRef(false);

  useEffect(() => {
    void api.comments(token, item.app_id)
      .then((r) => setComments(r.comments))
      .catch(() => setComments([]));
  }, [token, item.app_id]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending.current) return;
    sending.current = true;
    try {
      const r = await api.addComment(token, item.app_id, body);
      setComments((prev) => [r.comment, ...(prev ?? [])]);
      setDraft('');
    } catch { /* 失败就把字留在框里，用户自己重试 */ } finally { sending.current = false; }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.sheetBackdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 20 }]}>
        <View style={s.sheetTabs}>
          {([['comments', `评论 ${comments?.length ?? item.comment_count}`], ['remix', '做同款']] as const).map(([k, label]) => (
            <Pressable key={k} style={s.sheetTab} onPress={() => setTab(k)} accessibilityRole="tab">
              <Text style={[s.sheetTabText, tab === k && s.sheetTabTextOn]}>{label}</Text>
              <View style={[s.sheetTabBar, tab === k && s.sheetTabBarOn]} />
            </Pressable>
          ))}
        </View>

        {tab === 'comments' ? (
          <View style={{ flex: 1 }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 12, gap: 16 }}>
              {comments === null && <Text style={s.dim}>正在加载…</Text>}
              {comments?.length === 0 && <Text style={s.dim}>还没有评论，来说说你的用法吧。</Text>}
              {comments?.map((c) => (
                <View key={c.id} style={s.comment}>
                  <View style={s.commentAvatar}>
                    <Text style={s.commentAvatarText}>{lastChar(c.author.displayName)}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={s.commentWho}>{c.author.displayName}</Text>
                    <Text style={s.commentBody}>{c.body}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
            <View style={s.composer}>
              <TextInput
                style={s.composerInput}
                value={draft}
                onChangeText={setDraft}
                placeholder="写下评论…"
                placeholderTextColor="#a2a09b"
                maxLength={500}
                onSubmitEditing={() => void send()}
                returnKeyType="send"
              />
              <Pressable style={s.composerSend} onPress={() => void send()} accessibilityLabel="发送">
                <Text style={s.composerSendText}>发送</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, gap: 14 }}>
            {item.source_prompt ? (
              <>
                <Text style={s.sheetLabel}>做它的那句话</Text>
                <ScrollView style={s.promptBox}>
                  <Text style={s.promptText}>{item.source_prompt}</Text>
                </ScrollView>
              </>
            ) : (
              <Text style={s.dim}>
                这个页面没有留下提示词（手工上传的页面没有）。照着做一个也行——
                点下面那颗，把你想要的说给助手听。
              </Text>
            )}
            <View style={{ flex: 1 }} />
            {/*
              「添加到我的」在稿上没有——稿里这一屏只有做同款。但手机端此前
              的创意市场是能装的，那条路没了的话，看到一个好用的页面就只剩
              "照着做一个"，而很多时候人要的就是直接用他那个。
            */}
            {!item.mine && (
              <Pressable
                style={s.secondary}
                disabled={installing}
                onPress={() => {
                  setInstalling(true);
                  const fn = item.installed ? api.uninstallFromMarket : api.installFromMarket;
                  void fn(token, item.app_id)
                    .then(() => onInstalled(item.app_id, !item.installed))
                    .catch(() => undefined)
                    .finally(() => setInstalling(false));
                }}
              >
                <Text style={s.secondaryText}>
                  {item.installed ? '已添加到我的 · 点此移除' : '添加到我的'}
                </Text>
              </Pressable>
            )}
            <Pressable style={s.cta} onPress={onRemix}>
              <Text style={s.ctaText}>照这个做一个</Text>
            </Pressable>
            <Text style={s.ctaHint}>只带走做法，不带走 {item.owner_name} 的数据</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

function RailBtn({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable style={s.railBtn} onPress={onPress} accessibilityLabel={label}>
      {children}
      <Text style={s.railLabel}>{label}</Text>
    </Pressable>
  );
}

/** 中文名取最后一个字，英文取首字母——和电脑端 initial() 同一条规则。 */
function lastChar(name: string): string {
  const t = (name || '').trim();
  if (!t) return '·';
  return /[一-龥]/.test(t) ? t.slice(-1) : t.slice(0, 1).toUpperCase();
}

function HeartGlyph({ filled }: { filled: boolean }) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill={filled ? '#ee5c2a' : 'none'}>
      <Path
        d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"
        stroke={filled ? '#ee5c2a' : '#fff'} strokeWidth={1.9} strokeLinejoin="round"
      />
    </Svg>
  );
}

function MsgGlyph() {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" stroke="#fff" strokeWidth={1.9} strokeLinejoin="round" />
    </Svg>
  );
}

function WandGlyph() {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Path
        d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"
        stroke="#fff" strokeWidth={1.9} strokeLinejoin="round"
      />
      <Path d="m14 7 3 3" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" />
      <Circle cx={5} cy={8} r={1} fill="#fff" />
      <Circle cx={19} cy={16} r={1} fill="#fff" />
    </Svg>
  );
}

const s = StyleSheet.create({
  full: { flex: 1, backgroundColor: '#100f0e' },
  center: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: 'rgba(255,255,255,.7)', fontSize: 15, paddingHorizontal: 32, textAlign: 'center' },

  card: { width: '100%' },
  cover: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  coverText: { fontSize: 22, fontWeight: '800', color: 'rgba(24,23,21,.6)' },
  coverHint: { marginTop: 6, fontSize: 13, color: 'rgba(24,23,21,.4)' },

  top: { position: 'absolute', left: 0, right: 0, top: 0, alignItems: 'center' },
  topPill: {
    flexDirection: 'row', gap: 18, height: 42, paddingHorizontal: 20, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,.78)', alignItems: 'center',
  },
  topTab: { fontSize: 16, fontWeight: '600', color: '#72706a' },
  topTabOn: { color: '#181715', fontWeight: '700' },

  rail: { position: 'absolute', right: 12, alignItems: 'center', gap: 16 },
  railAvatar: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: '#fbf3e0',
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff',
  },
  railAvatarText: { fontSize: 18, fontWeight: '700', color: '#181715' },
  railBtn: { alignItems: 'center', gap: 2 },
  railLabel: { fontSize: 13, fontWeight: '600', color: '#fff' },

  info: {
    position: 'absolute', left: 16, maxWidth: '62%', gap: 2,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16,
    backgroundColor: 'rgba(24,23,21,.46)',
  },
  infoName: { fontSize: 15, fontWeight: '700', color: '#fff' },
  infoBy: { fontSize: 13, color: 'rgba(255,255,255,.8)' },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(24,23,21,.4)' },
  sheet: {
    height: '72%', backgroundColor: '#f3f1ec',
    borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 18,
  },
  sheetTabs: { flexDirection: 'row', paddingTop: 16 },
  sheetTab: { flex: 1, alignItems: 'center', gap: 10 },
  sheetTabText: { fontSize: 18, fontWeight: '600', color: '#72706a' },
  sheetTabTextOn: { color: '#181715', fontWeight: '800' },
  sheetTabBar: { width: 40, height: 4, borderRadius: 4, backgroundColor: 'transparent' },
  sheetTabBarOn: { backgroundColor: '#ee5c2a' },
  sheetLabel: { fontSize: 13, color: '#72706a', paddingTop: 14 },

  dim: { fontSize: 14, lineHeight: 22, color: '#72706a', paddingVertical: 12 },

  comment: { flexDirection: 'row', gap: 10 },
  commentAvatar: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
  },
  commentAvatarText: { fontSize: 15, fontWeight: '700', color: '#181715' },
  commentWho: { fontSize: 13, color: '#72706a' },
  commentBody: { fontSize: 15, lineHeight: 22, color: '#181715' },

  composer: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 50,
    paddingLeft: 16, paddingRight: 6, borderRadius: 25, backgroundColor: '#fff',
  },
  composerInput: { flex: 1, fontSize: 15, color: '#181715' },
  composerSend: { height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: '#ee5c2a', justifyContent: 'center' },
  composerSendText: { fontSize: 14, fontWeight: '700', color: '#fff' },

  promptBox: { maxHeight: 220, padding: 16, borderRadius: 20, backgroundColor: '#fff' },
  promptText: { fontSize: 15, lineHeight: 24, color: '#181715' },

  secondary: {
    height: 52, borderRadius: 26, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  secondaryText: { fontSize: 16, fontWeight: '700', color: '#181715' },
  cta: { height: 58, borderRadius: 29, backgroundColor: '#ee5c2a', alignItems: 'center', justifyContent: 'center' },
  ctaText: { fontSize: 17, fontWeight: '700', color: '#fff' },
  ctaHint: { paddingTop: 10, textAlign: 'center', fontSize: 13, color: '#72706a' },
});
