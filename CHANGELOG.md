# 变更记录

每次推送到 `main` 都在这里加一条：改了什么、为什么、对使用的影响。最新的在最上面。
条目按日期 + 标题命名；对应的 commit 看 `git log`（标题就是 commit 第一行的中文说明）。
一次推送只含一个 commit——连推两个会让 Workers Builds 撞 Cloudflare API 限流（code 971）。

## 项目约定

- **命名**：所有组件以 `pi` 开头。Cloudflare 资源名（Worker、网关、路由、变量）用小写 `pi-xxx`；
  代码里的类名用 `PiXxx`（JS 标识符不能带连字符）。给模型用的工具名（`read`、`subagent`…）不算组件，不加前缀。
- **部署**：推到 `main` 由 Workers Builds 自动部署。Dashboard 里设的普通变量靠 `keep_vars: true` 保留。
- **配置分两处**：
  - **Dashboard 只放密钥**（Settings → Variables and Secrets）：`CF_ACCOUNT_ID`（必填）、`CF_AIG_TOKEN`（Secret，必填）、
    `PI_SHARE_SECRET`（Secret，可选：分享链接签名密钥，不设用 CF_AIG_TOKEN；单独设则换 AIG token 时旧链接不失效）。
  - **其余 `PI_*` 在右栏 Config 页改**，存 `PiSettings` DO，没改的用默认值。定义见 `src/settings.ts` 的 `SETTINGS`。
    Dashboard 里的 `PI_*` 变量不再参与（首次启动会一次性搬进应用内设置，之后可删）。
- **R2 桶**：`pi-files`。`shared/` 放发布的文件；`mount/` 下的对象只读挂到每个工作区的 `/workspace/r2`。

---

## 2026-10-31 — 设置两层化、Config 页重做

- 去掉"Dashboard 变量"这一层：`PI_*` 配置只有 应用内 > 默认 两层。`PiSettings` 首次启动把 Dashboard 里已有的 `PI_*` 一次性搬进来（标记 `__seeded__`），之后不再读。
- 设置项定义集中到 `src/settings.ts` 的 `SETTINGS`（名字、标签、类型、默认值、说明），服务端合并和前端表单都从它来。加设置项只改这里。
- Config 页：只显示可改项；输入框直接显示当前生效值；`PI_MODEL_INPUT`、`PI_MODEL_REASONING` 是下拉；数字项数字输入；改过的有"恢复默认"。保存时服务端校验（枚举、数字范围）。
- 密钥一行说明在 Dashboard，不再列出。

---

## 2026-10-31 — Config 页可编辑（应用内设置）

- 新 DO `PiSettings`（全局单例，迁移 v4）：key/value 存应用内改的 `PI_*` 配置。
- 优先级：应用内设置 > Dashboard 变量 > 默认值。Config 页每行可改、可清（清掉回退）。密钥和账号 id 仍只能在 Dashboard 设。
- `PATCH /api/config { key, value, object }`：保存后让当前会话对象 `refreshConfig()` 立刻重建模型 provider；其他对象下次启动时生效。
- 配置读取全部改为经过 `PiAgent.#config`：模型能力、价格、sidekick 路由（子代理创建时实时读）、fetch 白名单（每次调用实时读）、publish 的站点根。

---

## 2026-10-31 — 分享链接路由、Config 标签页

### 修复
- 分享链接 `/share/...` 打开是聊天页：`run_worker_first` 只放行了 `/api/*` 和 `/agents/*`，其余被前端 SPA 接管。补上 `/share/*`。**以后新加服务端路由都要补这里。**

### 新增
- 右栏 **Config** 标签页：列出全部 Worker 变量的名字、当前生效值、默认值、含义，标出哪些是已设、哪些用默认。换模型时照着加，不用翻代码或记忆。数据来自 `GET /api/config`（`server.ts` 的 `describeConfig`，加新变量时在那里补一条）。

---

## 2026-10-31 — publish 流长度修复

### 修复
- `publish` 报 `Provided readable stream must have a known length`：R2 `put()` 要求流有已知长度，工作区流没有。用 `FixedLengthStream(size)` 包一层。

---

## 2026-10-31 — 上传/下载流式、fetch 工具

### 上传 / 下载改流式
- `readFile` / `writeFile` RPC 直接传 `ReadableStream`（Workers RPC 原生支持，带流控，不受 32 MiB 限制）。文件不再进内存。
- 去掉下载 8 MiB、上传 20 MiB 上限。预览仍只取前 2 MiB（浏览器内联显示用）；点下载给整个文件。
- 单文件保留 512 MiB 防呆上限——工作区是 SQLite，真正的大文件应走 publish 到 R2。

### fetch 工具（`src/fetch-tool.ts`）
- 模型可以发 HTTP 请求：GET/POST/PUT/HEAD，返回状态、content-type 和正文。HTML 去标签只留文字；正文最多 64 KiB。
- `savePath` 参数：响应体直接流进工作区文件（下载 PDF、zip、数据集），不返回内联内容。
- 域名白名单 `PI_FETCH_ALLOW`（后缀匹配，默认 `*`）。超时 30 秒。只允许 http(s)。

---

## 2026-10-31 — R2 发布/分享、模型能力改为变量、聊天贴图

### R2（桶 `pi-files`，绑定 `PI_FILES`）
- 新工具 `publish(path, expiresSeconds?)`：把工作区文件**流式**复制到 R2 `shared/<uuid>/...`，返回带 HMAC 签名、会过期的链接（默认 24 h，最长 7 天）。系统提示要求产出文件时用它交付。
- Files 面板预览页加"分享链接"按钮，同一条路径，带复制。
- 下载路由 `GET /share/<key>?exp=&sig=`，从 R2 流式返回。**注意**：域名上开着 Access，收链接的人也要能登录；要公开分享需给 `/share/*` 加 Access bypass 策略。
- `/workspace/r2/`：只读挂载桶里 `mount/` 前缀，上限 64 MiB。挂载是 eager 的（启动时复制进 SQLite），只适合模板/参考资料，不适合大文件。
- 没用官方 `createAssets`（S3 预签名 URL）：它要再建一对 R2 S3 密钥；本方案不需要。以后要公开链接可切过去。

### 模型能力不再写死
- `input`（看不看图）、`contextWindow`、`maxTokens`、`reasoning` 改为变量 `PI_MODEL_INPUT` / `PI_CONTEXT_WINDOW` / `PI_MAX_TOKENS` / `PI_MODEL_REASONING`。换路由背后的模型只改变量。
- WebSocket `hello` 多一个 `vision` 字段告诉前端。

### 聊天贴图
- `PI_MODEL_INPUT=text,image` 时，输入框可粘贴/拖入图片（≤ 4 MB），随消息一起发；用户消息气泡显示图片。模型不支持时不显示入口。

---

## 2026-10-31 — 新会话 /workspace 不存在、Plan mode 提示

### 修复
- 新会话里模型的 `ls` / `find` 报 `no such path: /workspace`：对象启动时先 `mkdir /workspace`。之前只修了 Files 面板，没修模型这边。
- Plan mode 开着但还没出计划时，输入框上方显示一行提示，确认开关已生效。

---

## 2026-10-31 — 文件上传、会话分支、预览渲染、成本显示、Reviewer、Plan mode

### 文件上传
- Files 面板加上传按钮（可多选），传到当前目录，同名覆盖。`PUT /api/session/<uuid>/file?path=`，单文件上限 20 MiB。

### 会话分支（复制）
- 标题栏加"分支"按钮：在同一个 DO 里 `harness.sessions.fork()` 一个新 pi session，它看得到源会话到现在为止的全部历史，之后各走各的；工作区共享。
- 目录项 id 变为 `UUID` 或 `UUID:<pi session>`；`PiSessionIndex` 表加 `object / branch / parent` 列（启动时自动补列）。
- 左栏分支缩进显示在源会话下面。删根会话连带删它的分支；删分支只从目录移除（数据随源 DO）。
- `POST /api/session/<uuid>/fork?session=`、`DELETE /api/sessions/<sid>`。

### 预览渲染
- Files 预览：`.md` 用 Streamdown 渲染；代码文件按扩展名语法高亮；其他仍是纯文本。

### 成本显示
- 标题栏显示本会话 token：`12.3k in / 2.1k out`，悬停看明细。配置 `PI_PRICE_INPUT` / `PI_PRICE_OUTPUT` 后显示美元。
- 数据来自 pi 的 `UsageDoc`，`GET /api/session/<uuid>/state`，载入和每轮结束刷新。

### Reviewer（`src/quality.ts`）
- 新工具 `review(summary, files)`：开一个只读子对话（read/ls/find/grep），角色是审查员，默认用 sidekick 模型；有"再看一遍"循环（最多 3 轮），直到说 "No further findings."。发现列表返回主 Agent。
- 系统提示要求：写完或改完代码先 review 再汇报，修掉发现的问题。
- 前端用和 subagent 一样的卡片展示，Findings 按 Markdown 渲染。

### Plan mode（`src/quality.ts`）
- 标题栏 Plan 开关。开着时主对话只有只读工具和 `submit_plan`，系统提示要求"先读、出计划、什么都别改"。
- 模型提交计划后，输入框上方显示计划卡片，点 "Execute plan" 关掉 plan mode 并让模型按计划执行；或输入修改意见让它重出。
- `POST /api/session/<uuid>/plan { on }`。默认扩展集现在显式写为 playground / subagent / subagents / review，否则 Plan 的系统提示会常驻。

---

## 2026-10-31 — Files 空目录修复、sidekick 路由预埋、变更记录

### 修复
- Files 面板在新会话里报 `400 no such path: /workspace`。原因是还没写过文件时目录不存在；现在当作空目录显示 "Empty"。

### 新增
- **lead / sidekick 模型分层预埋**：Worker 变量 `PI_SIDE_ROUTE` 设为第二条动态路由名（如 `pi-side`）后，
  `subagent` 和 `subagents` 起的子对话走那条路由；主 Agent 仍走 `pi-route`。不设则行为不变。
  （`src/subagent.ts` / `src/subagents.ts` 改为工厂函数 `createSubagent` / `createSubagents`，接收子对话模型。）
- 本文件。

---

## 2026-10-31 — DO 改名 SessionIndex → PiSessionIndex

- 按命名规则改名。用迁移 `v3` 的 `renamed_classes` 改，已有数据保留。
- 影响：Dashboard → Durable Objects 里应看到 `PiAgent` 和 `PiSessionIndex` 两个 namespace。

## 2026-10-31 — 会话目录上服务端、文件面板、并行子代理、上下文策略

### 会话目录存服务端（`src/sessions.ts`）
- 新增 DO `PiSessionIndex`（当时叫 SessionIndex），SQLite 一张表存会话列表。
- 路由 `GET/POST /api/sessions`、`PATCH /api/sessions/<id>`；`DELETE /api/session/<id>` 顺带从目录移除。
- 目录按用户隔离：owner 取 Cloudflare Access 注入的 `Cf-Access-Authenticated-User-Email`；没有 Access 时共用 `public`。
- 客户端首次加载把 localStorage 旧目录 POST 上去迁移，之后以服务端为准；服务端不可用退回本地缓存。
- 影响：换浏览器、清缓存后会话列表还在。

### 文件面板
- 右栏改为 **Files | Tools** 两个标签页。Files 浏览 `/workspace`，文本/图片内联预览，其他类型下载。每轮结束自动刷新。
- 后端 `PiAgent.listFiles()` / `readFile()` RPC，路径限定在 `/workspace` 内；`GET /api/session/<id>/files`、`/file`。

### 并行子代理（`src/subagents.ts`）
- 新工具 `subagents`：`spawn` / `send` / `stop` / `status`。父对话派完立刻返回，子代理答案以消息 `[subagent <name> answered] …` 送回，前端渲染为报告卡片。
- 适配 pi-durable 官方示例 `22-subagent-background.ts`：Anchor + Reporter 后台任务，DO 重启后续跑，requestId 防重复。
- 原阻塞式 `subagent` 保留。

### 上下文与工作方式
- compaction 显式配置：128k 窗口，超 112k 阻塞压缩，超 80k 后台先压，最近 24k 原样保留。`CONTEXT_WINDOW` 常量独立出来，换小窗口模型要改。
- `read` 上限 256 KiB → 48 KiB / 1200 行；`exec` 输出 32 KiB。防止一次读大文件撑爆上下文。
- `toolExecution: "parallel"`：一轮多个独立工具调用并行。
- 系统提示加工作规则：先 ls 再动手、改前先 read、大文件分段、分步汇报、失败说明、何时用哪种子代理、收尾总结。
- Steer 按钮悬停说明；运行中 placeholder 改为 `Enter: queue · Steer: interrupt`。

## 2026-10-31 — 会话左栏、跟随滚动、真实子代理进度

- 会话列表从标题栏下拉改为左侧一列，每行可改名、可删除（不必先切过去）。第一条消息自动成为标题。
- 删除改为乐观更新，失败恢复。
- 自动滚动只在已在底部时跟随；往上翻历史不再被拉回；右下角 Follow / Latest 按钮回底部。
- `subagent` 工具用 `api.watchDoc(LiveDoc, child)` 盯子对话，把每次模型请求、每个工具开始/结束流到父对话卡片（`api.output()`），完成后步骤表进 `details.steps`。替换之前写死的三步占位。
- 工具卡片按 `callId` 匹配运行槽位（之前按名字且只对 live 消息生效，导致已提交消息里的工具调用永远显示 Called）。

## 2026-10-31 — 子代理卡片

- `subagent` 工具调用/结果使用专门的卡片，显示任务、状态、子对话 id。（步骤条此时为占位，1c45e07 换成真实数据。）

## 2026-10-31 — 保留 Dashboard 变量

- `wrangler.jsonc` 加 `keep_vars: true`。此前每次部署会清掉 Dashboard 设的普通变量（`CF_ACCOUNT_ID`），导致 401。Secret 不受影响。

## 2026-10-31 — 会话列表 + 删除、前台子代理

- 客户端在 localStorage 维护会话目录，可切换、新建、删除当前会话。
- `DELETE /api/session/<uuid>` → `PiAgent.destroy()`：关 WebSocket、dispose、清 alarm、`storage.deleteAll()`、abort。
- 新增 `src/subagent.ts`：前台 `subagent` 工具，在同一 DO 内开子对话、等答案、返回。子对话不再拥有 `subagent` 工具。

## 2026-10-31 — 模型改走 AI Gateway /compat

- 不再用 Workers AI binding（它不能解析指向 custom provider 的动态路由，报 `no_model` / `model_error`）。
- 改为 Pi AI 自定义 provider，OpenAI 兼容协议打 `gateway.ai.cloudflare.com/v1/<账号>/pi-gateway/compat`，带 `cf-aig-authorization`。
- 需要 Worker 变量 `CF_ACCOUNT_ID`、`CF_AIG_TOKEN`。
