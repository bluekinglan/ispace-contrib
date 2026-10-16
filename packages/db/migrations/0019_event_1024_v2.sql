-- 第 8 届 1024 的第二版方案：场地、赛程、投票机制、奖品都改了。
--
-- 为什么是新迁移而不是改 0018：0018 已经跑过了（线上和测试库都有记录），
-- 改它一个字也不会重新执行。而这些不是笔误订正，是方案本身变了：
--
--   场地   上午 CC光、下午大培训教室（原来全天三楼大会议室）
--   时间   10:00–12:00 + 15:00–17:30（原来 10:00–17:00 连着）
--   投票   现场扫码改成**全员在 iSpace 投票**，10.22 18:00 开放、10.23 12:00
--          截止，每人 2 票（原来 3 票、现场 11:40 起）
--   互斥   最佳人气奖与一二三等奖互斥（原来没有这条）
--   奖品   前三名和人气奖另有奖杯；人气奖由「礼品」改成京东卡
--
-- ⚠️ 投票截止（12:00）与评委打分锁定（11:55）从此是**两个时刻**，所以
-- deadlines 拆出 voteOpen / judgeLock 两个新键。沿用一个 vote 字段的话，
-- 把投票推到 12:00 会连带把评委打分也放宽五分钟。
--
-- 用 jsonb 的 || 合并而不是整体替换：只动这几个键，万一线上已经有人手工
-- 改过别的文案（PATCH /events/:slug 是开放给管理员的），不会被这条抹掉。

UPDATE ispace.events SET
  venue = '上午 CC光 · 下午大培训教室',
  -- 下午从 15:00 开始，整体收在 17:30
  ends_at = '2026-10-23 17:30:00+08',
  updated_at = now(),
  config = config
    || jsonb_build_object(
      'dateLabel', '10.23 周五 10:00 – 12:00 · 15:00 – 17:30',
      'voteLimit', 2,
      'deadlines', (config->'deadlines')
        || jsonb_build_object(
          -- 人气投票提前到前一天傍晚开，横跨 building 与 demo 两个阶段
          'voteOpen',  '2026-10-22T18:00:00+08:00',
          'vote',      '2026-10-23T12:00:00+08:00',
          -- 评委打分仍然 11:55 锁，上午场到那时结束
          'judgeLock', '2026-10-23T11:55:00+08:00',
          -- 颁奖提到 15:10（下午 15:00 入场，15:10 正式颁奖）
          'award',     '2026-10-23T15:10:00+08:00'
        ),
      'rules', jsonb_build_array(
        '个人参赛，从想法到落地全流程由 1 人实现。',
        '方向不限，突出创新。建议贴业务或个人提效：产研提效、运营提效、个人提效、硬件 + AI（可找玉龙用 3D 打印机，仅限 mini 件）。',
        '核心原则：好玩儿、有用、能跑起来。不要求多复杂，能跑 Demo 就行。',
        '每人交 1 个创意，10.19 12:00 截止前可以改；初筛结束前只有评委能看到。',
        'iSpace 页面参评的是提交那一刻的版本；硬件作品传照片或视频，10.23 带实物到场。',
        '最佳人气奖全员在 iSpace 投票，10.22 18:00 开放、10.23 12:00 截止，每人 2 票，不能投给自己；与一二三等奖互斥。'
      ),
      'prizes', jsonb_build_array(
        jsonb_build_object('name','一等奖','count','1 名','money','¥5,000','how','评委打分第一 · 现金 + 奖杯','tone','brand'),
        jsonb_build_object('name','二等奖','count','1 名','money','¥3,000','how','评委打分第二 · 现金 + 奖杯','tone','plain'),
        jsonb_build_object('name','三等奖','count','1 名','money','¥1,500','how','评委打分第三 · 现金 + 奖杯','tone','plain'),
        jsonb_build_object('name','最佳人气奖','count','1 名','money','¥500','how','京东卡 + 奖杯 · 全员 iSpace 投票','tone','dark'),
        jsonb_build_object('name','入围奖','count','全部入围','money','¥200','how','京东卡 · 入围即得','tone','subtle')
      ),
      -- exclusive 让人气奖跳过已拿一二三等奖的作品。结算按本数组顺序，
      -- 所以它必须排在三个评委奖之后。
      'awardRules', jsonb_build_array(
        jsonb_build_object('key','first','name','一等奖','money','¥5,000','by','judge','rank',1),
        jsonb_build_object('key','second','name','二等奖','money','¥3,000','by','judge','rank',2),
        jsonb_build_object('key','third','name','三等奖','money','¥1,500','by','judge','rank',3),
        jsonb_build_object('key','popular','name','最佳人气奖','money','¥500 京东卡','by','votes','rank',1,'exclusive',true),
        jsonb_build_object('key','finalist','name','入围奖','money','¥200','by','finalist','rank',0)
      ),
      'schedule', jsonb_build_array(
        jsonb_build_object(
          'label','上午 · 1024·AI创新赛',
          'time','10:00 – 12:00 · CC光',
          'rows', jsonb_build_array(
            jsonb_build_object('time','10:00','icon','gift','title','群里热场抽奖','desc','活动群里抽 3 轮：面膜、洗发膏、奶茶。'),
            jsonb_build_object('time','10:00','icon','ticket','title','签到领手环','desc','大培训教室签到领手环；参赛选手到 CC光 入场准备，主持人介绍流程。'),
            jsonb_build_object('time','10:20','icon','presentation','title','入围项目路演','desc','每人 5 分钟 Demo + 2 分钟评委提问，大屏倒计时，严格控时。'),
            jsonb_build_object('time','11:40','icon','qr','title','评委打分','desc','评委现场打分，定一、二、三等奖。人气投票 12:00 截止。'),
            jsonb_build_object('time','11:55','icon','utensils','title','上午场结束','desc','午餐自行解决，下午 15:00 大培训教室见。')
          )
        ),
        jsonb_build_object(
          'label','下午 · 节日狂欢',
          'time','15:00 – 17:30 · 大培训教室',
          'rows', jsonb_build_array(
            jsonb_build_object('time','15:00','icon','mic','title','入场','desc','领 1–83 号码牌，主持人介绍下午流程。'),
            jsonb_build_object('time','15:10','icon','trophy','title','正式颁奖','desc','1024·AI创新赛一、二、三等奖和最佳人气奖。获奖人讲话 + 柳哥讲话。'),
            jsonb_build_object('time','15:30','icon','gift','title','全员抽奖','desc','线上抽奖，1–83 号和礼品一起随机滚动，凭号码牌当场兑换。'),
            jsonb_build_object('time','16:00','icon','gift','title','彩蛋抽奖','desc','化妆镜 5 个、匹克球拍 5 个、奶茶 20 杯。'),
            jsonb_build_object('time','16:20','icon','cake','title','切蛋糕 + 合影','desc','1024 主题蛋糕，全体大合影。'),
            jsonb_build_object('time','16:30','icon','coffee','title','下午茶','desc','摆在大培训教室外，自取，到 17:30。'),
            jsonb_build_object('time','16:30','icon','zap','title','三个游戏','desc','套圈、投壶、「筷乐」零食，和下午茶同时进行。')
          )
        )
      ),
      -- 评选说明那段话，活动页「奖项与评选」小节末尾显示
      'judgingNote', '路演作品全靠评委打分排名次，定一、二、三等奖；现场扫码投票只用来选最佳人气奖。最佳人气奖由全员在 iSpace 投票产生（10.22 18:00 – 10.23 12:00，每人 2 票），与一二三等奖互斥。全员另有两款飞书头像框。'
    )
WHERE slug = '1024-2026';
