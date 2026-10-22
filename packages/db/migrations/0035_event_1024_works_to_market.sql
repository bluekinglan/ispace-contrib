-- 把已经交上来的 1024 页面作品补进创意市场，并打上「1024 作品」分类。
--
-- ── 为什么要这一条 ────────────────────────────────────────────────────
-- 首页探索那一格「1024 作品」是按 apps.category 归桶的（contracts/social.ts
-- 的 exploreBucket 只认「1024 作品」这个值），卡片右上角那个 1024 徽章认同
-- 一个字符串。这套机制一直都在，但**没有任何一步去填它**——交作品的接口
-- 从来不碰分类，所以那一格从上线起就是空的。
--
-- 填它的那一步现在补在了 PUT /events/:slug/work 里（交页面作品时顺手设成
-- 全公司可见 + 上架 + 打分类）。这条迁移管的是那之前就交上来的：本届已经
-- 有人在改动上线前交了，不补的话他那件在首页上仍然看不见。
--
-- ── 为什么连可见范围一起改 ────────────────────────────────────────────
-- 可见性是网关强制的（见 routes/authz.ts 补的那个越权）。拿「仅自己」的
-- 页面交作品，活动页上那个「打开作品」别人点进去会被挡住，而投票和评委
-- 打分都要先打得开。交上来参赛本身就是同意给全公司看。
--
-- 只动本届确实交了页面作品的那些 app，一人一件，范围很窄。
UPDATE ispace.apps a SET
  visibility = 'public',
  category   = '1024 作品'
FROM ispace.event_works w
JOIN ispace.events e ON e.id = w.event_id
WHERE w.app_id = a.id
  AND e.slug = '1024-2026'
  AND w.kind = 'page';

-- 上架。published_by 记作品的作者本人，和他自己点「上架」是同一条记录。
INSERT INTO ispace.marketplace_listings (app_id, published_by)
SELECT w.app_id, i.user_id
  FROM ispace.event_works w
  JOIN ispace.events e      ON e.id = w.event_id
  JOIN ispace.event_ideas i ON i.id = w.idea_id
 WHERE e.slug = '1024-2026'
   AND w.kind = 'page'
   AND w.app_id IS NOT NULL
ON CONFLICT (app_id) DO NOTHING;
