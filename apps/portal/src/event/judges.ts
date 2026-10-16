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
}

export const EVENT_JUDGES: EventJudge[] = [
  { name: '和其正', key: 'hqz' },
  { name: '莫问', key: 'mowen' },
  { name: '包黑子', key: 'baoheizi' },
  { name: '凯撒', key: 'kaisa' },
  { name: '青岚', key: 'qinglan' },
  { name: '超品', key: 'chaopin' },
  { name: '春树', key: 'chunshu' },
  { name: '克隆', key: 'kelong' },
];

/** 头像地址。图挂了的话调用方自己退回文字头像。 */
export function judgeAvatar(key: string): string {
  return `/event-judge-${key}.jpg`;
}
