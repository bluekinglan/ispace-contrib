import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BrandMark, Icon } from './Icon';

/**
 * 壳自己的底部导航（移动端 v2 稿 · isp-tabbar）。
 *
 * ┌─ 和改版前的差别 ──────────────────────────────────────────────────┐
 * │ 旧：贴着屏幕底边的一整条，四格平分——首页 / 我的作品 / 创意集市 / 我 │
 * │ 新：浮在内容之上的两块。左边一颗圆钮是**助手**，右边一粒胶囊装四格： │
 * │     探索 / 社区 / 消息 / 我。                                       │
 * │                                                                    │
 * │ 助手从「一层」变回「一个地方」：旧注释说"它不是地方、是动作，所以   │
 * │ 从我的作品进去"。移动端 v2 推翻了这个判断——新稿的首屏是刷别人的    │
 * │ 页面，而"我要做一个"不再有别的入口可挂，它必须自己占一个位置。      │
 * │ 圆钮而不是第五格：它是唯一会**开始一件事**的按钮，其余四格只是去    │
 * │ 某处看看。                                                         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 浮着而不是贴底：探索那一屏是整屏铺满的页面封面，底下压一条白条等于把
 * 一张竖图裁掉一截。
 *
 * 与页面包 app.json 里的 tabBar 仍是两回事：那个是页面**内部**的分区，
 * 由做页面的人决定；这里是平台**固定**的去处，任何人任何页面都一样。
 */

export type ShellTab = 'assistant' | 'explore' | 'community' | 'msg' | 'me';

const ON = '#ee5c2a';
const OFF = '#292724';
/** isp-tabbar 稿上的那两层：一层下沉的软影，一圈 1px 的描边。 */
const SHADOW = '0 10px 26px -12px rgba(24,23,21,.35), 0 0 0 1px rgba(24,23,21,.05)';

export function ShellTabs({
  active, onChange, avatarLetter, pageUpdate, onApplyPageUpdate, onDismissPageUpdate,
  shellUpdate, unread, dark = false,
}: {
  /** null：哪一格都不亮——比如首页是用户自己设的那个页面时，它不属于任何一格。 */
  active: ShellTab | null;
  onChange: (t: ShellTab) => void;
  /** 「我」那一格是头像而不是图标——稿上如此，它是四格里唯一代表「人」的。 */
  avatarLetter: string;
  /**
   * 页面包有新版。做成通栏横幅、就地更新——它只有几 MB，一点就好，
   * 改的又正是用户此刻在看的东西，值得一个一步可达的入口。
   */
  pageUpdate?: boolean;
  onApplyPageUpdate?: () => void;
  onDismissPageUpdate?: () => void;
  /**
   * 壳有新版。只在「我」那一格挂个点，不出横幅——91 MB、要走系统装机、
   * 还得用户确认，不紧急。打扰程度要跟代价匹配。
   */
  shellUpdate?: boolean;
  /** 消息那一格的小红点：有待接受的分享。 */
  unread?: boolean;
  /** 深色屏（探索）上浮着时，胶囊自己仍是白的，只有横幅要避开。 */
  dark?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.wrap, { paddingBottom: (insets.bottom || 10) + 12 }]} pointerEvents="box-none">
      {pageUpdate && onApplyPageUpdate && (
        <Pressable style={[s.banner, dark && s.bannerDark]} onPress={onApplyPageUpdate}>
          <View style={s.bannerDot} />
          <Text style={s.bannerText}>你的应用有新版</Text>
          <Text style={s.bannerAction}>立即更新</Text>
          <Pressable
            hitSlop={12}
            onPress={onDismissPageUpdate}
            accessibilityLabel="收起更新提示"
            style={s.bannerClose}
          >
            <Text style={s.bannerCloseText}>✕</Text>
          </Pressable>
        </Pressable>
      )}

      <View style={s.row}>
        <Pressable
          onPress={() => onChange('assistant')}
          accessibilityRole="button"
          accessibilityLabel="助手"
          style={[s.round, active === 'assistant' && s.roundOn]}
        >
          <BrandMark size={30} />
        </Pressable>

        <View style={s.pill}>
          <Tab label="探索" on={active === 'explore'} onPress={() => onChange('explore')}>
            <Icon name="compass" size={24} strokeWidth={1.9} color={active === 'explore' ? ON : OFF} />
          </Tab>
          <Tab label="社区" on={active === 'community'} onPress={() => onChange('community')}>
            <Icon name="users" size={24} strokeWidth={1.9} color={active === 'community' ? ON : OFF} />
          </Tab>
          <Tab label="消息" on={active === 'msg'} onPress={() => onChange('msg')} dot={unread}>
            <Icon name="msg" size={24} strokeWidth={1.9} color={active === 'msg' ? ON : OFF} />
          </Tab>
          <Tab label="我" on={active === 'me'} onPress={() => onChange('me')} dot={shellUpdate}>
            <View style={[s.avatar, active === 'me' && s.avatarOn]}>
              <Text style={s.avatarText}>{avatarLetter}</Text>
            </View>
          </Tab>
        </View>
      </View>
    </View>
  );
}

function Tab({
  label, on, onPress, children, dot,
}: {
  label: string; on: boolean; onPress: () => void;
  children: React.ReactNode;
  /** 「有事但不急」的通用语言：一个点，不占布局、不说话。 */
  dot?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[s.tab, on && s.tabOn]}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
    >
      <View>
        {children}
        {dot && <View style={s.tabDot} />}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  /*
    阴影用 boxShadow（稿上的原值），不用 elevation。安卓的 elevation 阴影按
    视图的轮廓算，这颗圆钮在荣耀机上被算成了方的——圆钮背后浮着一块方形
    灰影。boxShadow 跟着圆角走，两边也终于是同一个值。
  */
  round: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    boxShadow: SHADOW,
  },
  roundOn: { borderWidth: 2, borderColor: ON },
  pill: {
    flex: 1, height: 60, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 5, borderRadius: 30, backgroundColor: '#fff',
    boxShadow: SHADOW,
  },
  tab: { flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: '#f3f1ec' },
  tabDot: {
    position: 'absolute', top: -1, right: -3,
    width: 8, height: 8, borderRadius: 4, backgroundColor: ON,
    borderWidth: 1.5, borderColor: '#fff',
  },
  avatar: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 0 0 1px rgba(24,23,21,.08)',
  },
  avatarOn: { boxShadow: `0 0 0 2px ${ON}` },
  avatarText: { fontSize: 14, fontWeight: '700', color: '#181715' },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10,
    height: 40, paddingHorizontal: 16, borderRadius: 20, backgroundColor: ON,
  },
  bannerDark: { backgroundColor: '#ee5c2a' },
  bannerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  bannerText: { flex: 1, color: '#fff', fontSize: 13 },
  bannerAction: { color: '#fff', fontSize: 13, fontWeight: '700' },
  bannerClose: { paddingLeft: 10 },
  bannerCloseText: { color: 'rgba(255,255,255,.85)', fontSize: 13 },
});
