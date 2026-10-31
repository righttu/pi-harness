# 变更记录

每次推送到 `main` 都在这里加一条：改了什么、为什么、对使用的影响。最新的在最上面。
commit 哈希对应 GitHub `righttu/pi-harness` 的提交。

## 项目约定

- **命名**：所有组件以 `pi` 开头。Cloudflare 资源名（Worker、网关、路由、变量）用小写 `pi-xxx`；
  代码里的类名用 `PiXxx`（JS 标识符不能带连字符）。给模型用的工具名（`read`、`subagent`…）不算组件，不加前缀。
- **部署**：推到 `main` 由 Workers Builds 自动部署。Dashboard 里设的普通变量靠 `keep_vars: true` 保留。
- **Worker 变量**：`CF_ACCOUNT_ID`（Text）、`CF_AIG_TOKEN`（Secret）、`PI_SIDE_ROUTE`（Text，可选，子代理走的路由名）。

---

## 未发布

### 修复
- Files 面板在新会话里报 `400 no such path: /workspace`。原因是还没写过文件时目录不存在；现在当作空目录显示 "Empty"。

### 新增
- **lead / sidekick 模型分层预埋**：Worker 变量 `PI_SIDE_ROUTE` 设为第二条动态路由名（如 `pi-side`）后，
  `subagent` 和 `subagents` 起的子对话走那条路由；主 Agent 仍走 `pi-route`。不设则行为不变。
  （`src/subagent.ts` / `src/subagents.ts` 改为工厂函数 `createSubagent` / `createSubagents`，接收子对话模型。）
- 本文件。

---

## 6f202a7 — 2026-10-31 — DO 改名 SessionIndex → PiSessionIndex

- 按命名规则改名。用迁移 `v3` 的 `renamed_classes` 改，已有数据保留。
- 影响：Dashboard → Durable Objects 里应看到 `PiAgent` 和 `PiSessionIndex` 两个 namespace。

## ab6b274 — 2026-10-31 — 会话目录上服务端、文件面板、并行子代理、上下文策略

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

## 1c45e07 — 2026-10-31 — 会话左栏、跟随滚动、真实子代理进度

- 会话列表从标题栏下拉改为左侧一列，每行可改名、可删除（不必先切过去）。第一条消息自动成为标题。
- 删除改为乐观更新，失败恢复。
- 自动滚动只在已在底部时跟随；往上翻历史不再被拉回；右下角 Follow / Latest 按钮回底部。
- `subagent` 工具用 `api.watchDoc(LiveDoc, child)` 盯子对话，把每次模型请求、每个工具开始/结束流到父对话卡片（`api.output()`），完成后步骤表进 `details.steps`。替换之前写死的三步占位。
- 工具卡片按 `callId` 匹配运行槽位（之前按名字且只对 live 消息生效，导致已提交消息里的工具调用永远显示 Called）。

## 0383c1b — 2026-10-31 — 子代理卡片

- `subagent` 工具调用/结果使用专门的卡片，显示任务、状态、子对话 id。（步骤条此时为占位，1c45e07 换成真实数据。）

## fc55c83 — 2026-10-31 — 保留 Dashboard 变量

- `wrangler.jsonc` 加 `keep_vars: true`。此前每次部署会清掉 Dashboard 设的普通变量（`CF_ACCOUNT_ID`），导致 401。Secret 不受影响。

## 1803af1 — 2026-10-31 — 会话列表 + 删除、前台子代理

- 客户端在 localStorage 维护会话目录，可切换、新建、删除当前会话。
- `DELETE /api/session/<uuid>` → `PiAgent.destroy()`：关 WebSocket、dispose、清 alarm、`storage.deleteAll()`、abort。
- 新增 `src/subagent.ts`：前台 `subagent` 工具，在同一 DO 内开子对话、等答案、返回。子对话不再拥有 `subagent` 工具。

## ba72daf — 2026-10-31 — 模型改走 AI Gateway /compat

- 不再用 Workers AI binding（它不能解析指向 custom provider 的动态路由，报 `no_model` / `model_error`）。
- 改为 Pi AI 自定义 provider，OpenAI 兼容协议打 `gateway.ai.cloudflare.com/v1/<账号>/pi-gateway/compat`，带 `cf-aig-authorization`。
- 需要 Worker 变量 `CF_ACCOUNT_ID`、`CF_AIG_TOKEN`。
