# 在线运行的编程 harness：工作区实时预览与真运行时

- **日期**：2026-10-20
- **状态**：**L1、L2 已落地；L3（真运行时容器）决定不做。** 预览的边界因此收成
  一条：能直接打开就跑的页面才渲染，其余不预览并说清楚原因（见第 12 节）。
  第 6 节关于容器的方案保留，作为当初怎么权衡的记录，但不再是待办。
- **与 `2026-10-20-ui-v2.md` 的关系**：那一份记录改版 UI 怎么落地的，其中创建屏
  右栏留了一个洞（「发布前没有预览可看」）。本文件补的就是那个洞。
- **边界已定**：真运行时（容器里跑 Node/Python 服务端）+ 预览里的页面能真取到数。
  这是和用户确认过的，不是推断的。

---

## 1. 现在是什么样，缺的是哪一环

创建屏（`apps/portal/src/create.tsx`）左栏是对话与进度，右栏是预览。右栏现在装的
是 `PreviewBody`：**有 `publishedUrl` 才渲染 iframe，否则画一屏骨架**。也就是说
模型正在写文件的那几十秒到几分钟里，右栏是空的；人要等到点完「发布到我的空间」
才第一次看见自己的东西。

这不只是体验问题。它让「模型自己改」这条回路断了：页面跑起来才暴露的错误
（三维场景黑屏、`requestAnimationFrame` 里抛异常、取数拿到 404），在发布之前谁
都看不见，模型也就无从改起。它只能靠读自己写的代码来猜。

缺的那一环是：**工作区在发布之前就要有一个能跑、能看、能把错误说回来的地址。**

---

## 2. 平台已经有什么（这决定了方案不从零造）

动手之前先盘一遍。下面每一条都是现成的，真运行时要做的是接上去，不是重写。

| 已有的东西 | 在哪 | 对本方案意味着什么 |
|---|---|---|
| 每用户一个工作区目录 | `ISPACE_WORKSPACE_ROOT`（线上 `/srv/workspaces/{用户名}`），`packages/agent/src/tools.ts` 的 `safePath` 守边界 | 预览要伺服的就是这个目录。边界函数直接复用，不另写一个 |
| 容器编排抽象 | `packages/orchestrator`，`DokployOrchestrator` + `MockOrchestrator` | 真运行时不必新造编排层；但 Dokploy 的模型只收 git 仓库或公开镜像，**收不了「本地目录」**——这是第 6 节要解的主要矛盾 |
| 带鉴权的容器反向代理 | `apps/deploy-service/src/routes/svc-proxy.ts`（`/svc/{user}/{name}`） | 预览代理照抄它的形状：先判权限，再按 `container_name:port` 代过去。连「丢哪些逐跳头」「为什么要换掉 Host」都已经踩过 |
| 强制资源限额 | `DEFAULT_QUOTAS`：`backendCpuLimit 0.5`、`backendMemLimitMb 512`；`createBackendApp` 内部强制写入 | 预览容器用同一档，不另立一套。理由见 §6.3 |
| 出站防护 | `services/outbound-guard.ts`，DNS 钩子层判定，防重绑定 | 预览容器的外网出口策略要和它说同一套话，不能一边堵 SSRF 一边给容器裸奔的网 |
| 定时清理的地方 | `jobs/maintenance.ts` 的 `every(hours, name, fn)` | 预览回收挂进去即可，不新起一套调度 |
| 发布时往页面注入脚本 | `packages/storage` 的 `injectShellScript`，`services/deploy.ts:177` 调用 | 预览的 shim 用同样的思路，但**注入发生在响应里、不落盘**（§5.2） |
| 页面级三档可见性鉴权 | `routes/authz.ts`（Caddy forward_auth 的落点） | 预览不走它（预览只有本人能看，比三档简单），但"认不出就拒绝"那条默认值要照抄 |

还有一条不是代码、但同样是约束：**deploy-service 以 uid 1000 运行，没有挂 docker
socket**。`tools.ts` 的大注释写明了这是刻意的——挂 socket 等于在服务里开一个拿宿主
root 的口子。第 6 节的方案必须尊重这条，否则就是把当初避开的坑又挖回来。

---

## 3. 分三层，每层自己能交付

把「在线运行」拆成三层。这样拆不是为了好看，是因为**第一层做完，纯前端作品
（three.js、canvas 游戏、普通网站）当场就全跑起来了**——那是创建屏目前能产出的
绝大多数东西；第三层的风险（容器、特权、资源）被隔离在最后，万一评审下来觉得
代价太大，前两层仍然是完整的交付物。

```
L1  工作区静态预览        把 /srv/workspaces/{user} 伺服出去，鉴权 + 沙箱 + 自动刷新 + 报错回流
    └ 覆盖：HTML/CSS/JS、three.js、canvas 游戏、任何纯前端作品
L2  预览取数令牌          给沙箱页面一条能带身份的取数通道（连接器 + 自己的 schema，只读）
    └ 覆盖：「带数据的系统」类页面在发布前就看得到真数
L3  真运行时容器          工作区里跑 Node/Python 服务端进程，预览地址代到容器
    └ 覆盖：Express/FastAPI 这类自带服务端的作品
```

L1 和 L2 不需要容器，也不需要任何新特权。L3 需要，§6 专门讲它。

---

## 4. 地址与路由

### 4.1 预览地址长什么样

```
/deploy/api/preview/{previewId}/            →  工作区根目录的 index.html
/deploy/api/preview/{previewId}/main.js     →  工作区里的 main.js
/deploy/api/preview/{previewId}/img/a.png   →  工作区里的 img/a.png
```

`previewId` 是随机不可猜的 id（16 字节 base64url），服务端存它到
`{userId, username, createdAt, expiresAt, containerRef?}` 的映射，和 Agent 会话同一套
内存生命周期、同一个清理定时器。

### 4.2 为什么挂在 `/deploy/api` 下面，而不新开一级路径

本来最顺手的写法是 `/preview/{...}`。**不这么做是有意的。**

新增任何一级顶层路径要同步三处（`RESERVED_PATHS`、`Caddyfile` 的
`not path_regexp` 排除列表、`reserved.test.ts` 的一致性断言），`reserved.ts` 的注释
专门写了这个坑：漏一处，已有同名用户的目录会被网关静默当平台路由处理。预览这件事
完全不需要付这笔账——`/deploy` 本来就是保留路径，Traefik 已经把它整段路由到
deploy-service，挂在它下面一行配置都不用改。

**代价要说清楚**：预览页面里写了根绝对路径（`/assets/x.js`）会穿出预览、落到平台
自己的路由上，拿到的不是那个文件。但这恰恰是**好事**——平台本来就要求页面用相对
路径（`session.ts` 的系统提示里明写、发布链路有 base path 校验），因为发布后的站点
也挂在 `/{用户名}/{slug}/` 子路径下。预览和发布踩同一个坑，等于把「写了绝对路径」
这个错误提前到预览阶段暴露，而不是发布后才 404。两边约束一致，模型学到的东西
才是对的。

### 4.3 鉴权

每个预览请求（包括每个子资源）都要：

1. `requireAuth(req)` —— 没登录 401。
2. `previewId` 查得到，且 `userId === 当前用户`，且没过期 —— 否则 **404**。

第 2 条一律 404、不区分「不存在」「过期」「不是你的」，和 `authz.ts`、`svc-proxy.ts`
的处理一致：区分了就等于告诉对方这个 id 是真的。

**管理员也不放行。** 页面鉴权那边管理员能看任何页面（`authz.ts` 里 `claims.role === 'admin'`
直接 200），预览这里不给——预览是一个人手上还没成形的草稿，不是已发布的内容，
没有「管理员需要排查」的场景能压过这一点。真要排查，让他看发布后的版本。

### 4.4 路径边界

把 URL 里 `{previewId}/` 之后的部分当相对路径，**复用 `tools.ts` 的 `safePath`**
（提到 `@ispace/contracts` 或一个共用模块里，两处共用一份，不各写一个）。
`resolve` 之后不在 `{workspaceRoot}/{username}` 之下就 403。

要额外挡的，`safePath` 现在没管：

- **URL 编码的穿越**：`%2e%2e%2f`。Fastify 的通配符参数给的是已解码的字符串，
  所以 `safePath` 拿到的是 `../`，能挡住。要有用例钉死这件事。
- **符号链接**：`safePath` 的注释自己承认「挡住 `../`、绝对路径，以及符号链接之外
  的所有越界形式」。Agent 的文件工具写不出符号链接（没有这个工具），但工作区目录
  在宿主上是可能被运维手工动过的。预览伺服文件前加一次 `realpath` 校验，几微秒的
  代价，把这个口子一并堵上。

---

## 5. 沙箱与取数

### 5.1 沙箱策略：和详情页一字不差，再加一道

iframe 属性沿用 `wall.tsx` / `detail.tsx` 那一套：

```html
<iframe sandbox="allow-scripts allow-forms allow-popups" ...>
```

**不给 `allow-same-origin`**。`2026-10-20-ui-v2.md` §5 写了理由：两者同时给等于没有
沙箱，被预览的页面就能借平台的 origin 读写平台接口。预览这边更要守——预览里跑的
是模型刚写出来、没人审过的代码。

再加一道，这是发布站点那边现在没有的：

```
Content-Security-Policy: sandbox allow-scripts allow-forms
```

**为什么需要它**：iframe 的 `sandbox` 属性只在页面被 iframe 嵌入时生效。用户把预览
地址复制到新标签页直接打开（调试时很自然的动作），沙箱属性就不存在了——页面跑在
平台 origin 上，`document.cookie` 拿得到会话，`fetch('/deploy/api/...')` 带着身份就发
出去了。CSP 的 `sandbox` 指令是响应头，顶层导航照样生效，把那种情况也按进 opaque
origin 里。一行头，补掉一整类「换个打开方式就绕过」的问题。

### 5.2 取数：shim + 一次性令牌

opaque origin 的代价是**浏览器不会带会话 cookie**（跨源 + SameSite 双重拦截）。
所以沙箱里的页面调 `/deploy/api/connect/{slug}` 会 401，「带数据的系统」类作品在
预览里只能看见自己的空态。用户明确要求这一档要真能取到数，方案如下。

**注入时机：在响应里注入，绝不落盘。** 预览伺服 `index.html` 时，在 `</head>` 前插一段
shim（思路同 `injectShellScript`，但那个是写进发布产物的，这里是流式改写响应）。
工作区里的文件**一个字节都不改**——工作区就是发布产物，shim 落了盘就会跟着发布
上线，那是一段带令牌的代码。

**令牌怎么到页面手里：postMessage 握手，不写进页面源码。**

```
预览页 shim 启动 → postMessage({type:'ispace:need-token'}) 给 parent
父窗口（创建屏）收到 → 校验 event.source === iframeRef.current.contentWindow
                     → postMessage({type:'ispace:token', token}) 回去，targetOrigin '*'
shim 收到 → 之后 window.ispace.fetch(path) 都带 Authorization: Bearer <token>
```

为什么是握手而不是直接把令牌印进 HTML：印进去它就在页面源码里，用户截个图、
把预览地址发给同事看一眼，令牌就跟着出去了。握手的话令牌只在内存里。

校验 `event.source` 这一步不能省也不能换：sandbox 的 iframe origin 是 `"null"`，
父窗口用 `event.origin` 根本区分不了「我的预览 iframe」和「另一个网站开的 sandbox
iframe」。`event.source === contentWindow` 是对象同一性比较，这个骗不了。

**令牌的作用域，三条都要硬**：

| 维度 | 限制 | 为什么 |
|---|---|---|
| 时效 | 与预览同寿，≤60 分钟 | 令牌在浏览器内存里，泄露窗口就是预览的寿命 |
| 身份 | 固定签发时那个 userId，不可提升 | 拿到的东西他本来就拿得到，泄露的最坏后果可控 |
| 路径 | 白名单两类：`GET /deploy/api/connect/{slug}/*`、该用户自己 schema 的只读查询 | 不给写、不给删、不碰别人的 schema |

**CORS 要怎么开，这一条写死，并且要有用例钉住**：

预览取数端点返回 `Access-Control-Allow-Origin: null`，且
**`Access-Control-Allow-Credentials` 必须是关的，端点必须只认 Bearer、完全忽略 cookie**。

理由值得说透：`Origin: null` 不是"我们的预览"的标识——**任何网站开一个 sandbox
iframe，发出的请求 Origin 都是 null**。如果这组端点既接受 `Origin: null` 又接受
cookie 凭据，那么任意外站放一个 `<iframe sandbox="allow-scripts" src="...">` 就能带着
用户的平台会话打我们的 API。所以这两件事必须互斥：开了 null origin，就只能认
Bearer；而 Bearer 只有握手拿得到，外站拿不到。

这条规则是整个 L2 的安全支点，`preview-token.test.ts` 里要有一条用例专门钉它：
带 cookie 不带 Bearer 的请求，在预览端点上返回 401。

### 5.3 报错回流

目标是「模型能自己改」，所以错误必须回到对话里，而不是停在浏览器控制台。

shim 挂三个口子，都经 postMessage 回父窗口（父窗口同样用 `event.source` 比对）：

- `window.onerror`
- `unhandledrejection`
- 包一层 `console.error`

父窗口拿到之后**不自动塞进对话**。自动塞会污染用户正要说的话，而且一个
`favicon.ico 404` 不值得触发一轮模型调用。做法是：右栏预览下方出现一条
「页面报了 N 个错」，点开看详情，旁边一个「让它修」按钮——点了才把错误文本作为
follow-up 发出去。人决定要不要修，模型拿到的是完整的错误栈。

服务端侧的错误（L3 的依赖安装失败、进程起不来、容器被 OOM kill）走同一条路：
预览状态接口把它作为 `lastError` 返回，右栏同样显示 + 「让它修」。

### 5.4 自动刷新

不需要文件监听，也不需要新的 WebSocket。`/agent/ask` 的 SSE 流里已经有现成的信号：

```
{ type: 'tool_result', name: 'write_file', ... }
{ type: 'tool_result', name: 'delete_file', ... }
```

创建屏收到这两个就刷新 iframe（`src` 带一个递增的 `?_r=` 破缓存）。这比文件监听
准——它刷的时刻正好是"模型刚写完一个文件"，而不是"磁盘动了"。

两个细节：

- **连写多个文件要防抖**。模型一轮里可能连写五个文件，每写一次刷一次会让人看见
  五次白闪。收到信号后 300ms 内不再刷，最后一次为准。
- **L3 有 dev server 时不要刷**。vite / next 自己有 HMR，外面再 reload 一次会把
  用户在页面上的状态（游戏进度、表单填了一半）清掉。预览状态接口要告诉前端
  "这个预览是静态的还是带 dev server 的"，前端据此决定刷不刷。

---

## 6. 真运行时（L3）——**决定不做，本节是记录**

> 这一节原本是待评审的主体。评审结果是**不做**：预览只伺服文件，带服务端的
> 项目不预览（见第 12 节）。下面的内容保留下来，是因为"为什么不做"比"不做"
> 本身有用——下次有人再提容器预览，该先读完这一节再提。

### 6.1 主要矛盾：现有编排器收不了「本地目录」

`Orchestrator.deploySource(ref, sourceRepo)` 只认两种源：git 仓库地址、公开 Docker
镜像（`detectSourceKind`）。而预览要跑的是 `/srv/workspaces/{用户名}` 这个**宿主上的
目录**，它既不是仓库也不是镜像，而且它每几秒就被模型改一次——每次改都构建一个
镜像再部署，几十秒起步，"实时预览"就不成立了。

所以 L3 不能简单地复用 `deploySource`。要跑的形态是：**一个固定镜像的容器，把用户
工作区挂进去，在里面跑用户的代码**。

### 6.2 谁来下达「起容器」这个指令

这是本方案唯一需要新增特权的地方，三条路：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A** 给 deploy-service 挂 docker socket | 直接 `docker run` | **否决。** `tools.ts` 的大注释写明当初就是为了不开这个口子才放弃沙箱方案。挂 socket = 这个进程能拿宿主 root；而 deploy-service 是整个平台里攻击面最大的进程（它收用户上传、跑 Agent、代理连接器） |
| **B** 让 Dokploy 代劳 | 调它的 API 建一个带挂载的应用 | **不推荐。** Dokploy 的模型是「应用 = 源 + 构建」，宿主目录挂载要绕它的 compose 类型配，字段靠试；而且每个预览在 Dokploy 里留一条应用记录，和用户真正的后端混在一个项目里，清理和配额都要重新算 |
| **C** 新增一个极窄的 sidecar：`ispace-preview-runner` | 它有 docker socket，但只暴露四个动作，参数极窄 | **推荐。** 见下 |

**方案 C 的形状**：

```
ispace-preview-runner  （新容器，有 /var/run/docker.sock，只挂 /srv/workspaces:ro）
  POST /start   { username, previewId }        → { containerName, port }
  POST /stop    { previewId }
  GET  /status  { previewId }                  → { state, lastError }
  GET  /logs    { previewId, lines }           → string
```

关键在于**它不接受任何用户可控的 docker 参数**：

- 镜像：写死在 runner 的配置里，调用方不能指定。
- 命令：固定（见 §6.4 的启动约定），调用方不能指定。
- 挂载路径：runner 自己拼 `/srv/workspaces/{username}`，`username` 先过
  `usernameSchema` 校验（正则已限死小写字母数字连字符）才拼进路径。
- 网络、限额、只读根：全由 runner 写死，调用方碰不到。

这样做的实质是：**把「给一个进程任意 docker API」收敛成「给一个进程四个动作，
每个动作的参数只有两个字符串，且都过白名单正则」**。攻击面从「整个 docker API」
缩到「这四个函数的参数校验」，而后者是能被单元测试穷举的。

runner 自己不碰数据库、不做鉴权、不对外暴露——只监听内网，只有 deploy-service
能调它。鉴权仍然全部发生在 deploy-service（§4.3），runner 相信它的调用方。

**这是需要拍板的第一件事。** 不接受这条，L3 就只剩方案 B（更脏）或者不做 L3。

### 6.3 资源与时长上限

| 项 | 值 | 为什么是这个值 |
|---|---|---|
| CPU | **0.5 核** | 和 `DEFAULT_QUOTAS.backendCpuLimit` 同一档。不另立一套——预览里跑得动、发布后跑不动，是最难查的那种问题 |
| 内存 | **512 MB** | 同上，`backendMemLimitMb` |
| 进程数 | **pids-limit 256** | 挡 fork 炸弹。模型写出无限递归 spawn 不需要恶意，一个 bug 就够了 |
| 根文件系统 | **只读** | 工作区挂载点可写，其余只读。挡「往容器里塞东西当持久存储」 |
| `/tmp` | **tmpfs 64 MB** | 构建工具要临时目录，但不该落宿主盘 |
| 依赖目录 | **独立 volume，上限 1 GB，不计入用户静态空间配额** | 见下 |
| 空闲回收 | **15 分钟无请求即停** | 创建屏是人盯着看的场景。人走了就不该再烧 CPU |
| 硬上限 | **60 分钟** | 无论多活跃。一次创建会话超过一小时，该让他发布或者重开 |
| 每人并发 | **1 个** | 一个人同时只在一屏上创建 |
| 全平台并发 | **可配，默认 8** | 8 × 512 MB ≈ 4 GB。**这个数要按宿主实际可用内存定，是需要拍板的第二件事** |

**依赖目录为什么不计入用户配额**：用户的静态空间配额是 500 MB
（`DEFAULT_QUOTAS.storageBytesLimit`），一次 `npm install` 就能吃掉大半。而
`node_modules` 不是作品的一部分，发布时也不会带上去（发布链路发的是工作区里的产物）。
把它算进去，用户会因为"装了个依赖"而发不了布——那个错误信息怎么写都说不通。所以
单独给一个 volume、单独限额、容器销毁时一并删。

### 6.4 容器里跑什么：启动约定

容器起来之后执行什么，三选一，按顺序探测：

1. 工作区根有 `ispace.run.json` → 按里面的 `{ install, start, port }` 跑。
   **白名单**：`install` 只允许 `npm ci` / `npm install` / `pnpm install` / `pip install -r requirements.txt`；
   `start` 只允许 `npm run <脚本名>` / `node <文件>` / `python <文件>` / `uvicorn <模块>`。
   不是"执行任意字符串"——那就等于把 shell 还给了模型，而不给 shell 正是现有设计的
   立足点。
2. 有 `package.json` 且有 `scripts.dev` → `npm install && npm run dev`。
3. 都没有 → **不起容器**，退回 L1 静态伺服。

第 3 条很重要：纯前端作品（three.js、canvas 游戏、静态网站）根本不需要容器，
它们走 L1 就够了，一个容器都不该为它们起。**L3 只在工作区里真的有服务端时才介入。**
预览状态接口要把当前是哪一档告诉前端（也影响 §5.4 刷不刷）。

### 6.5 网络出口

默认立场：**预览容器不给公网。**

接一张 `internal: true` 的 overlay 网，容器里只能到 deploy-service。页面要外部数据
就走平台连接器（`/deploy/api/connect/{slug}`）——这和发布后的约束完全一致，而且
`session.ts` 的系统提示本来就是这么教模型的（"不要自己去调第三方域名，那会被跨域
挡住"）。预览和发布说同一套话。

**但 `npm install` 要出网。** 这是真矛盾，两条解法：

- **C1（推荐）预装 + 不给外网。** 基础镜像里预装一批常用依赖（three、express、
  fastapi、uvicorn、pillow…），容器永不出网。装不到的依赖，模型会收到明确的错误
  "平台预览环境只有这些包"，它可以换方案或者告诉用户。
  好处：出口问题根本不存在，启动快（没有 install 等待），没有供应链风险。
  代价：清单要人维护；模型想用清单外的包时会卡住。
- **C2 开一个只到内网 registry 镜像的出口。** 安装阶段走 `HTTP_PROXY` 指向平台
  自建的 npm/pypi 镜像，装完切到 internal 网。
  好处：依赖不受限。
  代价：要先有内网 registry 镜像（现在没有）；安装阶段的几十秒要有状态反馈；
  "装依赖"本身成了一个可能失败、需要排查的新环节。

**这是需要拍板的第三件事。** 我的建议是 C1 起步——创建屏的产物目前以前端为主，
预装清单覆盖得住；真遇到清单不够用的，再上 C2 不迟，而且那时候有真实的"缺了哪些
包"的数据可以依据。

无论哪条，`ISPACE_CONNECTOR_ALLOW_PRIVATE` 那条规矩不变：连接器默认不许打内网，
预览容器也不例外。

### 6.6 清理策略

四道，缺一道就会攒出没人收的容器：

1. **空闲 15 分钟** —— 预览代理每次请求刷新 `lastSeenAt`；巡检发现超时即 stop。
2. **硬上限 60 分钟** —— 不看活跃度。
3. **会话结束** —— 创建屏卸载时 `navigator.sendBeacon` 打一下 `/preview/{id}/release`；
   SSE 断开后宽限 2 分钟。**这条只是加速，不能依赖**——浏览器崩溃、断网时它不会发出来，
   所以第 1、2 条才是真正的兜底。
4. **孤儿回收** —— runner 启动时按标签 `ispace.preview=1` 把所有存量容器清一遍。
   平台重启后内存里的 previewId 映射全没了，容器却还在跑，这条是唯一能收它们的。

巡检挂进 `jobs/maintenance.ts` 的 `every()`，周期 5 分钟。那里的
`NOTE(多实例)` 同样适用：多实例部署时这个巡检会重复跑，要改成带 advisory lock 的
调度——文档里标清楚，不要默默多跑。

容器停掉时，依赖 volume 一并删。

### 6.7 配额

工作区本来就有配额（`get_quota` 查的那三项）。预览新增两项，但**不新建配额表**——
它们是运行期的并发限制，不是存量资源：

- 每人同时 1 个预览容器（超了：停掉旧的、起新的，并在对话里说一句）。
- 全平台并发上限（超了：**排队并明说**"现在有 N 个人在预览，等一会儿"。不静默降级
  成静态预览——那会让人以为自己的服务端代码没生效）。

依赖 volume 的 1 GB 上限按 §6.3，不计入 `storageBytesLimit`。

---

## 7. 测试计划

接口层的鉴权与越权是必须有的，照 `apps/deploy-service/src/__tests__` 既有写法
（Fastify `inject` + 假的 `requireAuth`，不碰库）。

**`preview-access.test.ts`**（不碰库、不碰容器）

- 没登录 → 401
- 别人的 `previewId` → **404**（不是 403：区分了就泄露了 id 的存在性）
- 不存在的 `previewId` → 404，且和上一条**同一句话**
- 过期的 `previewId` → 404，同一句话
- `../` 越界 → 403，且不读任何文件
- URL 编码的 `%2e%2e%2f` → 403（钉住"解码后再判定"这件事）
- 符号链接指向工作区外 → 403（钉住 `realpath` 那道）
- 管理员拿别人的 `previewId` → 404（钉住 §4.3 "管理员也不放行"）

**`preview-token.test.ts`**

- 白名单外的路径带着令牌 → 403
- 写操作（POST/DELETE）带着令牌 → 403（令牌只读）
- 过期令牌 → 401
- **带 cookie 不带 Bearer 的请求 → 401**（§5.2 的安全支点，这条最重要）
- 别人的令牌打自己的 schema → 403

**`preview-runner.test.ts`**（纯单元，不起容器）

- `username` 含 `../`、绝对路径、大写、超长 → 一律拒绝，不拼进挂载路径
- 调用方试图指定镜像/命令/网络 → 参数被忽略或拒绝
- 限额参数恒等于约定值（钉住"不依赖调用方自觉"）

**集成测试**：凡是要库的，`ISPACE_TEST_PG` 必须指向 `ispace_test` 这个**另一个库**。
既有集成用例会 `DROP SCHEMA`，指错了会把本机演示栈的数据清掉。

**跑不到的地方要说清楚**：真容器的启停在这个开发环境里跑不了（沙箱禁 docker）。
L3 的验证只能在有 docker 的机器上人工走一遍，这一点和 `2026-10-20-ui-v2.md` §6
里"移动端没在真机上跑过"是同一类诚实。

---

## 8. 分期与交付物

| 期 | 内容 | 产出 | 需要新特权？ | 状态 |
|---|---|---|---|---|
| **一** | L1：预览路由 + 鉴权 + `safePath`/realpath + CSP sandbox + 创建屏接上 + 写文件自动刷新 + 报错回流 | 纯前端作品（three.js、canvas 游戏、网站）在发布前真能跑、真能看、错误能回到对话 | 无 | **已落地** |
| **二** | L2：shim 注入（响应里，不落盘）+ postMessage 握手 + 一次性只读令牌 + CORS 规则 + 用例 | 「带数据的系统」类页面在预览里取到真数 | 无 | **已落地** |
| **三** | L3：`ispace-preview-runner` sidecar + 启动约定 + 限额/出口/清理 + 巡检接入 | 工作区里的 Node/Python 服务端真跑起来 | **有**：runner 需要 docker socket | 等第 9 节拍板 |

一、二两期不碰 `Caddyfile`、不碰 `RESERVED_PATHS`、不新增容器，所以先做了。
第三期动基础设施，等第 9 节那三件事定了再开。

---

## 9. 需要拍板的三件事 —— **已作废**

这三件（runner sidecar 这条路接不接受、并发上限定多少、依赖预装还是开内网
registry 出口）全部是 L3 的前置问题。L3 决定不做，三件一并作废，一行基础设施
都没有新增：没有新容器，没有 docker socket，没有新的出口策略。

---

## 10. 整个方案的已知空缺

已落地那两层自己的空缺另记在 §11.7，这里只说方案层面的。

- **真容器部分在本开发环境验证不了**（沙箱禁 docker、禁端口监听）。L3 落地后需要在
  有 docker 的机器上人工走一遍启停、超时回收、孤儿回收三条。
- **多实例部署下预览全部失效**：`previewId` 映射在内存里，和 Agent 会话同一个毛病
  （`routes/agent.ts` 的 `NOTE(多实例)`）。横向扩容时两者要一起外置。
- **预览不做历史**。关掉就没了，没有"回到十分钟前那一版"。工作区里只有最新状态，
  要做版本得先有快照机制——那是另一件事。
- **L3 的 dev server 端口是容器内固定端口**。用户的代码监听了别的端口就连不上。
  `ispace.run.json` 里的 `port` 能覆盖，但没写配置、又没用约定端口的情况下，
  表现是"预览一直在转"。状态接口要能明确说出"容器起来了但那个端口没人听"，
  而不是让它一直转。

---

## 11. 已落地部分的实际形态（L1、L2）

### 11.1 新增与改动的文件

| 文件 | 做什么 |
|---|---|
| `apps/deploy-service/src/services/preview-session.ts` | 预览会话表：id、令牌、两条超时、一人一个 |
| `apps/deploy-service/src/services/preview-shim.ts` | 注进页面那段脚本，以及它的落点选择 |
| `apps/deploy-service/src/services/preview-auth.ts` | 预览取数的身份解析。**只认 Bearer，一眼都不看 cookie** |
| `apps/deploy-service/src/routes/preview.ts` | 会话开/释放、文件伺服、边界、沙箱头 |
| `apps/deploy-service/src/routes/connectors.ts` | 把「这次请求是谁」抽成 `connectHandler` 的参数，加 `/preview-data/connect` 那一组（GET + OPTIONS） |
| `apps/deploy-service/src/server.ts` | 两处共用同一张会话表 |
| `apps/portal/src/api.ts` | `previewOpen()` |
| `apps/portal/src/create.tsx` | `usePreview` 钩子、`onToolDone`、右栏接预览、报错条 |

接口：

```
POST   /deploy/api/preview-session                  → { previewId, token, url, expiresAt, idleMs }
POST   /deploy/api/preview-session/release          → { ok }            （sendBeacon）
GET    /deploy/api/preview/{previewId}/{路径...}     → 工作区里的文件
GET    /deploy/api/preview-data/connect/{slug}/...  → 连接器取数（Bearer）
```

`Caddyfile` 与 `RESERVED_PATHS` 一行没动——这是 §4.2 选这个地址的目的。

### 11.2 写完就看见是怎么做到的

没有文件监听，也没有新的 WebSocket。`/agent/ask` 的 SSE 流里本来就有
`tool_result`，创建屏收到 `write_file` / `delete_file` 就刷 iframe（防抖 300ms）。

**用 `tool_result` 而不是 `tool_start`**：start 那一刻文件还没落盘，刷新看到的仍是
上一版，人会以为"改了没生效"。`streamAsk` 原先只解析 `tool_start`，这次补上了
`tool_result` 的回调。

### 11.3 实现时改掉的两个判断

这两条都不是设计阶段想出来的，是跑起来才发现的，记在这里免得下次又踩。

**一、`realpath` 那道必须拿 root 的 realpath 去比，不能拿 root 原样比。**

工作区根自己就可能落在软链后面：macOS 上 `/var → /private/var`，线上
`/srv/workspaces` 也完全可能是条软链。拿原样的 root 比，`realpath` 出来的
`/private/var/...` 不以 `/var/...` 开头，于是**每一个正常请求都 403**，而报错写的是
"这个链接指到工作区外面了"——一句把人带去完全错误方向的话。实测就是这个状态。

**二、字面 `../` 到不了 handler，用例不该假装它到了。**

实测（Fastify 5 / light-my-request，浏览器同理）：`/preview/{id}/../../x` 在路由之前
就被规范化成 `/deploy/api/x`，请求根本进不来，于是是一个路由级 404。所以
`preview-access.test.ts` 里那条断言的是"没把文件给出去"，不是某个具体状态码——
真要求它 403 就得去改一个我们从来没收到过的请求。

真正会打到边界上的是**编码**形式 `%2e%2e%2f`（浏览器不会规范化它），那一条
单独有用例，而且是 403。

### 11.4 报错回流最后做成了什么样

shim 收三类错（脚本异常、未处理的 Promise、资源加载失败）并 postMessage 给父窗口，
父窗口在预览下方摆一条「页面报了 N 个错」，带「看看 / 先不管 / 让它修」。

**不自动塞进对话**：一个 `favicon.ico` 404 不值得触发一轮模型调用，而且自动发出去
会把用户正要说的话冲掉。点「让它修」才真的作为一次追问发出去。

回流有 50 条上限：一个每帧抛异常的动画循环能在一秒里产出几十条，没有上限会把
父窗口刷爆。

### 11.5 测试

| 用例文件 | 钉住什么 |
|---|---|
| `preview-access.test.ts`（15 条） | 未登录 401；别人的 / 不存在的 / 过期的 id 一律 404 且**同一句话**；管理员也不放行；编码 `../` 与软链越界 403 且不泄露内容；缺末尾斜杠要 302；一人一个、释放只认本人 |
| `preview-token.test.ts`（14 条） | **带 cookie 不带 Bearer 必须 401**（§5.2 的安全支点）；响应给 `null` origin 开门但绝不带 `allow-credentials`；预检答得出来；只读（POST/PUT/DELETE 没注册）；预览令牌走正门不作数；shim 的注入落点（不能跑到 `<!doctype>` 前面） |
| `preview-shim.test.ts`（7 条） | 把真 shim 放进假 window 跑：报到、改道并带 Bearer、**冒充者的令牌不作数**、非取数请求一个字不动、三类报错回流、50 条上限 |

`preview-shim.test.ts` 用手搭的假 window（`node:vm`）而不是 jsdom：shim 只用到
window / location / Headers / URL 这几样，为它引一个 DOM 实现是拿一个大依赖换四个桩。
而「冒充者的令牌不作数」这一条靠手工是点不出来的——要点出来得真搭一个冒充父窗口
的页面。

### 11.6 在真浏览器里验到了什么，没验到什么

用一个最小 harness（只拉起预览路由与取数路由，`requireAuth` 换成固定用户，不碰库）
在浏览器里跑过一遍。**验到了**：

- **`Content-Security-Policy: sandbox` 在顶层导航上确实生效。** 直接打开预览地址，
  `window.origin` 是 `"null"`，读 `document.cookie` 抛 `SecurityError: The document
  is sandboxed and lacks the 'allow-same-origin' flag`。这正是 §5.1 要堵的那个口子
  ——iframe 的 `sandbox` 属性管不到"复制地址到新标签页打开"这种情形。
- **工作区文件伺服得出来、脚本真在跑**（canvas 画得出来）。
- **shim 的改道在真浏览器里成立**：页面写的是 `/deploy/api/connect/...`，网络面板里
  出去的是 `/deploy/api/preview-data/connect/...`。
- **CORS 头在抛错路径上没丢**。取数端点返 404（假 sql 查不到连接器）时，响应里
  仍带着 `access-control-allow-origin: null`。这一条是真担心过的——头是在
  handler 之前 `reply.header()` 设的，而 404 是全局 errorHandler 生成的响应。

**没验到**：iframe 嵌入 + postMessage 握手那一段端到端。内置浏览器会把**沙箱文档
发出的**子框架与子资源请求一律拦掉（`net::ERR_BLOCKED_BY_CLIENT`）——同样的地址
从普通页面 fetch 全是 200，所以这是那个浏览器自己的策略，不是代码的问题。握手逻辑
由 `preview-shim.test.ts` 在假 window 里覆盖，但"真 iframe 里真跑起一个 three.js
场景、真刷新"还没人眼看过。

另：`resource-access.test.ts` 在本机沙箱里红 7 条，全是 `listen EPERM`（它要起一个
真的 HTTP 上游）。**出沙箱单跑是 14 条全绿**，与本次改动无关。其余各包 vitest 全绿，
`pnpm -r build` 通过。

### 11.7 后补的三件小事

一、二期交付时留了三个空缺，随后补掉了，做法记在这里。

**一、`XMLHttpRequest` 也接管了。** 原先只改 `fetch`。系统提示教模型写 fetch，但
它并不总听，而漏掉 XHR 的后果不是"少一个特性"——是页面在预览里取数 401、人以为
平台坏了。改道判断抽成 `reroute()`，两条路共用一份。

`send()` 是同步 API，没法 `await` 令牌，所以做法是**把 send 推迟到令牌到手**：
对象停在 OPENED 等一下，调用方只觉得这个请求慢了点，状态机没被破坏。同步 XHR
（`open` 第三个参数为 `false`）推迟不了，那种情况下有令牌就带、没有就直接发，
让它去撞 401 把错误回流出来，而不是把页面卡死。

**二、系统提示会告诉模型「用户正看着预览」了，但只在真有预览时说。**
`buildSystemPrompt(connectors, { livePreview })`，多出来的那段让它先写
`index.html`（预览的入口，先写别的那块就一直空着）、并且知道页面报的错会回到
对话里来找它改。

关键在**这个开关由服务端查真实状态得出**，不收前端的声明：`routes/agent.ts` 拿
`previewSessions.hasFor(userId)` 判断。前端能撒谎，而这句话对一个没有预览的会话
（手机壳那条流）就是假话——模型会按"他正看着"去安排顺序，甚至回话里提
「你右边应该已经能看到了」，而那边根本没有那块东西。

**三、发布成功后主动收掉预览会话。** 发布之后右栏换成正式地址，工作区预览没人
看了，留着只是白占一个会话名额（每人同时只有一个）。主动收仍只是加速，兜底的
还是服务端那两条超时。

用例：`preview-shim.test.ts` 补了 XHR 改道与"非取数请求不等令牌"两条；
`agent.test.ts` 补了「没有预览时一个字都不提」那一组；`preview-access.test.ts`
补了 `hasFor` 的真值随开/超时/释放变化。

---

## 12. 最终的边界：只渲染能直接打开就跑的页面

L3 不做之后，预览的能力边界就定死了：**它只伺服文件，不起任何进程。**
于是工作区里的东西分成两类，界面上也必须分成两类对待。

### 12.1 规则

| 工作区是什么 | 怎么判的 | 右栏出什么 |
|---|---|---|
| 能直接打开就跑的页面 | 有 `index.html`，且没有下面两类信号 | **渲染**，和之前一样 |
| 带服务端 | `server.js` / `app.py` / `requirements.txt` / `Dockerfile` / `go.mod` …，或 `package.json` 依赖了 express、fastify、next 这类 | 不渲染，摆一页说明 |
| 要先构建 | `vite.config.*` / `webpack.config.*` / `next.config.*` …，或 `package.json` 有依赖或有 build/dev/start/serve 脚本 | 不渲染，摆一页说明 |
| 还没有首页 | 没有 `index.html` | 「等它写出来，这里会自动刷新」 |

判定在 `services/preview-kind.ts`，**每次刷新前重新算**——工作区一直在变，
上一轮还是个单页面、这一轮模型加了个 `server.js`，右栏就该跟着换。

### 12.2 为什么「要先构建」也归进不渲染

用户定的规则是「前后端项目不预览，单 html 应用渲染」。但中间还有第三类：
Vite / Next 这种**纯前端、却要先构建**的项目。它的 `index.html` 里写的是
`<script type="module" src="/src/main.tsx">`，直接伺服出去浏览器拿到的是一份
没编译过的源码，当场白屏。

它按字面不算"前后端项目"，但按后果和前后端项目是同一类：**伺服出去不是那个
页面**。所以归进不渲染，只是说明文案分开写——不然人看到白屏会以为是预览坏了。

### 12.3 为什么不渲染时摆说明，而不是摆骨架屏

骨架屏的意思是「正在加载」。而这里不是加载中，是平台**决定不渲染它**。摆骨架
等于让人一直等一个永远不会来的东西。白屏更糟：人会以为预览坏了，或者以为模型
写的东西有问题，两个方向都是错的。

所以那块地方写明三件事：是哪一类（带服务端 / 要构建）、为什么不渲染、下一步
干什么（发布之后在正式地址上看；服务端另外在控制台「后端与数据」里开）。
判据（`signals`）也一并列出来，让人能自己核对判定对不对，而不是只能信结论。

### 12.4 模型那边也要知道

`hasLivePreview` 不再只看"有没有预览会话"，还要看**这个工作区是不是真在渲染**
（`detectKind(...) === 'static'`）。否则带服务端的项目里，右栏摆着一页说明，
而系统提示还在对模型说「你每写完一个文件它就刷新一次」——它会照着一个根本不
存在的反馈回路去安排工作。

### 12.5 这条边界省掉了什么

一行基础设施都没新增：没有新容器、没有 docker socket、没有 sidecar、没有新的
网络出口策略、没有容器清理任务。§6 权衡过的那一整套代价全部不用付。

代价是带服务端的作品在发布前看不见。这是明说的边界，不是没做完的功能——
界面上那页说明就是在说这件事。

### 12.6 用例

`preview-kind.test.ts`（20 条）钉住判定边界：纯 HTML/three.js 是 static；
八种服务端信号与三种构建信号各自命中；`package.json` 只写名字版本**不算**信号
（它可能只是一份元数据），有依赖或有脚本才算；坏掉的 `package.json` 当它不存在
（一个坏文件不该改变判定）；两类信号都有时服务端压过构建。

`preview-access.test.ts` 另有两条钉住「判定真的影响了出什么」：工作区里出现
`server.js` 之后根文档出的是说明而不是那个半截页面，以及 kind 接口的鉴权。

---

## 13. 凭据从 cookie 挪进路径（改过一次的判据）

**这一节记的是一个会让整个功能形同虚设、而单测照不出来的问题。**

### 13.1 症状

线上「为你推荐」里的页面全是**一页裸 HTML**：蓝色下划线链接、默认字体、
图片裂掉。不是个别作品做得差——凡是把样式放在独立文件里的页面都这样，
也就是绝大多数。

### 13.2 原因

一条四步的链子，每一步单看都是对的：

1. 预览 iframe **不给 `allow-same-origin`**（给了等于没有沙箱）。
2. 于是 iframe 里的文档是 **opaque origin**。
3. 浏览器把 opaque origin 文档**自己发出的**子资源请求当作**跨站**；而会话
   cookie 是 `SameSite=Lax`，跨站不带。
4. 而 `/{owner}/{slug}/` 下**连 CSS 和图片都要过 forward_auth**。

结果：HTML 进得来（那一跳由**父页面**发起，带得上 cookie），它引用的每一个
CSS、字体、图片都被 302 到登录页。

**工作区预览是同一个病**，而且是刚上线的时候就带着的：原先
`/deploy/api/preview/{id}/...` 对每个请求都 `requireAuth`，子资源一律 401。
用例没照出来，因为它们用 `app.inject`——那模拟不了浏览器的 SameSite 行为。

### 13.3 证据

- 那个页面引的是相对路径 `./assets/style.*.css`，写法没问题；文件也在，
  115 KB 躺在 `/srv/sites/.../assets/` 下。
- 匿名请求 HTML 与 CSS **都返回 302**——这条路径下的一切都要登录。
- deploy-service 当时 40 分钟内有 **26 个 302**，而我自己的 curl 只占 6 个。
- 截图里 iframe 顶上那条平台 chrome 显示的是**「登录」按钮**——shell.js 自己
  的接口调用同样没带上身份，和 CSS 是同一个原因。

### 13.4 改法：凭据放进路径

| | 原先 | 现在 |
|---|---|---|
| 工作区预览 | `/deploy/api/preview/{id}/...`，每个请求 `requireAuth` | 同一条路径，**文件请求不再要 cookie**；`previewId` 本身就是凭据 |
| 已发布页面试玩 | iframe 直接装 `/{owner}/{slug}/` | 新增 `/deploy/api/play/{token}/...`；换令牌时判一次可见性 |

相对路径的子资源天然继承这个前缀，于是一个 cookie 都不需要。

**代价写在明处**：拿到完整地址的人就能看。对冲的是四条——

- id / token 是 **24 字节（192 位熵）**，和会话令牌同一个量级，猜不出来；
- 预览最长 60 分钟、闲置 15 分钟；试玩最长 30 分钟、闲置 10 分钟；
- 响应带 **`Referrer-Policy: no-referrer`**：地址里带着凭据，而页面里只要有
  一条外链，默认的 Referer 就会把整条地址送到对方站点去。这一行把它堵死；
- **换钥匙那一步仍然要登录**，而且试玩要过和 Caddy forward_auth 同一个
  可见性判定。

### 13.5 顺带收掉的两件事

**可见性判定只剩一份。** 抽成 `services/app-access.ts`，`routes/authz.ts` 与
`routes/play.ts` 共用。访问控制有两份实现，迟早有一份落后——而落后的那份
不会报错，它只是多放进来一些人。

**试玩里摘掉平台 chrome。** `shell.js` 那条是给真正打开页面的人用的；嵌在
详情页那张小预览框里它只会碍事，而且它在沙箱里调不到接口，于是永远显示一颗
「登录」按钮，看的人以为自己掉线了。只在试玩这条路上摘，发布产物一个字节不改。

### 13.6 用例

`play-access.test.ts`（15 条）与 `preview-access.test.ts` 里新增的三条，
核心都是同一句话：**子资源不带任何 cookie 也要出得来**。这条看着像细节，
其实是这次改动的全部理由——哪天有人"顺手"把 `requireAuth` 加回文件路由，
它必须当场红。

另有：换令牌要登录、别人的私有页面换不到、停用与不存在同一句话、
`owner`/`slug` 不合法不会被拼进路径、软链出去的站点根照样伺服得了
（`/srv/sites/{user}/{slug}` 本身就是指向 releases 的软链）、越界 403、
每人 16 张的淘汰、同一人同一作品续用同一张。

### 13.7 仍然没验到的

**还是没在真浏览器里端到端走通。** 内置浏览器会把沙箱文档发出的子框架与
子资源请求一律拦掉（`net::ERR_BLOCKED_BY_CLIENT`），所以连"重现原来的
bug"都做不到，更不用说验证修好了。这次的判断依据是线上日志、服务端响应和
截图里的三处互相印证，不是浏览器实测。
