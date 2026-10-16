/**
 * 全员抽奖的名册与奖品表。
 *
 * 名单是办活动时定下来的 84 人（花名 | 真名），与 event_judges、ispace.users
 * 都不联动——抽奖抽的是「到场的同事」，不是「系统里的账号」，两者对不上是
 * 正常的（有人没注册过 iSpace，也照样参与抽奖）。
 *
 * 甜豆是组织者，不参与抽奖，所以在 EXCLUDE 里；她也是唯一没有头像的一位。
 */

/** 不参与抽奖的人，按花名写。 */
export const LOTTERY_EXCLUDE = ['甜豆'];

/** 有照片的那些人的编号。其余用花名首字的文字头像。 */
const WITH_AVATAR = new Set([1, 2, 3, 4, 5, 10, 12, 13, 14, 15, 20, 21, 24, 25, 26, 27, 28, 29, 30, 31, 34, 35, 37, 39, 40, 42, 43, 45, 46, 48, 50, 51, 52, 55, 56, 57, 59, 61, 62, 63, 65, 66, 67, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 81, 83]);

/** 花名|真名，顺序即编号（pid 从 1 起）。 */
const RAW: string[] = [
  '甜豆|李雪鸽', '克隆|宗可龙', '凯撒|沙磊', '老三|董京华',
  '美辰|闫美辰', '小栗旬|席梦凯', '风云|王兴旺', '鹏程|李鹏程',
  '圆圆子|龙园园', '张亮|张亮亮', '入贝|于正鑫', '技安|何禹',
  '曼宝|阿曼姑丽·吐尔逊', '阿松|刘孝松', '朝露|何情', '阿坤|刘显坤',
  '春树|徐斌', '汉唐|王智超', '思行|赵晓玲', '风尘|冯钰杰',
  '冷蝉|左刚华', '浩浩|刘浩', '何其正|何柳', '纪昀|孟瑞',
  '小白菜|蔡旭胜', '葫芦娃|曾阿幸', '青橄榄|张亚珍', '千尺|刘冯松',
  '一拳|马铭', '嘉嘉|朱嘉', '小吞|马晓坤', '面团儿|柴利瑶',
  '洛萨|张帆', '果子|张超', '者贤|曹金磊', '莫问|赵文华',
  '十一|崔霄翱', '满天星|付博友', '药丸|朱迪', '紫杉|徐阳',
  '夜空|李金浩', '海棠|周伟', '贝塔|冯洋', '拌面|马浚宸',
  '锦鲤|彭胜锴', '凯伦|王凯', '超品|刘超', '玉清|张玉清',
  '果冻|高祥栋', '板凳|颜群', '派森|王国栋', '吴邪|孙亚欣',
  '大老虎|李宁', '小棠|常文霞', '橙汁|程照', '胜凯|杨胜凯',
  '养乐多|王晓帆', '范椏南|范亚楠', '楚留香|张龙', '小金牛|李贵兵',
  '小七|宋佳', '柳名扬|杨扬', '大压梨|赵怀玲', '帅帅|汪帅',
  '晶洁|郭晶洁', '李白|陆文斌', '小牛|刘琳娜', '伏心|刘妍',
  '小侯|侯益民', '木偶人|游勇杰', '烟雨冰|崔欣艳', '利利|李利',
  '家烨|赵杰鹏', '道长|邱伟龙', '花火|牛榕', '巨星|李连杰',
  '向日葵|尹揆', '青岚|张玉龙', '明桐|董飞', '包黑子|赵东贺',
  '白芷|邱云肖', '白开水|雷宗文', '阿秀|李秀丹', '恩泰|梁鹏飞',
];

export interface LotteryPerson {
  pid: number;
  /** 花名。大屏上显示的就是它 */
  nick: string;
  /** 真名。中奖时跟在花名后面，便于对人 */
  real: string;
  /** 文字头像上那个字 */
  ini: string;
  /** 照片地址，没有照片时是空串 */
  img: string;
  discBg: string;
  discFg: string;
}

/** 文字头像三色轮换，按编号取，保证同一个人每次颜色一样。 */
const TONES: [string, string][] = [['#fb923c', '#001217'], ['#fcfcf8', '#001217'], ['#3db9ce', '#001217']];

export const LOTTERY_PEOPLE: LotteryPerson[] = RAW.map((s, i) => {
  const cut = s.indexOf('|');
  const nick = s.slice(0, cut);
  const real = s.slice(cut + 1);
  const pid = i + 1;
  const pad = pid < 10 ? '0' + pid : String(pid);
  const tone = TONES[pid % 3]!;
  return {
    pid, nick, real, ini: nick.charAt(0),
    img: WITH_AVATAR.has(pid) ? '/lottery/avatar-' + pad + '.png' : '',
    discBg: tone[0], discFg: tone[1],
  };
}).filter((p) => LOTTERY_EXCLUDE.indexOf(p.nick) < 0);

export const LOTTERY_BY_PID: Record<number, LotteryPerson> =
  LOTTERY_PEOPLE.reduce<Record<number, LotteryPerson>>((m, p) => { m[p.pid] = p; return m; }, {});

export interface LotteryPrize {
  k: string;
  name: string;
  /** 压轴大奖，只在第 5 轮出现 */
  jack?: boolean;
  /** 现金类，卡片上用橙底强调 */
  cash?: boolean;
  /** 五轮各放出几份 */
  r: [number, number, number, number, number];
}

/**
 * 奖品表。前四轮共 83 份——**人人有奖**，抽过的人不再进下一轮的池子；
 * 第五轮是压轴，从全员 83 人里重新抽一个，所以它和前四轮的名额是叠加的。
 */
export const LOTTERY_PRIZES: LotteryPrize[] = [
  { k: 'p1024', name: '1024红包', jack: true, r: [0, 0, 0, 0, 1] },
  { k: 'p666', name: '666红包', cash: true, r: [1, 1, 1, 1, 0] },
  { k: 'pbank', name: '小米磁吸充电宝', r: [1, 1, 1, 1, 0] },
  { k: 'pcof', name: '山姆星巴克咖啡液', r: [1, 1, 1, 1, 0] },
  { k: 'ppil', name: '蕉下U型枕', r: [1, 1, 1, 1, 0] },
  { k: 'pnut', name: '山姆每日坚果', r: [1, 1, 1, 1, 0] },
  { k: 'pcho', name: '山姆每日黑巧', r: [1, 1, 2, 1, 0] },
  { k: 'ptea', name: '喜茶茶包4盒装', r: [2, 1, 2, 1, 0] },
  { k: 'peye', name: '蕉下睡眠眼罩', r: [2, 2, 1, 1, 0] },
  { k: 'plmp', name: '小米护眼台灯', r: [1, 2, 1, 2, 0] },
  { k: 'pblk', name: '四季毯子', r: [2, 2, 2, 2, 0] },
  { k: 'pcsh', name: '葫芦靠垫', r: [2, 2, 2, 2, 0] },
  { k: 'pcrm', name: '护手霜 ×2', r: [2, 2, 2, 2, 0] },
  { k: 'poil', name: '橄榄油', r: [2, 2, 2, 2, 0] },
  { k: 'pfm', name: '面膜 ×2', r: [2, 2, 2, 2, 0] },
];

export const LOTTERY_PRIZE_BY_K: Record<string, LotteryPrize & { i: number }> =
  LOTTERY_PRIZES.reduce<Record<string, LotteryPrize & { i: number }>>((m, p, i) => { m[p.k] = { ...p, i }; return m; }, {});

/** 轮次名。第五轮不叫「第五轮」，它是压轴。 */
export const LOTTERY_ROUND_CN = ['一', '二', '三', '四'];
export function lotteryRoundTitle(r: number): string {
  return r < 5 ? '第' + LOTTERY_ROUND_CN[r - 1] + '轮' : '压轴大奖';
}

