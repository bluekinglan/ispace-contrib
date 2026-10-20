-- 给评论点赞。
--
-- 为什么不在 0032 里一起加：那一版做的时候，评论流还只是「一列话」。对着
-- 改版稿的详情页细看才发现，每条评论下面都有一个心形和一个数字，而面板顶
-- 上的「最新 / 热门」里的热门正是按这个数排——少了它，那个开关没有东西可
-- 排，只能把它从稿上删掉。
--
-- 结构与 app_likes 一样：复合主键挡住「同一个人点两次」，计数物化在
-- app_comments 上，写入侧统一重算。一个页面下几十条评论，不物化就是
-- 几十次 count(*)。
CREATE TABLE IF NOT EXISTS ispace.app_comment_likes (
  comment_id uuid NOT NULL REFERENCES ispace.app_comments(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id)        ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

ALTER TABLE ispace.app_comments ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0;
