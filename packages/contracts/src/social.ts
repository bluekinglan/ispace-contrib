import { z } from 'zod';
import { API_BASE } from './api.js';

/**
 * 改版稿新增的社交面：喜欢、评论、关注、动态、兴趣。
 *
 * 这些都不是「页面托管」这件事的一部分，但改版稿把它们放进了主路径——
 * 探索墙的卡片带喜欢数，详情页右侧一整条评论流，作者页有关注，移动端
 * 多了社区和首登「选方向」。单独一个文件，是为了让「平台」与「社区」
 * 在契约层也分得开：以后要砍掉社区，删这一个文件加它的路由即可。
 */

// ── 探索分类 ────────────────────────────────────────────────────────────
/**
 * 探索页顶部的分类条（改版稿 §探索）。
 *
 * 第一颗「为你推荐」不是分类，是「不筛」——设计稿里它和其余几颗长一样，
 * 但点下去显示的是全部。放进同一个数组里是为了让前端直接 map 出这一行，
 * 判断「是不是不筛」用下面的 EXPLORE_ALL 比较，不要写死下标 0。
 */
export const EXPLORE_ALL = '为你推荐';
/** 真正的分类（可筛的那七颗），也是移动端「选方向」的取值。 */
export const EXPLORE_BUCKETS = [
  '工作提效', '数据看板', '团队协作', '生活', '学习', '小游戏', '1024 作品',
] as const;
export const EXPLORE_CATEGORIES = [EXPLORE_ALL, ...EXPLORE_BUCKETS] as const;
export type ExploreCategory = (typeof EXPLORE_CATEGORIES)[number];

/**
 * 把 apps.category 里的自由文本归到探索分类上。
 *
 * apps.category 一直是自由文本（AI 发布时自己起名，见 entities.ts 的
 * marketplaceCategorySchema），库里已经攒了「效率工具」「办公提效」
 * 「表单问卷」这些旧值。改版稿换了一套分类名，如果让分类条按新名字精确
 * 匹配，所有既有页面会在一夜之间从每一个分类下消失——只有「全部」还能
 * 看到它们。
 *
 * 所以匹配放宽成一张映射表：旧值落到语义最近的新桶，认不出来的落到
 * 「工作提效」而不是凭空多出一个分类——探索页的分类条是固定八颗，
 * 多出来的桶没有任何入口能点到，等于那些页面被藏了。
 */
type Bucket = (typeof EXPLORE_BUCKETS)[number];

const BUCKETS: Record<string, Bucket> = {
  工作提效: '工作提效', 效率工具: '工作提效', 办公提效: '工作提效', 其他: '工作提效',
  数据看板: '数据看板', 表单问卷: '数据看板',
  团队协作: '团队协作',
  生活: '生活', 生活服务: '生活', 旅行攻略: '生活',
  学习: '学习',
  小游戏: '小游戏', 游戏娱乐: '小游戏',
  '1024 作品': '1024 作品', '1024作品': '1024 作品',
  官网展示: '工作提效',
};

export function exploreBucket(category: string | null | undefined): Bucket {
  if (!category) return '工作提效';
  return BUCKETS[category.trim()] ?? '工作提效';
}

// ── 兴趣（移动端「选方向」）─────────────────────────────────────────────
/**
 * 首次登录选的方向，用来给推荐排序加权。
 *
 * 取值就是探索分类（去掉「为你推荐」）：两处用同一套词，用户选的「工作
 * 提效」和探索页那颗「工作提效」才是同一个东西。设计稿写「选 1-3 个」，
 * 上限落在契约里；下限是 0——「跳过」是设计稿右上角给的正当选项。
 */
export const interestSchema = z.enum(EXPLORE_BUCKETS);
export type Interest = z.infer<typeof interestSchema>;
export const interestsInputSchema = z.object({
  interests: z.array(interestSchema).max(3),
});

// ── 评论 ────────────────────────────────────────────────────────────────
export const commentBodySchema = z.string().trim().min(1).max(500);
export const commentInputSchema = z.object({ body: commentBodySchema });

export const commentSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  createdAt: z.string(),
  author: z.object({
    username: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  /** 自己写的那几条，前端给一个删除入口。 */
  mine: z.boolean(),
});
export type Comment = z.infer<typeof commentSchema>;

// ── 动态（社区）─────────────────────────────────────────────────────────
export const postBodySchema = z.string().trim().min(1).max(2000);
export const postInputSchema = z.object({
  body: postBodySchema,
  /** 附一个自己的页面，就是动态下方那张「去试试」卡。 */
  appId: z.string().uuid().optional(),
});

export const postSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  createdAt: z.string(),
  likeCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  liked: z.boolean(),
  mine: z.boolean(),
  author: z.object({
    username: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  /** 附的页面被作者删了就是 null——正文还在，卡片不显示。 */
  app: z
    .object({
      id: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      iconLetter: z.string(),
      coverUrl: z.string().nullable(),
      owner: z.string(),
    })
    .nullable(),
});
export type Post = z.infer<typeof postSchema>;

/** 社区两个 tab：推荐（全公司）与关注（只看我关注的人）。 */
export const postFeedSchema = z.enum(['recommend', 'following']);
export type PostFeed = z.infer<typeof postFeedSchema>;

// ── 作者主页 ────────────────────────────────────────────────────────────
/** 改版稿「作者主页」顶部那一行数字，加上移动端「我」页的关注/粉丝。 */
export const authorProfileSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  /** 设计稿显示在名字下面那行「运营中心」。库里没有部门字段时为 null。 */
  department: z.string().nullable(),
  self: z.boolean(),
  following: z.boolean(),
  stats: z.object({
    publicApps: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    visits: z.number().int().nonnegative(),
    followers: z.number().int().nonnegative(),
    followees: z.number().int().nonnegative(),
    posts: z.number().int().nonnegative(),
  }),
});
export type AuthorProfile = z.infer<typeof authorProfileSchema>;

export const SOCIAL_ROUTES = {
  like: (appId: string) => `${API_BASE}/apps/${appId}/like`,
  comments: (appId: string) => `${API_BASE}/apps/${appId}/comments`,
  comment: (id: string) => `${API_BASE}/comments/${id}`,
  author: (username: string) => `${API_BASE}/authors/${username}`,
  follow: (username: string) => `${API_BASE}/authors/${username}/follow`,
  posts: `${API_BASE}/posts`,
  post: (id: string) => `${API_BASE}/posts/${id}`,
  postLike: (id: string) => `${API_BASE}/posts/${id}/like`,
  postComments: (id: string) => `${API_BASE}/posts/${id}/comments`,
  interests: `${API_BASE}/me/interests`,
} as const;
