-- 用户头像。
--
-- ┌─ 为什么存进库，而不是像 1024 附件那样落盘 ─────────────────────────┐
-- │ deploy-service 容器只挂了 /srv/{sites,releases,bundles,workspaces, │
-- │ event-files}。再开一个 /srv/user-files 要改 compose、在宿主机上    │
-- │ 建目录并把属主改成容器里的 uid 1000——都要 sudo，而这个平台的运维  │
-- │ 口令是刻意不留在任何文件里的。                                     │
-- │                                                                    │
-- │ 头像又恰好是最适合进库的那一类文件：几十 KB、一人一张、换了就覆盖。│
-- │ 进库之后备份脚本自动带上它（09-backup.sh 备的是数据库），删号时跟着│
-- │ 级联删掉，也不会像落盘那样攒下一堆没人引用的孤儿文件。             │
-- │                                                                    │
-- │ 这条理由对「几十 KB 的头像」成立，对附件和产物不成立——那些是 10MB │
-- │ 起步的视频和整个网站，仍然该落盘。别照着这张表去搬别的东西。       │
-- └────────────────────────────────────────────────────────────────────┘
--
-- 单独一张表而不是给 users 加列：findUserById 走的是 SELECT *，每次鉴权
-- 都要跑一遍。头像字节挂在 users 上，等于每个请求都顺带把它读出来扔掉。
CREATE TABLE IF NOT EXISTS ispace.user_avatars (
  user_id    uuid PRIMARY KEY REFERENCES ispace.users(id) ON DELETE CASCADE,
  -- 白名单。这些字节会被浏览器直接渲染，放进一个 svg 就等于在平台域名下
  -- 挂了段任意脚本——和 1024 附件是同一条理由，所以这里连 svg 都不收。
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes      bytea NOT NULL CHECK (length(bytes) > 0),
  -- 内容指纹，进 URL 当版本号，也当 ETag。
  --
  -- 用内容而不是时间戳：换头像时 URL 必然跟着变，浏览器立刻取新的；而
  -- 「传了一张和原来一模一样的图」不会白白让所有人的缓存失效。生成列由
  -- 库自己算，应用层不可能忘记更新它。
  etag       text GENERATED ALWAYS AS (md5(bytes)) STORED,
  updated_at timestamptz NOT NULL DEFAULT now()
);
