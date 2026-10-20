import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';

/**
 * 消息（移动端 v2 稿 · 底栏第三格）。
 *
 * 稿上只画了底栏那颗图标，没画这一屏的内容。这里按壳手上**真有**的几类
 * 待办来填，而不是摆一个空的收件箱：
 *
 *   · 同事分享给我的页面（要我点接受）
 *   · 页面包有新版（一点就更新）
 *   · 1024 活动（活动期间才有）
 *
 * 没有的不编：没有「谁喜欢了你的页面」这类通知，因为平台没有在产生它们
 * ——编一条出来，用户点进去会发现什么也没有。
 */
export function Messages({
  token, pageUpdate, onApplyPageUpdate, event, onOpenEvent, onWorks,
}: {
  token: string | null;
  pageUpdate: boolean;
  onApplyPageUpdate: () => void;
  /** 活动期间的一条。没有活动就不传。 */
  event?: { title: string; desc: string } | undefined;
  onOpenEvent?: (() => void) | undefined;
  /** 接受完分享之后去「我」那一栏看看——它就落在那儿。 */
  onWorks: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [shares, setShares] = useState<
    { id: string; app: { name: string }; fromUser: { displayName: string } }[]
  >([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    void api.pendingShares(token)
      .then((r) => setShares(r.shares))
      .catch(() => setShares([]))
      .finally(() => setRefreshing(false));
  }, [token]);
  useEffect(load, [load]);

  const respond = async (id: string, accept: boolean) => {
    setBusy(id);
    try {
      await api.respondShare(token, id, accept);
      setShares((prev) => prev.filter((x) => x.id !== id));
      if (accept) onWorks();
    } catch { /* 失败就留着那张卡，用户可以再点一次 */ } finally { setBusy(null); }
  };

  const empty = shares.length === 0 && !pageUpdate && !event;

  return (
    <View style={s.root}>
      <Text style={[s.title, { paddingTop: insets.top + 14 }]}>消息</Text>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 120 }}
        refreshControl={(
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#ee5c2a" />
        )}
      >
        {empty && <Text style={s.empty}>没有新消息。</Text>}

        {shares.map((sh) => (
          <View key={sh.id} style={s.card}>
            <Text style={s.cardTitle}>{sh.fromUser.displayName} 分享给你「{sh.app.name}」</Text>
            <Text style={s.cardSub}>接受后它会出现在「我 · 页面」里，用起来和你自己的页面一样。</Text>
            <View style={s.row}>
              <Pressable
                style={[s.btn, s.btnPrimary]}
                disabled={busy === sh.id}
                onPress={() => void respond(sh.id, true)}
              >
                <Text style={s.btnPrimaryText}>接受</Text>
              </Pressable>
              <Pressable style={s.btn} disabled={busy === sh.id} onPress={() => void respond(sh.id, false)}>
                <Text style={s.btnText}>拒绝</Text>
              </Pressable>
            </View>
          </View>
        ))}

        {pageUpdate && (
          <Pressable style={s.card} onPress={onApplyPageUpdate}>
            <Text style={s.cardTitle}>你的应用有新版</Text>
            <Text style={s.cardSub}>几 MB，点一下就更新好，不用去应用商店。</Text>
            <View style={s.row}>
              <View style={[s.btn, s.btnPrimary]}><Text style={s.btnPrimaryText}>立即更新</Text></View>
            </View>
          </Pressable>
        )}

        {event && (
          <Pressable style={[s.card, s.cardEvent]} onPress={onOpenEvent}>
            <Text style={s.cardTitle}>{event.title}</Text>
            <Text style={s.cardSub}>{event.desc}</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f6f4ee' },
  title: { paddingHorizontal: 18, paddingBottom: 6, fontSize: 24, fontWeight: '800', color: '#181715' },
  empty: { padding: 24, fontSize: 15, color: '#72706a', textAlign: 'center' },
  card: { padding: 16, borderRadius: 20, backgroundColor: '#fff', gap: 6 },
  cardEvent: { backgroundColor: '#fbe4da' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#181715' },
  cardSub: { fontSize: 14, lineHeight: 21, color: '#72706a' },
  row: { flexDirection: 'row', gap: 8, paddingTop: 8 },
  btn: { height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: '#f3f1ec', justifyContent: 'center' },
  btnText: { fontSize: 14, fontWeight: '700', color: '#54524e' },
  btnPrimary: { backgroundColor: '#181715' },
  btnPrimaryText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
