-- 初筛投票：评委从全部创意里挑出他认为该入围的。
--
-- 设计稿里一直写着「8 位评委投票，得票最多的 8 个创意入围」，但落地时初筛
-- 是管理员在控制台手工勾选的——八个人围着屏幕讨论，由一个人代为点选。
-- 这张表把那一步变成每个评委自己投。
--
-- ┌─ 和 event_votes（最佳人气奖）是两回事 ────────────────────────────┐
-- │ 人气奖：全员投、投的是**作品**、决定一个奖项。                      │
-- │ 初筛：  只有评委投、投的是**创意**、决定谁能进下一轮。              │
-- │ 两者的投票人范围、对象、时间窗口、票数上限都不同，合成一张表之后    │
-- │ 每个查询都要带一个「哪一种」的条件，迟早有人漏掉。                  │
-- └────────────────────────────────────────────────────────────────────┘
--
-- 得票数**不自动决定**入围名单：它是给管理员的依据，最终名单仍然由控制台
-- 提交（event_ideas.finalist / finalist_no）。平票、临时弃赛、同一个人占了
-- 两个名额这类情况都需要人来判断，而把名单交给一个 ORDER BY 决定，等于让
-- 这些情况在 10.19 下午两点半自己撞上来。
CREATE TABLE IF NOT EXISTS ispace.event_screening_votes (
  event_id   uuid NOT NULL REFERENCES ispace.events(id)      ON DELETE CASCADE,
  idea_id    uuid NOT NULL REFERENCES ispace.event_ideas(id) ON DELETE CASCADE,
  judge_id   uuid NOT NULL REFERENCES ispace.users(id)       ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 一个评委对一个创意最多一票。主键就是这条规则，不靠应用层记得去查。
  PRIMARY KEY (event_id, judge_id, idea_id)
);

-- 汇总那一屏按创意数票，走这条。
CREATE INDEX IF NOT EXISTS event_screening_votes_idea_idx
  ON ispace.event_screening_votes (event_id, idea_id);

-- 本届的票数上限。和人气奖的 voteLimit 分开：那个是 2（每人挑两件作品），
-- 这个是 8（评委挑出一批该入围的），两个数字没有任何关系。
UPDATE ispace.events SET
  updated_at = now(),
  config = config || jsonb_build_object('screeningVoteLimit', 8)
WHERE slug = '1024-2026';
