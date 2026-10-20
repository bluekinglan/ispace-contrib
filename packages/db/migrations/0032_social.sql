-- 新版 UI 的社交底座：喜欢、评论、关注、动态、兴趣。
--
-- 改版稿把「创意市场」改成了「探索」，卡片上多了喜欢数，详情页右侧是一整
-- 条评论流，作者页有关注数，移动端多了社区动态和首次登录的「选方向」。
-- 这些都是 UI 要求的新事实，库里原本一个都没有。
--
-- ┌─ 为什么三张「谁对什么做过一次」的表长得不一样 ─────────────────────┐
-- │ app_likes / user_follows / post_likes 都是 (主体, 客体) 的复合主键   │
-- │ ——「一个人对一个东西最多一次」是业务规则，交给主键，不靠应用层    │
-- │ 记得先 SELECT 再 INSERT（0023 的投票表同一条理由）。                │
-- │                                                                     │
-- │ 评论不一样：同一个人可以在同一个页面下写很多条，所以它有自己的 id。 │
-- └─────────────────────────────────────────────────────────────────────┘
--
-- 计数一律物化成列，跟 apps.visit_count / marketplace_listings.install_count
-- 同一套做法：探索墙一屏几十张卡，每张都带喜欢数和评论数，不物化就是
-- 一屏几十次 count(*)。写入侧统一重算（SET x = (SELECT count(*) …)）而不是
-- +1/-1，这样重复点赞、并发、手工改数据都不会把计数器带偏。

-- ── 喜欢（页面）────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.app_likes (
  app_id     uuid NOT NULL REFERENCES ispace.apps(id)  ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, user_id)
);

-- 「我喜欢过的页面」那一屏（移动端「我 · 喜欢」）按人反查，走这条。
CREATE INDEX IF NOT EXISTS app_likes_user_idx ON ispace.app_likes (user_id, created_at DESC);

-- ── 评论（页面）────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.app_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id     uuid NOT NULL REFERENCES ispace.apps(id)  ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  -- 上限跟设计稿一致（输入框右下角显示字数），库里也挡一道：
  -- 前端的 maxlength 只是提示，接口是公开的。
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_comments_app_idx
  ON ispace.app_comments (app_id, created_at DESC);

-- ── 关注（人）──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.user_follows (
  follower_id uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  -- 关注自己没有任何含义，但会让「粉丝 1」这种数字出现在新号上。
  CONSTRAINT user_follows_not_self CHECK (follower_id <> followee_id)
);

-- 粉丝数、以及社区「关注」tab 要按被关注者反查。
CREATE INDEX IF NOT EXISTS user_follows_followee_idx
  ON ispace.user_follows (followee_id);

-- ── 动态（移动端社区）──────────────────────────────────────────────────
--
-- 帖子可以附一个页面（设计稿里每条动态下方那张「去试试」的卡），也可以
-- 只是一段话。app_id 可空就是这个意思。
--
-- 附的页面被删时用 SET NULL 而不是级联删帖：帖子是人写的内容，不该因为
-- 作者下架了一个页面就消失；附卡没了，正文还在。
CREATE TABLE IF NOT EXISTS ispace.posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  body          text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  app_id        uuid REFERENCES ispace.apps(id) ON DELETE SET NULL,
  like_count    integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_feed_idx   ON ispace.posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_idx ON ispace.posts (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ispace.post_likes (
  post_id    uuid NOT NULL REFERENCES ispace.posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS ispace.post_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES ispace.posts(id)  ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_comments_post_idx
  ON ispace.post_comments (post_id, created_at DESC);

-- ── 页面上的计数列 ─────────────────────────────────────────────────────
ALTER TABLE ispace.apps ADD COLUMN IF NOT EXISTS like_count    integer NOT NULL DEFAULT 0;
ALTER TABLE ispace.apps ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0;

-- ── 兴趣（移动端「选方向」）────────────────────────────────────────────
--
-- 这次直接加在 users 上，与 0025 把头像另开一张表的判断不矛盾：当时的理由
-- 是「findUserById 走 SELECT *，每个请求都会把头像字节读出来扔掉」。兴趣是
-- 最多三个短字符串，几十字节，而且推荐排序本来就要跟着当前用户一起读出来
-- ——放在 users 上省一次 join，放在别处才是浪费。
ALTER TABLE ispace.users ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}';
