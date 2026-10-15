-- 1024 程序员节：赛事数据。
--
-- 为什么进 ispace schema 而不是做成一个用户页面：这件事要跨人读写
-- （八位评委给同一批作品打分、全员投票、名次由汇总得出），而用户
-- schema 按定义是一个人的私有数据空间，跨人读写在那儿没有位置。
-- 它也要在**未登录**时可读（活动详情页不要求登录），这同样不是
-- u_{username} 的语义。
--
-- 为什么是 events 表而不是把本届写死：标题里就写着「第 8 届」。
-- 多一张表换掉「明年再抄一遍」，这笔买卖划算；而 slug 让 /1024
-- 这个路径与具体某届解耦。
--
-- 阶段（phase）刻意可空：空 = 按 config 里的时间点自行推导，非空 =
-- 人工钉死。活动当天主持人需要能手动推进/回退（上午路演延时是常态），
-- 而平时不该有人记得去点一下按钮。两种都要，所以用「空=自动」。

-- ── events ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 路径标识。/1024 走 slug='1024-2026'，由应用层的当届常量解析，
  -- 不把年份写进 URL——横幅和海报上印的是 1024。
  slug        text NOT NULL UNIQUE
              CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title       text NOT NULL,
  subtitle    text,
  edition     text,
  venue       text,
  starts_at   timestamptz,
  ends_at     timestamptz,
  -- NULL = 按 config.phases 的时间点自动推导；非 NULL = 人工覆盖
  phase       text CHECK (phase IN ('signup','screening','building','demo','result','ended')),
  -- 规则、奖项、评分维度、日程、各截止时间、投票票数上限等全部文案与参数。
  -- 放 jsonb 而不是拆十张表：这些东西一年改一次、只被一个页面读，
  -- 拆表只会让「改个奖金数额」变成一次迁移。
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── event_ideas：创意（= 报名）─────────────────────────────────────
--
-- 报名与创意是同一件事：设计稿上那个按钮写的是「提交创意」，交了就算报名。
-- 因此没有单独的 registrations 表——多一张只存 (event,user) 的表，
-- 只会让「报名了但没交创意」这种在规则上不存在的状态变得可表示。
CREATE TABLE IF NOT EXISTS ispace.event_ideas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES ispace.events(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  problem     text NOT NULL CHECK (length(problem) BETWEEN 1 AND 2000),
  plan        text NOT NULL CHECK (length(plan) BETWEEN 1 AND 2000),
  -- 「做成什么」：iSpace 页面 / 硬件 / 其他。不做成枚举 CHECK：
  -- 它是给人看的一行字，不参与任何判断。
  form        text NOT NULL DEFAULT 'iSpace 页面',
  -- 效果图/设计稿/草图。[{name,size,url}]，最多 5 个（应用层限）
  files       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 初筛结果。finalist_no 是入围编号，也是 10.23 的路演顺序
  finalist    boolean NOT NULL DEFAULT false,
  finalist_no text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 规则写明「每人交 1 个创意」。在库层面钉住，而不是靠接口里记得查。
  UNIQUE (event_id, user_id)
);

-- 入围编号在一届内唯一。它被当作对外的作品编号（NO.04）用，重号会直接
-- 让路演顺序和大屏上的名次对不上。
CREATE UNIQUE INDEX IF NOT EXISTS event_ideas_finalist_no
  ON ispace.event_ideas (event_id, finalist_no) WHERE finalist_no IS NOT NULL;

-- ── event_works：入围后提交的作品 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.event_works (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES ispace.events(id) ON DELETE CASCADE,
  -- 一个创意至多一件作品；换作品是 UPDATE 而不是再插一行
  idea_id     uuid NOT NULL UNIQUE REFERENCES ispace.event_ideas(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('page','other')),
  -- kind='page' 时指向平台上的页面。ON DELETE SET NULL 而不是 CASCADE：
  -- 参赛者把页面删了不该把作品记录一起抹掉——名次已经按它排过了。
  app_id      uuid REFERENCES ispace.apps(id) ON DELETE SET NULL,
  -- 「参评的是提交那一刻的版本」。存版本号而不是只存 app_id：
  -- 提交后作者继续发布是常态，评委看的必须是定格的那一版。
  app_version integer,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  pitch       text,
  -- 硬件作品的照片/视频。至少一个（应用层在 kind='other' 时强制）
  files       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  /*
    硬件作品不该挂着一个页面 id——那是两种东西，混在一起会让「打开作品」
    指向一个根本不存在的地址。

    反过来**不**约束（不要求 kind='page' 就必须有 app_id）：页面是硬删除的
    （services/app-delete.ts），上面那条 ON DELETE SET NULL 一触发，app_id
    就变成 NULL 而 kind 仍是 'page'。若在这里要求两者同时成立，Postgres 会
    让那次级联更新失败，连带把**删除页面**这个动作整个挡掉——一个参赛过的
    页面从此删不掉，报错还是一句看不懂的约束名。
    所以 app_id 为空在这里是合法状态，含义是「页面已被作者删除」，
    读的那一侧（workUrl）本来就按没有地址处理。

    「提交页面作品时必须选一个页面」由接口层保证（routes/events.ts），
    那里才有能力给出一句人话。
  */
  CHECK (kind = 'page' OR app_id IS NULL)
);

-- ── event_judges ─────────────────────────────────────────────────────
--
-- 评委身份是本届的属性，不是账号的角色：今年的 TL 明年可能不当评委，
-- 而 users.role 只有 employee/admin 两档且是平台级的。
CREATE TABLE IF NOT EXISTS ispace.event_judges (
  event_id   uuid NOT NULL REFERENCES ispace.events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- ── event_scores：评委打分 ─────────────────────────────────────────
--
-- 一个评委对一个作品一行。主键就是这个三元组——同一个评委对同一个作品
-- 不存在两份分数，改分是 UPDATE。
--
-- 为什么另存 total 而不是每次从 dims 现算：名次由它排序，而排序要走索引；
-- 更重要的是它由服务端按 config 的维度上限校验后写入，读的时候不必再
-- 相信一遍 jsonb 里的数。两者一致性由写入路径唯一保证（routes/events.ts）。
CREATE TABLE IF NOT EXISTS ispace.event_scores (
  event_id     uuid NOT NULL REFERENCES ispace.events(id) ON DELETE CASCADE,
  idea_id      uuid NOT NULL REFERENCES ispace.event_ideas(id) ON DELETE CASCADE,
  judge_id     uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  -- 各维度得分，按 config.criteria 的顺序：[35,25,20,20] 四项
  dims         jsonb NOT NULL DEFAULT '[]'::jsonb,
  total        integer NOT NULL DEFAULT 0 CHECK (total BETWEEN 0 AND 100),
  note         text,
  -- 草稿（拖了滑块还没点提交）与已提交要分开：只有已提交的进汇总。
  -- 设计稿上那句「其他评委 7/7 已提交」数的就是这个。
  submitted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, idea_id, judge_id)
);

-- 汇总排名的走法：WHERE submitted_at IS NOT NULL GROUP BY idea_id
CREATE INDEX IF NOT EXISTS event_scores_submitted
  ON ispace.event_scores (event_id, idea_id) WHERE submitted_at IS NOT NULL;

-- ── event_votes：大众投票（最佳人气奖）─────────────────────────────
--
-- 一人一作品一行，主键钉住「不能给同一个作品投两票」；
-- 「每人 3 票」是跨行的约束，只能在应用层数（routes/events.ts）。
-- 「不能投给自己」同理——它要连到 ideas.user_id 才判断得出来。
CREATE TABLE IF NOT EXISTS ispace.event_votes (
  event_id   uuid NOT NULL REFERENCES ispace.events(id) ON DELETE CASCADE,
  idea_id    uuid NOT NULL REFERENCES ispace.event_ideas(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, idea_id, user_id)
);

-- 数某人投了几票（判 3 票上限）与数某作品得了几票（人气奖）各走一边
CREATE INDEX IF NOT EXISTS event_votes_by_user ON ispace.event_votes (event_id, user_id);
