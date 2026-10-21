-- Agent 会话落库（创建屏 / 手机壳的对话）。
--
-- 为什么现在才落库：会话原先存在 deploy-service 的内存里，理由是"单实例、
-- 重启丢了让用户重新说一遍就行"。上线两天下来这个代价比预想的大——每次
-- 部署都是一次重启，正在做页面的人回来点「再改一处」，模型已经不认识这个
-- 页面了；刷新后工作台能接着显示，背后的对话却是空的。
--
-- workspace 是这条会话改的那个工作区（/srv/workspaces/{username}/{workspace}/），
-- slug 是它发布到的页面。发布成功之后才填 slug——用 (user_id, slug) 就能从
-- 「我要改 /zhoubao/」找回当初做它的那个工作区，而不是另起一个空的。
--
-- messages 不含 system 那一条（每次请求按当时的连接器、预览状态重拼），也
-- 不含图片的原始字节（见 services/agent-store.ts 的 stripImages）：一张截图就是
-- 几百 KB 的 base64，存进来只会让这张表膨胀，而模型早就看过、说过了。
CREATE TABLE IF NOT EXISTS ispace.agent_sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  workspace  text NOT NULL,
  slug       text,
  messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 「改 /zhoubao/ 时找回它的工作区」与「这个人最近在做哪个」都按人查
CREATE INDEX IF NOT EXISTS agent_sessions_user_slug
  ON ispace.agent_sessions (user_id, slug, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_user_updated
  ON ispace.agent_sessions (user_id, updated_at DESC);
-- 定期清理按时间扫全表
CREATE INDEX IF NOT EXISTS agent_sessions_updated
  ON ispace.agent_sessions (updated_at);
