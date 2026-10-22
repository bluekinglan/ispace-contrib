import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Interest } from '@ispace/contracts';
import { api } from '../api';
import { Icon, type IconName } from './Icon';

/**
 * 选方向（移动端 v2 稿 · 02）。
 *
 * 第一次登录后问一句「你常做什么」，拿来给「探索」排序。只问一次，而且
 * 右上角一直留着「跳过」——这屏挡在人和内容之间，不能把它做成必答题。
 *
 * 取值用契约里的探索分类（EXPLORE_BUCKETS），不另起一套词：用户在这儿选
 * 的「工作提效」，和探索页顶上那颗「工作提效」必须是同一个东西，否则选完
 * 的效果是看不见的。稿上少了「1024 作品」这一格——它是一次活动，不是一个
 * 长期方向。
 */
/*
  label 是给人看的那几个字，照稿写；k 才是存进账号的值。稿上写「学习成长」
  「生活福利」，契约里的分类叫「学习」「生活」——改契约等于让探索页那两颗
  分类和已经存下的选择一起对不上，所以只改显示。
*/
const OPTIONS: { k: Interest; label: string; sub: string; bg: string; icon: IconName }[] = [
  { k: '工作提效', label: '工作提效', sub: '周报、报销、审批', bg: '#557a9c', icon: 'briefcase' },
  { k: '小游戏', label: '小游戏', sub: '午休玩一把', bg: '#c96f55', icon: 'gamepad' },
  { k: '数据看板', label: '数据看板', sub: '每天看一眼的数', bg: '#7b4d63', icon: 'chart' },
  { k: '团队协作', label: '团队协作', sub: '排班、周会、交接', bg: '#7f9a86', icon: 'users' },
  { k: '学习', label: '学习成长', sub: '新人、面试、读书', bg: '#d9a842', icon: 'book' },
  { k: '生活', label: '生活福利', sub: '午饭、班车、健身', bg: '#b9787a', icon: 'coffee' },
];

const MAX = 3;

export function Interests({
  token, initial, onDone,
}: {
  token: string | null;
  initial: Interest[];
  /** 不管存没存成都往下走：这一屏不该把人卡在门口。 */
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [picked, setPicked] = useState<Interest[]>(initial);
  const [busy, setBusy] = useState(false);

  const toggle = (k: Interest) => {
    setPicked((prev) => {
      if (prev.includes(k)) return prev.filter((x) => x !== k);
      /* 满了就把最早选的挤出去，而不是让人先取消再选——那一步没有意义 */
      return prev.length >= MAX ? [...prev.slice(1), k] : [...prev, k];
    });
  };

  const save = async () => {
    setBusy(true);
    try { await api.setInterests(token, picked); } catch { /* 存不上不拦人 */ }
    onDone();
  };

  return (
    <View style={[s.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}>
      <Pressable onPress={onDone} style={s.skip} hitSlop={12}>
        <Text style={s.skipText}>跳过</Text>
      </Pressable>

      <Text style={s.title}>选你常做的事</Text>
      <Text style={s.sub}>选 1-3 个，推荐更懂你</Text>

      <View style={s.grid}>
        {OPTIONS.map((o) => {
          const on = picked.includes(o.k);
          return (
            <Pressable
              key={o.k}
              style={[s.card, on && s.cardOn]}
              onPress={() => toggle(o.k)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
            >
              <View style={[s.cardTop, { backgroundColor: o.bg }]}>
                <Icon name={o.icon} size={42} color="#fff" />
                <View style={[s.dot, on && s.dotOn]}>
                  {on && <Icon name="check" size={15} color="#fff" strokeWidth={3} />}
                </View>
              </View>
              <View style={s.cardBody}>
                <Text style={s.cardTitle}>{o.label}</Text>
                <Text style={s.cardSub}>{o.sub}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flex: 1 }} />

      <Pressable style={s.cta} onPress={() => void save()} disabled={busy}>
        <Text style={s.ctaText}>
          {picked.length === 0 ? '先不选，直接看看' : `下一步 · 已选 ${picked.length} 个`}
        </Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 20 },
  skip: { alignSelf: 'flex-end' },
  skipText: { fontSize: 16, color: '#72706a' },
  title: { paddingTop: 18, fontSize: 32, fontWeight: '900', color: '#181715', letterSpacing: -0.3 },
  sub: { paddingTop: 8, paddingBottom: 22, fontSize: 15, color: '#72706a' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: { width: '47.5%', borderRadius: 22, overflow: 'hidden', backgroundColor: '#f3f1ec' },
  // 选中是一圈外描边（稿上是 box-shadow），不占布局——用 border 的话选中那张会缩一圈
  cardOn: { boxShadow: '0 0 0 2.5px #ee5c2a' },
  cardTop: { height: 92, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute', top: 10, right: 10,
    width: 26, height: 26, borderRadius: 13, borderWidth: 2,
    borderColor: 'rgba(255,255,255,.9)', alignItems: 'center', justifyContent: 'center',
  },
  dotOn: { backgroundColor: '#ee5c2a' },
  cardBody: { padding: 14, gap: 2 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#181715' },
  cardSub: { fontSize: 13, color: '#72706a' },
  cta: {
    height: 58, borderRadius: 29, backgroundColor: '#ee5c2a',
    alignItems: 'center', justifyContent: 'center',
  },
  ctaText: { fontSize: 17, fontWeight: '700', color: '#fff' },
});
