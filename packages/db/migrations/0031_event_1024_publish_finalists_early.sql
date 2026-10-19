-- 入围名单提前到 20:00 公布（原定 20:30）。
--
-- 组织者 19:41 在控制台手动定了 9 个入围：前 5 名之后有 6 个创意并列 4 票，
-- 扩到 9 个也装不下，自动规则本来就会留给人定。名单既然定了，就不必再留
-- 20:00–20:30 那半小时核对，初筛投票一截止就公布。
--
-- （中途一度改成 19:47 立即公布，上线约一分钟后组织者改定 20:00。线上那
-- 一分钟的值已被覆盖，这份文件写的是最终口径。）
--
-- 改截止时间，而不是把 events.phase 钉成 building：钉住阶段会让时钟停转，
-- 10.23 00:00 作品截止时不会自动进路演阶段，打分页也就不会解锁。
--
-- screeningVote 与 screening 对齐在同一刻：封票即公布。
--
-- how[1] 那张「评委初筛」卡的日期是写死的字符串，跟着改。
UPDATE ispace.events SET
  updated_at = now(),
  config = jsonb_set(
             jsonb_set(
               jsonb_set(
                 config,
                 '{deadlines,screening}',
                 to_jsonb('2026-10-19T20:00:00+08:00'::text)
               ),
               '{deadlines,screeningVote}',
               to_jsonb('2026-10-19T20:00:00+08:00'::text)
             ),
             '{how,1,date}',
             to_jsonb('10.19 20:00'::text)
           )
WHERE slug = '1024-2026';
