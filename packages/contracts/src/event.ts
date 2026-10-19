import { z } from 'zod';

/**
 * 1024 程序员节的赛事契约。
 *
 * 一句话概括这件事的形状：**一个人交一个创意 → 评委初筛出八个 → 入围者交
 * 作品 → 现场路演，评委打分 + 全员投票 → 按汇总排名颁奖**。下面的类型就是
 * 这条链上每一环的数据。
 *
 * 文案与参数（规则、奖项、评分维度、日程、各截止时间）全在 `EventConfig`
 * 里，落库为 events.config 的 jsonb。它们一年改一次、只被活动页读，
 * 拆成表只会让「改个奖金数额」变成一次数据库迁移。
 */

/** 当届的 slug。/1024 这个路径解析到它——印在横幅和海报上的是 1024，不是年份。 */
export const CURRENT_EVENT_SLUG = '1024-2026';

/** 活动页的公开路径。与 RESERVED_PATHS 的 '1024' 是同一个东西。 */
export const EVENT_PATH = '/1024';

// ── 阶段 ──────────────────────────────────────────────────────────────
/**
 * 阶段决定活动页显示什么、哪个按钮能按。
 *
 * 顺序即时间顺序，`PHASE_ORDER` 让「至少到了某个阶段」可以直接比大小，
 * 省掉散落各处的 `phase === 'demo' || phase === 'result'`。
 */
export const EVENT_PHASES = [
  'signup',     // 报名中：可交创意
  'screening',  // 评委初筛：创意已截止，等入围名单
  'building',   // 入围制作：入围者交作品
  'demo',       // 展示答辩：现场路演，可投票
  'result',     // 结果公布：获奖名单
  'ended',      // 已结束：页面下线，横幅不再出现
] as const;
export type EventPhase = (typeof EVENT_PHASES)[number];

export const eventPhaseSchema = z.enum(EVENT_PHASES);

const PHASE_INDEX: Record<EventPhase, number> = {
  signup: 0, screening: 1, building: 2, demo: 3, result: 4, ended: 5,
};

/** `at` 是否已到达 `least` 这个阶段。 */
export function phaseAtLeast(at: EventPhase, least: EventPhase): boolean {
  return PHASE_INDEX[at] >= PHASE_INDEX[least];
}

/**
 * 评委这一侧是否已经翻到「打分」那一页。
 *
 * 初筛投票（deadlines.screeningVote）比阶段切换（deadlines.screening，公布
 * 入围）早半小时封票，这半小时里阶段还是 screening，但票已经投不动了、入围
 * 名单也已经自动定下——评委该看的是入围作品，不是一页投不了的票。
 *
 * `now` 用服务端随 EventSummary 带回的时刻，理由同 derivePhase。
 */
export function judgeOnScoring(ev: {
  phase: EventPhase;
  now: string;
  config: { deadlines?: { screeningVote?: string } };
}): boolean {
  if (phaseAtLeast(ev.phase, 'building')) return true;
  if (ev.phase !== 'screening') return false;
  const shut = ev.config.deadlines?.screeningVote;
  return !!shut && Date.parse(ev.now) >= Date.parse(shut);
}

/**
 * 按 `config.deadlines` 推导当前阶段。人工覆盖（events.phase）在服务端优先，
 * 这里只负责「时钟说现在是哪一阶段」。
 *
 * 为什么放在契约里：服务端用它决定「现在能不能交创意」，控制台的赛事管理屏
 * 用它回答「把阶段交还给时钟会落回哪一阶段」。两边各算一遍迟早会算得不一样，
 * 而那时组织者会照屏上写的去撤掉覆盖，然后发现落到了别的阶段。
 *
 * 判断依然只在服务端生效——客户端时钟不可信。控制台传进来的 `now` 是服务端
 * 随 EventSummary 带回的那个时刻，不是浏览器本地时间。
 */
export function derivePhase(
  deadlines: EventConfig['deadlines'] | undefined,
  now: Date,
): EventPhase {
  if (!deadlines) return 'signup';
  const t = now.getTime();
  if (t < Date.parse(deadlines.idea)) return 'signup';
  if (t < Date.parse(deadlines.screening)) return 'screening';
  if (t < Date.parse(deadlines.work)) return 'building';
  if (t < Date.parse(deadlines.award)) return 'demo';
  if (t < Date.parse(deadlines.end)) return 'result';
  return 'ended';
}

// ── config ────────────────────────────────────────────────────────────

/** 一条参赛须知。`n` 是设计稿上那个 0x 编号，由前端按序号生成，不落库。 */
export interface EventHowStep {
  /** lucide 图标名，与 UI 的 Icon 组件对齐 */
  icon: string;
  title: string;
  /** 「10.16 – 10.19」这样的人读日期，与 deadlines 的机器时间分开 */
  date: string;
  desc: string;
}

export interface EventPrize {
  name: string;
  count: string;
  money: string;
  how: string;
  /** 卡片配色档位。设计稿里一等奖是橙底、人气奖是深底，其余白底。 */
  tone: 'brand' | 'dark' | 'subtle' | 'plain';
}

/**
 * 初筛看什么。给的是「评委凭什么挑」，没有分值——初筛是八位评委投票
 * 选出入围名单，不是打分。所以不能混进 criteria：那一组的 max 之和
 * 必须是 100，服务端按它校验评委打分。
 */
export interface EventScreeningPoint {
  key: string;
  desc: string;
}

/** 评分维度。`max` 之和必须是 100——服务端在写分时据此校验。 */
export interface EventCriterion {
  key: string;
  desc: string;
  max: number;
}

export interface EventScheduleRow {
  time: string;
  icon: string;
  title: string;
  desc: string;
}

export interface EventScheduleBlock {
  label: string;
  time: string;
  rows: EventScheduleRow[];
}

/**
 * 奖项的评定规则——**怎么算出获奖者**，与 `prizes`（怎么展示奖项列表）分开。
 *
 * by='judge' 按评委平均分名次，by='votes' 按得票数名次，by='finalist' 是
 * 入围即得。rank 从 1 起；by='finalist' 时忽略 rank。
 */
export interface EventAwardRule {
  key: string;
  name: string;
  money: string;
  by: 'judge' | 'votes' | 'finalist';
  rank: number;
  /**
   * 与已评出的奖项互斥：算这个奖时跳过已经拿过奖的作品。
   *
   * 本届最佳人气奖就是这样——「与一二三等奖互斥」。没有它的话，票王同时
   * 是评委第一名时会一个人抱走两个奖，而规则写明不行。
   *
   * 按 awardRules 的**声明顺序**结算，所以互斥的奖项要排在它要避开的那些
   * 之后（finalist 不占名次，不参与互斥）。
   */
  exclusive?: boolean;
}

export interface EventConfig {
  /** 灵感上线・AI 不设限 */
  tagline: string;
  /** 10.23 周五 10:00 – 17:00 */
  dateLabel: string;
  /** 活动有问题找谁 */
  contact: string;
  /**
   * 头图里那段话：一句说清整个赛程。缺省时头图不显示这一段。
   *
   * 和 tagline 分开：tagline 是口号（「灵感上线・AI 不设限」），这一段是
   * 说明。转发到群里的人多半只看头图，光一句口号说不清这事要怎么参加。
   */
  intro?: string;
  /**
   * 各阶段的切换时刻（ISO）。events.phase 为空时由它推导当前阶段，
   * 也用于「还有几天截止」的倒数和「截止前可以改」的判断。
   *
   * 判断是**服务端**做的（routes/events.ts）：客户端时钟不可信，
   * 把 10.19 12:00 的截止交给浏览器本地时间等于没有截止。
   */
  deadlines: {
    /** 交创意截止 */
    idea: string;
    /**
     * 初筛投票截止。票在这一刻封存，但名单还没公布。
     *
     * 这一刻入围名单自动定下（前 8，第 8 名同票扩到 9 个，见服务端
     * jobs/event-finalists.ts）。和 `screening` 分开，是给组织者留出名单
     * 定下到对外公布之间那半小时：核对、调路演顺序，以及手动处理扩到
     * 9 个都装不下的同票。挤在同一个时刻就没有这个余地。
     *
     * 可选：往届没有这一项，缺了就退回用 `screening`（投票一直开到公布）。
     */
    screeningVote?: string;
    /** 入围名单公布 */
    screening: string;
    /** 交作品截止 */
    work: string;
    /**
     * 人气奖投票开放。
     *
     * 本届它落在**交作品截止之前**（10.22 18:00，而作品 10.23 00:00 截止），
     * 所以投票窗口横跨 building 与 demo 两个阶段——不能再用「阶段等于 demo」
     * 来判断能不能投，只能看时刻。
     */
    voteOpen: string;
    /** 人气奖投票截止 */
    vote: string;
    /**
     * 评委打分锁定。
     *
     * 与 `vote` 分开，因为本届两者不是同一时刻：投票 12:00 截止，而评委
     * 打分 11:55 就锁（上午场到 11:55 结束）。合用一个字段的话，改其中一个
     * 一定会悄悄改掉另一个。
     */
    judgeLock: string;
    /** 颁奖（结果公布） */
    award: string;
    /** 活动整体结束，页面与横幅下线 */
    end: string;
  };
  /** 每人几票（人气奖）。本届 2 票。 */
  voteLimit: number;
  /**
   * 初筛时每位评委有几票。本届 8。
   *
   * 和 voteLimit 分开：那个是人气奖，全员每人 2 票投作品；这个是评委挑
   * 该入围的创意。两个数字没有关系，合成一个迟早会有人改错一边。
   * 缺省时评委页不显示初筛投票。
   */
  screeningVoteLimit?: number;
  /**
   * 可以提前进颁奖大屏的人（用户名）。管理员不用列，默认就可以。
   *
   * 获奖名单对外要到 deadlines.award（15:10 颁奖）才公布，可分数 11:55 就
   * 锁定了。中间这三个多小时组织者得能把颁奖大屏挂上、从背景墙走一遍——
   * 拿不到名单的话，颁奖页整页停在「获奖名单还没出来」，连背景墙都进不去。
   *
   * 放开的时刻是打分锁定和人气投票截止**都过了**之后：本届人气票 12:00
   * 才截止，比打分锁定晚 5 分钟，早放的话人气奖还会变。
   */
  awardPreview?: string[];
  /**
   * 初筛入围几个。
   *
   * 和 screeningVoteLimit 恰好都是 8，但两者没有关系：一个是每位评委手里
   * 的票数，一个是名额数。合用一个数字的话，哪天想把票数调成 10 就会连带
   * 把名额也改了。
   */
  screeningSlots?: number;
  /**
   * 「奖项与评选」小节末尾那段说明：名次怎么定、人气奖怎么投、有没有互斥。
   *
   * 落在 config 而不是写死在页面里：它逐字描述赛制，而赛制这一届就改过
   * 一次（投票从现场扫码改成全员线上）。写死就意味着改规则要改代码。
   */
  judgingNote?: string;
  rules: string[];
  how: EventHowStep[];
  prizes: EventPrize[];
  criteria: EventCriterion[];
  /** 初筛看什么。缺省时活动页不显示这一栏。 */
  screening?: EventScreeningPoint[];
  /** 初筛那栏末尾的一句说明（几位评委、选几个）。理由同 judgingNote。 */
  screeningNote?: string;
  schedule: EventScheduleBlock[];
  awardRules: EventAwardRule[];
}

// ── 响应 ──────────────────────────────────────────────────────────────

export interface EventSummary {
  slug: string;
  title: string;
  subtitle: string | null;
  edition: string | null;
  venue: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** 已解析的当前阶段：人工覆盖优先，否则按 deadlines 推导 */
  phase: EventPhase;
  /** 该阶段是否由人工钉死。给管理员看，普通用户不关心。 */
  phasePinned: boolean;
  /**
   * 人气奖投票此刻开不开。
   *
   * 由服务端按 deadlines.voteOpen / vote 算好给前端，**不要在客户端重算**：
   * 这不只是时钟不可信的问题——投票窗口横跨 building 与 demo 两个阶段，
   * 「阶段等于 demo」这种就近判断会在 10.22 晚上把投票整段挡掉。
   */
  votingOpen: boolean;
  /** 评委打分是否已锁定（11:55 之后，或已到结果公布）。 */
  judgingLocked: boolean;
  config: EventConfig;
  /** 服务端此刻的时间。前端的倒数以它为基准，不信本机时钟。 */
  now: string;
}

export interface EventJudgeInfo {
  username: string;
  displayName: string;
}

export interface EventStats {
  ideaCount: number;
  finalistCount: number;
  workCount: number;
  voteTotal: number;
  /** 已提交打分的评委数 / 评委总数。活动当天给主持人和评委看进度。 */
  judgeCount: number;
}

/**
 * 入围作品的公开视图。
 *
 * 初筛结束前**不返回任何创意**（规则：「初筛结束前，创意只有评委能看到」），
 * 所以这个列表在 signup/screening 阶段是空的。
 */
export interface EventFinalist {
  ideaId: string;
  /** 入围编号，也是路演顺序。NO.04 里的 04。 */
  no: string;
  name: string;
  desc: string;
  /** 作者展示名 */
  who: string;
  ownerUsername: string;
  /** 'page' 的作品可以点开看；'other' 是硬件，只有照片 */
  kind: 'page' | 'other' | null;
  /** kind='page' 时的公开地址 */
  url: string | null;
  /** 已交作品 / 制作中 */
  submitted: boolean;
  /** 得票数。只在 demo 之后返回——投票期间实时票数会影响投票行为。 */
  votes: number | null;
}

export interface EventAward {
  key: string;
  name: string;
  money: string;
  no: string;
  ideaName: string;
  who: string;
  url: string | null;
  /** 评委平均分，一位小数。by='votes' 的奖项为 null。 */
  judgeScore: number | null;
  votes: number;
  /** 评委留的一句话评语，取已提交评语中的一条 */
  comment: string | null;
  /** 作品一句话介绍。颁奖大屏上揭晓后显示在名字下面。 */
  desc: string;
  /**
   * 各维度的评委平均分，顺序与 config.criteria 一致，一位小数。
   * 颁奖大屏画那四条分项柱用它。无人打分时为 null。
   */
  dims: number[] | null;
}

/** 登录者自己的状态。未登录时整块为 null——页面照常显示，只是不知道「我」。 */
export interface EventMe {
  username: string;
  displayName: string;
  idea: {
    id: string;
    name: string;
    problem: string;
    plan: string;
    form: string;
    files: EventFile[];
    finalist: boolean;
    no: string | null;
  } | null;
  work: {
    id: string;
    kind: 'page' | 'other';
    name: string;
    pitch: string | null;
    appSlug: string | null;
    appVersion: number | null;
    files: EventFile[];
  } | null
  /** 我投过票的 ideaId */
  votes: string[];
  isJudge: boolean;
  isAdmin: boolean;
}

export interface EventFile {
  name: string;
  size: number;
  url: string;
}

export interface EventResponse {
  event: EventSummary;
  judges: EventJudgeInfo[];
  stats: EventStats;
  finalists: EventFinalist[];
  awards: EventAward[] | null;
  me: EventMe | null;
}

// ── 管理员视图 ────────────────────────────────────────────────────────

/**
 * 一条创意在组织者眼里的样子。
 *
 * 比公开的 `EventFinalist` 多了 `problem`（想解决什么问题）与附件：初筛那天
 * 八个评委围着一块屏看的就是这些，少一样都得回去翻库。
 */
export interface EventAdminIdea {
  id: string;
  name: string;
  problem: string;
  plan: string;
  form: string;
  files: EventFile[];
  /** 作者展示名 */
  who: string;
  username: string;
  finalist: boolean;
  /** 入围编号 = 路演顺序。没入围是 null。 */
  no: string | null;
  /** 已交作品 */
  submitted: boolean;
  createdAt: string;
}

/**
 * 本届全部创意。
 *
 * 公开接口在初筛结束前刻意一个创意都不返回（规则：初筛前创意只有评委和作者
 * 能看到），而定入围名单的人恰恰要在那之前看全部——所以单开一条管理员接口，
 * 而不是给公开接口加个开关。
 */
export interface EventIdeasResponse {
  ideas: EventAdminIdea[];
}

// ── 评委视图 ──────────────────────────────────────────────────────────

/**
 * 评委打分页的数据。
 *
 * 刻意**不包含别人的分数**：设计稿上那句「评委之间互相看不到分数」是
 * 规则，不是界面措辞。因此这里只给自己的分，加上一个「其他评委几人已提交」
 * 的计数——计数不泄露任何一个人的判断。
 */
export interface EventJudgeItem {
  ideaId: string;
  no: string;
  name: string;
  who: string;
  desc: string;
  kind: 'page' | 'other' | null;
  url: string | null;
  /** 我给它打的分；没打过是 null */
  mine: { dims: (number | null)[]; total: number; note: string; submitted: boolean } | null;
  /** 其他评委已提交的人数（不含我）。只是个数，看不出谁打了多少。 */
  othersSubmitted: number;
}

export interface EventJudgeResponse {
  event: EventSummary;
  criteria: EventCriterion[];
  /** 评委总数 - 1，即「其他评委」的分母 */
  otherJudges: number;
  /**
   * 现在不能打分。
   *
   * 两种原因都算：路演还没开始（入围制作期），或者已经过了 judgeLock。
   * 原先只表示后者，于是评委在路演前四天就能把分打完——而赛制写的是
   * 「现场打分」。具体是哪一种看 lockReason。
   */
  locked: boolean;
  /** locked 为真时说明原因，直接显示给评委。不锁时为 null。 */
  lockReason: string | null;
  items: EventJudgeItem[];
}

/**
 * 初筛投票页给评委看的一条创意。
 *
 * 不带任何别人的票数：评委之间互相看不到投给了谁，和打分一致。看得到
 * 彼此的选择，先投的人就会影响后投的人——而初筛要的恰恰是八个独立判断。
 */
export interface EventScreeningItem {
  ideaId: string;
  name: string;
  problem: string;
  plan: string;
  form: string;
  files: EventFile[];
  who: string;
  /** 这条是不是我自己交的。自己的创意不能投。 */
  mine: boolean;
  /** 我投过它没有 */
  voted: boolean;
}

/** 初筛结果榜上的一行。14:30 公布后才有。 */
export interface EventScreeningRankRow {
  ideaId: string;
  name: string;
  who: string;
  /** 8 位评委加起来的票数 */
  votes: number;
  /**
   * 入围、并列待定、还是没进。
   *
   * 第 8 名同票时，同票的全部算 'in'，名额扩到 9 个为止。'tie' 只出现在扩到
   * 9 个还装不下的那种情况（三个人卡在第 8 名、或者全员零票）：谁进由组织
   * 者定。不自动按某种顺序切一刀——那等于让一个 ORDER BY 替人做决定。
   */
  status: 'in' | 'tie' | 'out';
  rank: number;
}

export interface EventScreeningResponse {
  event: EventSummary;
  /** 每人几票 */
  limit: number;
  /** 我已经投掉几票 */
  used: number;
  /** 入围几个 */
  slots: number;
  /**
   * 我交卷了没有。
   *
   * 交卷之后票锁住，要改得先撤回交卷——这样「已提交」才是个有意义的状态，
   * 否则交完还能随手改，那条状态就只是个标签。
   */
  submitted: boolean;
  /** 已交卷的评委数 / 评委总数。让人知道还要等谁，不暴露谁投了什么。 */
  submittedCount: number;
  judgeCount: number;
  /** 名单公布了没有。公布前 ranking 一律是 null，包括对管理员。 */
  resultsOpen: boolean;
  /** 公布后的得票榜；公布前是 null。 */
  ranking: EventScreeningRankRow[] | null;
  /**
   * 现在能不能投。
   *
   * 窗口是 screening 阶段——创意已截止、名单还没公布。之前创意还在改，
   * 对着半成品投没有意义；之后名单已经对外了，再改票也晚了。
   */
  open: boolean;
  /** 窗口没开时告诉评委为什么，以及什么时候能投 */
  closedReason: string | null;
  items: EventScreeningItem[];
}

/** 初筛得票汇总，只给管理员：定名单的依据。 */
export interface EventScreeningTallyRow {
  ideaId: string;
  name: string;
  who: string;
  votes: number;
  /** 已经被选进名单了没有 */
  finalist: boolean;
}

/** 汇总排名。评委打分的去处——这就是「分数汇总到项目上」的那张表。 */
export interface EventRankRow {
  ideaId: string;
  no: string;
  name: string;
  who: string;
  /** 评委平均分（只计已提交），一位小数 */
  judgeScore: number | null;
  /** 给出分数的评委数。不足全员时名次是暂定的。 */
  judged: number;
  votes: number;
  /** 按评委平均分的名次，1 起。无人打分时为 null。 */
  rank: number | null;
}

// ── 写入载荷 ──────────────────────────────────────────────────────────

const fileSchema = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  url: z.string().max(2000),
});

export const ideaInputSchema = z.object({
  name: z.string().trim().min(1, '创意名称要写').max(60),
  problem: z.string().trim().min(1, '想解决什么问题要写').max(2000),
  plan: z.string().trim().min(1, '打算怎么做要写').max(2000),
  form: z.string().trim().min(1).max(40).default('iSpace 页面'),
  files: z.array(fileSchema).max(5, '最多 5 个文件').default([]),
});
export type IdeaInput = z.infer<typeof ideaInputSchema>;

/**
 * 交作品。两种 kind 要求的字段不同，用 discriminatedUnion 让
 * 「页面作品没选页面」这类错在解析期就被挡住，而不是落到库的 CHECK。
 */
export const workInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page'),
    /** 平台上自己的页面 slug */
    appSlug: z.string().min(2).max(31),
    pitch: z.string().trim().max(200).optional(),
  }),
  z.object({
    kind: z.literal('other'),
    name: z.string().trim().min(1, '先写作品名称').max(60),
    pitch: z.string().trim().max(200).optional(),
    files: z.array(fileSchema).min(1, '至少一张照片或一段视频').max(9),
  }),
]);
export type WorkInput = z.infer<typeof workInputSchema>;

export const scoreInputSchema = z.object({
  /** 按 config.criteria 的顺序给分。长度必须与维度数一致。 */
  dims: z.array(z.number().int().nonnegative()),
  note: z.string().trim().max(300).optional(),
  /** true = 提交（进汇总），false = 存草稿 */
  submit: z.boolean().default(false),
});
export type ScoreInput = z.infer<typeof scoreInputSchema>;

/** 管理员：推进阶段、定入围名单、设评委。 */
export const eventAdminSchema = z.object({
  /** null = 回到按时间自动推导 */
  phase: eventPhaseSchema.nullable().optional(),
  /** 入围名单：按顺序给 ideaId，编号自动按 01、02… 生成 */
  finalists: z.array(z.string().uuid()).max(64).optional(),
  /** 评委名单：用户名 */
  judges: z.array(z.string().min(2).max(31)).max(32).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type EventAdminInput = z.infer<typeof eventAdminSchema>;
