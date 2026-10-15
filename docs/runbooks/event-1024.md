# 1024 程序员节：办一届的操作手册

活动页在 `https://{域名}/1024`，**不要求登录**；点「提交创意」才要身份。
三个页面：

| 路径            | 谁能开                 | 做什么                                   |
| --------------- | ---------------------- | ---------------------------------------- |
| `/1024`         | 任何人，免登录         | 活动详情、报名、交作品、现场投票         |
| `/1024/judge`   | 本届评委 + 管理员      | 现场打分，电脑手机同一个地址             |
| `/1024/screen`  | 任何人，免登录         | 1920×1080 会议室大屏背景墙，浏览器全屏放 |

数据在 `ispace.events` 等六张表（迁移 `0017`），本届的文案与赛程由迁移
`0018` 灌入，slug 是 `1024-2026`。

**办这届不用敲命令。** 控制台 → 右上「管理员」→ 侧栏「活动 · 1024 赛事」
是一屏做完四件事的地方：看全部创意、勾选并排序出入围名单、设评委、推进
阶段，外加颁奖前核对名次。下面的 `curl` 与 SQL 仍然留着——控制台打不开、
或者要把某一步写进脚本时用得上。

---

## 一、阶段是自己走的，不用盯着

阶段按 `config.deadlines` 里的时刻**自动推导**，没人需要在 10.19 中午
12 点整守着点一下按钮：

| 阶段        | 从                | 页面长什么样                     |
| ----------- | ----------------- | -------------------------------- |
| `signup`    | 开始 → 交创意截止 | 怎么参加 + 规则，底部「提交创意」 |
| `screening` | → 公布入围        | 创意已截止，等名单               |
| `building`  | → 交作品截止      | 入围名单 + 进度，底部「提交作品」 |
| `demo`      | → 颁奖            | 路演作品 + 投票，评委入口        |
| `result`    | → 活动结束        | 获奖名单                         |
| `ended`     | 之后              | 横幅自动下线                     |

**只有一种情况需要手动干预**：当天路演延时、或者要提前/推迟宣布。那时把
`phase` 钉死，结束后记得设回 `null` 交还给时钟。控制台那屏的「阶段」块
就是这两个按钮，并且写明「时钟此刻在哪一阶段」，免得钉死之后忘了还：

```bash
# 钉死在「展示答辩」
curl -X PATCH https://{域名}/deploy/api/events/1024-2026 \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"phase":"demo"}'

# 交还给时钟
curl -X PATCH https://{域名}/deploy/api/events/1024-2026 \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"phase":null}'
```

`$COOKIE` 是管理员账号的会话（浏览器里 F12 → Application → Cookies →
`ispace_session`），或者用管理员的 `isp_` 访问令牌走
`-H "authorization: Bearer isp_..."`。

---

## 二、活动开始前：设评委

评委身份是**本届**的属性，不是账号角色——今年的 TL 明年可能不当评委。
控制台那屏的「评委名单」块从在职员工里挑人、上下排序、一次提交；要用
命令的话，按路演时希望的顺序给用户名：

```bash
curl -X PATCH https://{域名}/deploy/api/events/1024-2026 \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"judges":["heqizheng","mowen","baoheizi","kaisa","qinglan","chaopin","chunshu","kelong"]}'
```

整批替换，不是增量。账号必须存在且在职，否则整条请求失败并告诉你是哪几个
找不到——不会设进去一半。

设完刷新 `/1024`，「奖项与评选」那段会出现评委头像。

---

## 三、10.19 初筛后：定入围名单

初筛是八个人围着一块屏讨论。控制台那屏的「本届创意」把全部创意摊开成
卡片（作者、想解决什么问题、打算怎么做、形态、附件），当场在卡片上点
「入围」、用箭头排出路演顺序，再点一次「提交入围名单」——**推荐这么办**，
不用抄 uuid。

它背后是 `GET /deploy/api/events/1024-2026/ideas`（管理员专用；公开接口
在初筛结束前一个创意都不返回）。想直接查库也可以：

```sql
SELECT i.id, u.display_name, i.name, i.form, i.problem, i.plan
  FROM ispace.event_ideas i
  JOIN ispace.users u ON u.id = i.user_id
  JOIN ispace.events e ON e.id = i.event_id
 WHERE e.slug = '1024-2026'
 ORDER BY i.created_at;
```

定下来之后，**按路演顺序**提交 id 列表，编号自动生成 `01`…`08`（控制台
那屏点「提交入围名单」发的就是这一条）：

```bash
curl -X PATCH https://{域名}/deploy/api/events/1024-2026 \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"finalists":["<uuid1>","<uuid2>","...共 8 个"]}'
```

顺序就是编号，编号就是 10.23 的路演顺序，也是作品卡上的 `NO.04`。
重设会先清空再重编，整个过程在一个事务里——不会出现「刷新时一个入围的
都没有」那一瞬。

设完之后，入围者打开 `/1024` 就会看到「你入围了」和「提交作品」按钮。

> 初筛结束前，创意只有评委和作者本人能看到（活动页在 `signup` /
> `screening` 阶段根本不返回创意列表，附件也单独鉴权）。这是写在参赛
> 须知里的，不是实现细节。

---

## 四、10.23 当天

**上午路演**。大屏打开 `/1024/screen` 全屏（F11 / ⌃⌘F）。它每分钟自己拉
一次数据，底部那行会跟着阶段变，颁完奖自动变成冠军是谁，不用中途换页面。

**评委打分**。评委打开 `/1024/judge`，或者从 `/1024` 底部的「你是本届
评委 · 去打分」进。四个维度拉滑块，点「提交打分」才进汇总，「存草稿」
不进。评委之间互相看不到分数，只看得到「其他评委几人已提交」。

**全员投票**。`demo` 阶段，`/1024` 的作品卡上出现「投一票」。每人 3 票，
不能投给自己，再点一次是撤回。投票期间**不显示票数**——实时放票数会把
投票变成跟票。

**11:55 锁定**。到 `deadlines.vote` 那一刻，打分和投票都不能再改。

**名次怎么出来的**。一、二、三等奖按八位评委**已提交**分数的平均分排；
最佳人气奖按票数排。颁奖前想先看一眼：控制台那屏底部的「汇总排名」就是
它，带着「几个评委打了分」——不足全员时标「名次暂定」。命令行：

```bash
curl https://{域名}/deploy/api/events/1024-2026/ranking -b "$COOKIE"
```

返回每个作品的 `judgeScore`（平均分，一位小数）、`judged`（几个评委打了，
不足全员时名次是暂定的）、`votes`、`rank`。这个接口**只有管理员能开**——
结果公布前它等于提前泄露名次。

到 `deadlines.award`（15:30）阶段自动转 `result`，`/1024` 出现获奖名单，
普通人这时才看得到分数和票数。

---

## 五、改文案、改奖金、改赛程

全在 `events.config` 这一个 jsonb 里。整块替换（不合并——半自动合并出来的
中间状态没人看得懂），所以先取出来改完再发回去：

```bash
# 取当前配置
curl https://{域名}/deploy/api/events/1024-2026 | jq .event.config > cfg.json
# 改完发回
curl -X PATCH https://{域名}/deploy/api/events/1024-2026 \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d "{\"config\": $(cat cfg.json)}"
```

能改的东西：`deadlines`（各阶段时刻，**带时区偏移**，如
`2026-10-19T12:00:00+08:00`）、`rules`、`how`、`prizes`、`criteria`
（评分维度，`max` 之和必须是 100）、`schedule`、`awardRules`、`voteLimit`、
`contact`。

⚠️ `criteria` 在**打分开始后**不要改。已经落库的分数是按旧维度打的，
改了之后总分对不上维度，名次会变成另一回事。

---

## 六、明年再办

加一条迁移，照 `0018_event_1024_seed.sql` 的样子插一行新的
`events`（slug 用 `1024-2027`），然后把
`packages/contracts/src/event.ts` 里的 `CURRENT_EVENT_SLUG` 指过去。
`/1024` 这个路径不用动——它本来就不带年份。

旧的那届留在库里，数据不删。

---

## 附：部署相关

- `1024` 已加入 `RESERVED_PATHS` 与 `infra/caddy/Caddyfile` 的排除列表。
  **改了 Caddyfile 要重新部署网关**（`infra/scripts/07-deploy-caddy.sh`），
  否则 `/1024/judge` 和 `/1024/screen` 会被当成 `/{user}/{app}/` 去
  `/srv/sites/` 找文件，表现是 404。`/1024` 本身不受影响。
- 参赛附件落在 `/srv/event-files`，由 `06-deploy-service.sh` 建目录并
  挂进容器。读写都经过 deploy-service 鉴权，不走网关直出。
- 迁移 `0017`/`0018` 在服务启动时自动执行（`runMigrations`）。

## 附：在真库上验一遍

`apps/deploy-service/src/__tests__/events-integration.test.ts` 会跑通整条
赛事链路——建表、种子、报名、定名单、交作品、打分、投票、汇总排名、
获奖名单、附件鉴权。没配库时整个文件跳过，所以 `pnpm test` 不受影响。

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=pgtest -p 55432:5432 postgres:16-alpine
ISPACE_TEST_PG='postgres://postgres:pgtest@127.0.0.1:55432/postgres' \
  pnpm --filter @ispace/deploy-service test
```

⚠️ 它开头就 `DROP SCHEMA ispace CASCADE`。只指一次性的测试库，**别指生产**。

改了迁移、改了 `routes/events.ts` 里任何一条 SQL，都应该跑一遍这个——
那些语句在假 sql 下写错了也不会报错。
