/**
 * 本届评委名册。
 *
 * ┌─ 为什么写死，而不是跟控制台实时同步 ──────────────────────────────┐
 * │ 活动详情页是对外的一张「海报」：谁当评委是办活动时就定下来的事，     │
 * │ 八个人、八张脸，印在页面上。而控制台里的 `event_judges` 是**权限**： │
 * │ 谁能打开 /1024/judge 去打分。两者在正常情况下是同一批人，但它们       │
 * │ 回答的不是同一个问题。                                              │
 * │                                                                    │
 * │ 混在一起的后果很具体：管理员为了调试临时加一个人，对外页面上就多出   │
 * │ 一张脸；某个评委的账号还没开通，页面上就少一个人、写着「评委 · 7 位  │
 * │ TL」——而海报不该因为后台的临时状态而变。                            │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 所以：**这里管页面上展示什么，控制台管谁有权限打分**，各管各的。
 * 换届时改这个数组，顺带把 public/event-judge-*.jpg 换掉。
 */
export interface EventJudge {
  /** 展示名，跟设计稿一致 */
  name: string;
  /** 头像，对应 public/event-judge-<key>.jpg */
  key: string;
  /**
   * 这个花名是谁的 iSpace 账号。
   *
   * **它不授予任何权限**——能不能打分只看 `event_judges` 那张表。写在这里
   * 是因为页面印的是花名、库里存的是账号和姓名，两边原先没有任何东西能
   * 对上：想确认「海报上这八个人是不是正好就是能打分的那八个」，只能靠
   * 有人记得谁是谁。少配一个人的后果要到 10.19 当天他打不开打分页才会
   * 暴露，那时候再找人开通已经来不及了。
   */
  username: string;
}

export const EVENT_JUDGES: EventJudge[] = [
  { name: '和其正', key: 'hqz', username: 'heliu' },
  { name: '莫问', key: 'mowen', username: 'zhaowenhua' },
  { name: '包黑子', key: 'baoheizi', username: 'zhaodonghe' },
  { name: '凯撒', key: 'kaisa', username: 'shalei' },
  { name: '青岚', key: 'qinglan', username: 'zhangyulong' },
  { name: '超品', key: 'chaopin', username: 'liuchao3' },
  { name: '春树', key: 'chunshu', username: 'xubin' },
  { name: '克隆', key: 'kelong', username: 'zongkelong' },
];

/** 头像地址。图挂了的话调用方自己退回文字头像。 */
export function judgeAvatar(key: string): string {
  return `/event-judge-${key}.jpg`;
}
