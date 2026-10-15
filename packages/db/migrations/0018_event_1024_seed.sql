-- 第 8 届 1024 程序员节（2026）的文案与参数。
--
-- 为什么内容进迁移：活动页免登录可看，而「可看」的前提是库里得有这一行。
-- 把它交给一份手工 SQL 或后台表单，等于让活动页的上线依赖某个人记得去跑
-- 一下；而这些数字（奖金、分值、截止时间）是赛制本身，和表结构一样该有
-- 版本记录。改文案走 PATCH /deploy/api/events/1024-2026（管理员），不必
-- 再加迁移。
--
-- ON CONFLICT DO NOTHING：重复执行不覆盖线上已经改过的文案。
--
-- 时间全部带 +08 时区偏移。库里是 timestamptz，存的是绝对时刻；写字面量时
-- 必须显式给偏移，否则按服务器本地时区解释——容器里通常是 UTC，10.19 12:00
-- 的截止会变成北京时间晚上 8 点。

INSERT INTO ispace.events (slug, title, subtitle, edition, venue, starts_at, ends_at, config)
VALUES (
  '1024-2026',
  '程序员节',
  '灵感上线・AI 不设限',
  '第 8 届 · 2026',
  '三楼大会议室',
  '2026-10-23 10:00:00+08',
  '2026-10-23 17:00:00+08',
  jsonb_build_object(
    'tagline',   '灵感上线・AI 不设限',
    'dateLabel', '10.23 周五 10:00 – 17:00',
    'contact',   '活动有问题找甜豆（李雪鸽）',
    'voteLimit', 3,
    'deadlines', jsonb_build_object(
      -- 交创意截止：过了这一刻报名接口直接拒绝
      'idea',      '2026-10-19T12:00:00+08:00',
      -- 入围名单公布
      'screening', '2026-10-19T14:30:00+08:00',
      -- 交作品截止（10.22 24:00 = 10.23 00:00）
      'work',      '2026-10-23T00:00:00+08:00',
      -- 投票与评委打分锁定，名次按这一刻的分数排
      'vote',      '2026-10-23T11:55:00+08:00',
      -- 颁奖，结果公布
      'award',     '2026-10-23T15:30:00+08:00',
      -- 活动整体结束，横幅与活动页下线
      'end',       '2026-11-01T00:00:00+08:00'
    ),
    'rules', jsonb_build_array(
      '个人参赛，从想法到落地全流程由 1 人实现。',
      '方向不限，突出创新。建议贴业务或个人提效：产研提效、运营提效、个人提效、硬件 + AI。',
      '核心原则：好玩儿、有用、能跑起来。不要求多复杂，能跑 Demo 就行。',
      '每人交 1 个创意，10.19 12:00 截止前可以改；初筛结束前只有评委能看到。',
      'iSpace 页面参评的是提交那一刻的版本；硬件作品传照片或视频，10.23 带实物到场。',
      '10.23 上午现场扫码投票选最佳人气奖，每人 3 票，不能投给自己。'
    ),
    'how', jsonb_build_array(
      jsonb_build_object('icon','idea','title','交创意','date','10.16 – 10.19',
        'desc','写清楚想解决什么问题、打算怎么做。不用先做出来，10.19 12:00 截止。'),
      jsonb_build_object('icon','users','title','评委初筛','date','10.19 14:30',
        'desc','8 位 TL 评委投票选出 8 个创意入围，入围即得 ¥200 京东卡。'),
      jsonb_build_object('icon','code','title','做出来','date','10.19 – 10.22',
        'desc','4 天开发时间。页面部署到 iSpace 专区，硬件作品传照片或视频。'),
      jsonb_build_object('icon','presentation','title','现场路演','date','10.23 上午',
        'desc','每人 5 分钟 Demo + 2 分钟评委提问，下午颁奖。')
    ),
    'prizes', jsonb_build_array(
      jsonb_build_object('name','一等奖','count','1 名','money','¥5,000','how','评委打分第一 · 现金','tone','brand'),
      jsonb_build_object('name','二等奖','count','1 名','money','¥3,000','how','评委打分第二 · 现金','tone','plain'),
      jsonb_build_object('name','三等奖','count','1 名','money','¥1,500','how','评委打分第三 · 现金','tone','plain'),
      jsonb_build_object('name','最佳人气奖','count','1 名','money','¥500','how','礼品 · 8 个入围作品扫码投票','tone','dark'),
      jsonb_build_object('name','入围奖','count','全部入围','money','¥200','how','京东卡 · 入围即得','tone','subtle')
    ),
    -- 四项之和必须是 100：服务端按 max 校验每一项，总分上限由库的 CHECK 兜底
    'criteria', jsonb_build_array(
      jsonb_build_object('key','创意创新性','desc','想法和做法有没有新东西','max',35),
      jsonb_build_object('key','实用性','desc','真能帮同事解决一件具体的事','max',25),
      jsonb_build_object('key','完成度','desc','能跑起来，不报错、不出故障','max',20),
      jsonb_build_object('key','现场演示','desc','5 分钟讲清楚，问题答得上来','max',20)
    ),
    -- 一、二、三等奖看评委平均分名次；人气奖看票数。入围奖人人有份，
    -- 不参与名次计算（by='finalist' 在 computeAwards 里被跳过）。
    'awardRules', jsonb_build_array(
      jsonb_build_object('key','first','name','一等奖','money','¥5,000','by','judge','rank',1),
      jsonb_build_object('key','second','name','二等奖','money','¥3,000','by','judge','rank',2),
      jsonb_build_object('key','third','name','三等奖','money','¥1,500','by','judge','rank',3),
      jsonb_build_object('key','popular','name','最佳人气奖','money','¥500 礼品','by','votes','rank',1),
      jsonb_build_object('key','finalist','name','入围奖','money','¥200','by','finalist','rank',0)
    ),
    'schedule', jsonb_build_array(
      jsonb_build_object(
        'label','上午 · 1024·AI创新赛',
        'time','10:00 – 12:00 · 三楼大会议室',
        'rows', jsonb_build_array(
          jsonb_build_object('time','10:00','icon','ticket','title','签到入场','desc','会议室门口签到，领手环。手环号下午抽奖用。'),
          jsonb_build_object('time','10:20','icon','mic','title','主持人开场','desc','介绍今天的安排和评委。'),
          jsonb_build_object('time','10:30','icon','presentation','title','入围项目路演','desc','每人 5 分钟 Demo + 2 分钟评委提问，大屏倒计时，严格控时。'),
          jsonb_build_object('time','11:40','icon','qr','title','评委打分 + 扫码投票','desc','评委现场打分，定一、二、三等奖；全体观众扫码投票，选最佳人气奖。'),
          jsonb_build_object('time','11:55','icon','utensils','title','上午场结束','desc','午餐自行解决，下午 14:00 准时开始。')
        )
      ),
      jsonb_build_object(
        'label','下午 · 节日狂欢',
        'time','14:00 – 17:00 · 三楼大会议室',
        'rows', jsonb_build_array(
          jsonb_build_object('time','14:00','icon','coffee','title','下午茶','desc','蛋糕、咖啡、茶歇，自由交流。'),
          jsonb_build_object('time','14:30','icon','gift','title','抽奖','desc','第一轮。一人抽手环号，一人抽奖品。'),
          jsonb_build_object('time','15:00','icon','gift','title','抽奖','desc','第二轮'),
          jsonb_build_object('time','15:10','icon','trophy','title','正式颁奖','desc','1024·AI创新赛一、二、三等奖和最佳人气奖。'),
          jsonb_build_object('time','15:30','icon','gift','title','抽奖','desc','第三轮'),
          jsonb_build_object('time','15:40','icon','zap','title','趣味抢答游戏','desc','节奏快，易操作，好分胜负。'),
          jsonb_build_object('time','16:10','icon','gift','title','抽奖','desc','最后一轮，人人有奖。'),
          jsonb_build_object('time','16:20','icon','mail','title','1024 红包','desc','柳哥手拿 1024 红包抽人。'),
          jsonb_build_object('time','16:25','icon','cake','title','切蛋糕 + 合影','desc','1024 主题蛋糕，全体大合影。'),
          jsonb_build_object('time','16:50','icon','flag','title','收尾','desc','主持人总结，散场。')
        )
      )
    )
  )
)
ON CONFLICT (slug) DO NOTHING;
