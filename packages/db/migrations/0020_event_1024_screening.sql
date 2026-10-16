-- 活动页两处补字段：头图的导语 `intro`，和「奖项与评选」里的「初筛看什么」。
--
-- 头图导语：标题下的一句话。转发到群里的人多半只看头图，这一句要替整页
-- 先回答「这是什么、我够不够格参加」——所以写的是门槛而不是赛程：不强制
-- 组队，一个人带 AI 也能交得出来。赛程在下面的「怎么参加」里有完整的。
--
-- 它不是打分维度：初筛是八位评委投票选八个创意，没有分值，所以单独一个
-- 字段而不是塞进 criteria（criteria 的 max 之和必须是 100，混进来会破坏
-- 服务端的打分校验）。
--
-- 内容取自设计稿。缺这个字段时活动页不显示这一栏，所以老数据不受影响。
UPDATE ispace.events SET
  updated_at = now(),
  config = config || jsonb_build_object(
    'intro', '【1024  AI创意赛】，好玩儿、有用、能跑起来，不强制组队，1人+N个AI也能完成~！',
    'screening', jsonb_build_array(
      jsonb_build_object('key','有用','desc','说得出谁、在什么时候会用'),
      jsonb_build_object('key','能跑起来','desc','一个人 4 天能做出能跑的 Demo'),
      jsonb_build_object('key','好玩儿','desc','别人没想到，或者做法很巧')
    ),
    'screeningNote', '8 位评委投票，得票最多的 8 个创意入围。'
  )
WHERE slug = '1024-2026';
