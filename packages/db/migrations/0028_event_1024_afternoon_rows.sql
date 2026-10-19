-- 下午安排合回设计稿的 6 行。
--
-- 库里把「下午茶」和「三个游戏」拆成了两行，两行都写 16:30。颁奖大屏上
-- 这一屏是一条竖时间轴，两个相同的时间点挨在一起会读成「16:30 之后还有
-- 一个 16:30」，而它们本来就是同一段时间里并行的事。稿上是一行。
--
-- 顺带把几处标点改回稿：描述里不收句号（这是时间轴条目，不是句子），
-- 并列项用「·」不用顿号，「正式颁奖」不再重复「1024·AI创新赛」前缀——
-- 顶栏上已经写着它了。
--
-- 只换「下午」这一块。上午那块不归颁奖大屏管，别动。
UPDATE ispace.events SET
  updated_at = now(),
  config = jsonb_set(
    config,
    '{schedule,1,rows}',
    jsonb_build_array(
      jsonb_build_object('time','15:00','icon','mic','title','入场',
        'desc','领 1–83 号码牌，主持人介绍下午流程'),
      jsonb_build_object('time','15:10','icon','trophy','title','正式颁奖',
        'desc','一、二、三等奖和最佳人气奖 · 获奖人讲话 + 柳哥讲话'),
      jsonb_build_object('time','15:30','icon','gift','title','全员抽奖',
        'desc','1–83 号和礼品一起随机滚动，凭号码牌当场兑换'),
      jsonb_build_object('time','16:00','icon','gift','title','彩蛋抽奖',
        'desc','化妆镜 5 个 · 匹克球拍 5 个 · 奶茶 20 杯'),
      jsonb_build_object('time','16:20','icon','cake','title','切蛋糕 + 合影',
        'desc','1024 主题蛋糕，全体大合影'),
      jsonb_build_object('time','16:30','icon','coffee','title','下午茶 · 三个游戏',
        'desc','大培训教室外自取 · 套圈、投壶、「筷乐」零食，到 17:30')
    )
  )
WHERE slug = '1024-2026';
