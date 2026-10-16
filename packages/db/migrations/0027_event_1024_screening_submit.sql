-- 初筛投票：提交这一步，以及「投票截止」与「名单公布」分家。
--
-- 编号跳过 0026：另一条线上正在写 token_epoch 的 0026，两边同时落地会撞名。
-- 迁移按文件名记账（ispace.schema_migrations），中间空一个号没有副作用。
--
-- ── 为什么要「提交」这一步 ────────────────────────────────────────────
-- 原先每点一次就写一条票，投到一半也算数。赛制要的是每位评委用满 8 票再
-- 交卷：投三票就走开，等于这个人的票权被稀释，而得票是用来排名次的，少投
-- 的人实际上降低了所有人的区分度。
--
-- 做法是票照旧实时写库（电脑和手机看到的是同一份，按时间先后覆盖），另外
-- 单记一条「交卷了」。草稿不放前端本地：放本地的话换个设备就看不到自己投
-- 到哪了，而评委在工位用电脑、去会议室用手机是常态。
CREATE TABLE IF NOT EXISTS ispace.event_screening_submits (
  event_id     uuid NOT NULL REFERENCES ispace.events(id) ON DELETE CASCADE,
  judge_id     uuid NOT NULL REFERENCES ispace.users(id)  ON DELETE CASCADE,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, judge_id)
);

-- 「其他 7 位评委里已有 5 位提交」那句要数这张表，按活动数。
CREATE INDEX IF NOT EXISTS event_screening_submits_event_idx
  ON ispace.event_screening_submits (event_id);

-- ── 投票截止与名单公布分开 ────────────────────────────────────────────
--
-- 原先两件事共用 deadlines.screening（14:30）：投票一直开到名单公布那一刻。
-- 但第 8 名同票是要由 8 位评委线下商定的，而商定得在票封存之后、名单公布
-- 之前。挤在同一个时刻就没有商定的余地——真同票了只能当场临时加时间。
--
--   周一 18:00  创意截止，投票开放    （deadlines.idea）
--   周一 20:00  投票截止，票数封存    （deadlines.screeningVote，本次新增）
--   周一 20:30  入围名单公布         （deadlines.screening）
--
-- 阶段推导（derivePhase）仍然只看 screening，所以 20:00–20:30 这半小时
-- 阶段还是 screening，只是投不了了——这正是想要的：名单还没对外，但票已
-- 经不能改。
--
-- ── 顺带把整条时间线往后挪 ────────────────────────────────────────────
--
-- 创意截止从周一 12:00 延到周一 18:00（多给半个工作日），初筛随之顺延到
-- 当晚。入围者仍然是周二一早开工，到周四晚，开发时间没被压缩——这是选当晚
-- 投票而不是放到周二的原因。
--
-- 页面上的文案和这些时刻必须一起改：活动页的「怎么参加」四步和规则条目里
-- 都写死了 12:00 / 14:30。改了时间戳不改文案，页面会一边显示"12:00 截止"
-- 一边在 18:00 还收得进来——而相信页面的人会按 12:00 来。
UPDATE ispace.events SET
  updated_at = now(),
  config = jsonb_set(
      jsonb_set(
        jsonb_set(config, '{deadlines,idea}',          '"2026-10-19T18:00:00+08:00"'),
        '{deadlines,screeningVote}',                   '"2026-10-19T20:00:00+08:00"'
      ),
      '{deadlines,screening}',                         '"2026-10-19T20:30:00+08:00"'
    )
  -- 入围几个。和 screeningVoteLimit（每人几票）恰好都是 8，但它们没有关系：
  -- 一个是投票权，一个是名额，分开配才不会在改其中一个时连带改错另一个。
  || jsonb_build_object('screeningSlots', 8)
WHERE slug = '1024-2026';

-- 「怎么参加」第 1、2 步的文案
UPDATE ispace.events SET
  config = jsonb_set(
    jsonb_set(
      config,
      '{how,0,desc}',
      '"写清楚想解决什么问题、打算怎么做。不用先做出来，10.19（周一）18:00 截止。"'
    ),
    '{how,1,date}', '"10.19 20:30"'
  )
WHERE slug = '1024-2026';

-- 规则里那条「10.19 12:00 截止前可以改」
UPDATE ispace.events SET
  config = jsonb_set(
    config, '{rules,3}',
    '"每人交 1 个创意，10.19（周一）18:00 截止前可以改；初筛结束前只有评委能看到。"'
  )
WHERE slug = '1024-2026';
