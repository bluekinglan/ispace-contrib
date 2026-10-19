-- 李雪鸽（甜豆，组织者）可以提前进颁奖大屏。
--
-- 获奖名单对外 10.23 15:10 才公布，可分数 11:55 就锁定、人气票 12:00 截止。
-- 中间这三个小时组织者得把颁奖大屏挂上、从背景墙走一遍；拿不到名单的话，
-- 颁奖页整页停在「获奖名单还没出来」，连 15:00 入场时该挂着的背景墙都进不去。
--
-- 放开的时刻由服务端算（canPreviewAwards）：打分锁定和人气投票截止都过了
-- 才放。管理员默认就能提前看，不用列在这里。
UPDATE ispace.events SET
  updated_at = now(),
  config = config || jsonb_build_object('awardPreview', jsonb_build_array('lixuege'))
WHERE slug = '1024-2026';
