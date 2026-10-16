-- 「忘记密码」的自助申请。
--
-- ┌─ 为什么不复用 password_resets ────────────────────────────────────┐
-- │ 那张表存的是**已经签发的链接**：token_hash 与 issued_by 都是        │
-- │ NOT NULL。而一条申请此刻两样都没有——令牌还没生成，也还没有哪个     │
-- │ 管理员经手。硬塞进去就得把这两列改成可空，于是「已签发」和「待处理」│
-- │ 混在一张表里，每个查询都要带一句 token_hash IS NOT NULL 才算对。    │
-- │                                                                    │
-- │ 两种东西，两张表。申请被放行时才往 password_resets 写一行。         │
-- └────────────────────────────────────────────────────────────────────┘
--
-- 平台没有邮件服务，链接没法自动送到本人手上，所以自助只能做到「发起」
-- 这一步：本人点一下，管理员那边冒出一条待处理，点「发链接」再转交。
-- 比起原来「忘了密码得先想办法找到管理员、再把事情说一遍」，省掉的是
-- 找人和解释，而不是管理员这个环节。
CREATE TABLE IF NOT EXISTS ispace.password_reset_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  -- 放行（或驳回）的时刻与经手人。NULL 表示还在等着。
  handled_at  timestamptz,
  handled_by  uuid REFERENCES ispace.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 一个人同时只能有一条待处理申请。
--
-- 没有这条约束的话，点三次「忘记密码」就在管理员那边堆三条一模一样的东西；
-- 而人在登不进去的时候恰恰会反复点。部分索引而不是普通唯一索引：已处理的
-- 历史记录要留着（谁什么时候申请过、谁放的行），只是不参与去重。
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_requests_pending_uniq
  ON ispace.password_reset_requests (user_id)
  WHERE handled_at IS NULL;

-- 管理员那一屏按时间倒序列待处理的，走这条。
CREATE INDEX IF NOT EXISTS password_reset_requests_pending_idx
  ON ispace.password_reset_requests (created_at DESC)
  WHERE handled_at IS NULL;
