# NBBOSS AI 外脑 API

所有路径以 `/api` 为前缀。除健康检查和注册登录外，接口均要求同源 HttpOnly Cookie；服务端在每次查询中同时约束 `userId`，对无权资源统一返回 404，避免资源枚举。

## 认证

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| GET | `/auth/options` | - | 公开注册是否开放 |
| POST | `/auth/password` | `{currentPassword,newPassword}` | 修改密码，吊销全部旧 Access/Refresh 登录；新密码 8–128 位 |
| POST | `/auth/register` | `{username,password}` | 注册并签发 Access/Refresh Cookie |
| POST | `/auth/login` | `{username,password}` | 登录 |
| POST | `/auth/refresh` | - | Refresh Token 轮换 |
| POST | `/auth/logout` | - | 吊销 Refresh Token 并清 Cookie |

## 会话与 Agent

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/conversations` | 当前用户会话列表 |
| POST | `/conversations` | 创建 `{mode:"CHAT"|"MEETING",title?}`；模式不可修改 |
| GET | `/conversations/:id` | 可见消息（含已持久化联网来源）、文件状态、会议结果和 PPT 任务 |
| DELETE | `/conversations/:id` | 中止活跃 Agent 后级联删除数据库及存储目录 |
| POST | `/conversations/:id/messages` | 请求 `{content,webSearch}`，响应为 SSE |
| POST | `/conversations/:id/runs/:runId/abort` | 显式停止 Pi Agent Run |

SSE 的稳定内部事件为：`run.started`、`message.delta`、`message.completed`、`tool.started`、`tool.completed`、`run.completed`、`run.failed`、`run.aborted`。前端不依赖 Pi Agent 原始事件类型。

## 文件与 RAG

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/conversations/:id/files` | `multipart/form-data` 的 `file`；PDF 20 MB/200 页，TXT 5 MB |
| GET | `/files/:id` | 鉴权下载原始文件 |
| DELETE | `/files/:id` | 删除文件、页、分块和索引；会议来源变化时重新分析 |

处理状态通过会话详情中的 `files[].status` 获取：`PROCESSING`、`READY`、`FAILED`。扫描 PDF 返回 `FAILED` 及可理解原因。

## 会议、待办与记忆

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/conversations/:id/meetings` | 固定结构、风险证据、待办和邮件状态 |
| POST | `/conversations/:id/meetings/reanalyze` | 忽略文件级缓存完整重跑 |
| GET | `/todos?status=&owner=&dueFrom=&dueTo=` | 按状态、责任人和截止日期筛选 |
| PATCH | `/todos/:id` | 编辑标题、说明、责任人、截止时间或四态状态 |
| DELETE | `/todos/:id` | 删除待办 |
| GET | `/memories` | 实体、当前事实及历史版本 |
| PATCH | `/memories/facts/:id` | 创建用户修正版并保留旧版本 |
| DELETE | `/memories/:entityId` | 忘记实体并删除事实历史；保留抑制标记阻止迟到任务恢复 |

## PPT

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/conversations/:id/presentations` | 创建异步任务 `{prompt,idempotencyKey?}`，立即返回 PENDING Artifact；重复幂等键返回同一任务 |
| GET | `/presentations/:id/versions` | 任务及全部可编辑 Slide JSON 版本 |
| POST | `/presentations/:id/versions` | 保存 `{prompt,document}` 为不可变新版本 |
| GET | `/presentation-versions/:id/download` | 下载可编辑 PPTX |

会话详情中的 PPT 状态为 `PENDING`、`PROCESSING`、`READY`、`FAILED`，并包含 `progress`。

## 健康与能力

- `GET /health/live`
- `GET /health/ready`：检查 PostgreSQL 和 Redis，并返回 Worker 心跳与 online/offline 状态
- `GET /health/system`：检查数据库、Redis 和最近 30 秒内的 Worker 心跳，缺少任意项时失败
- `GET /health/capabilities`：返回 Search/SMTP/Embedding/Vision 是否可用，不泄露配置值

## 错误格式

```json
{"statusCode":400,"code":"VALIDATION_ERROR","message":["..."],"traceId":"uuid"}
```

未知内部错误只返回通用文案及 `traceId`；Provider 原始错误、密钥、Token、完整提示词和文件正文不会返回浏览器。


## 补充接口和字段

以下路径均以 `/api` 为前缀，需要登录且校验资源所属用户。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/conversations/:id/files/batch` | multipart `files`，最多 20 份；全部注册后再入队解析 |
| POST | `/files/:id/retry` | 对失败或部分完成的文件重试 |
| GET | `/memories/tasks` | 最近 100 个抽取任务状态；不返回保存的抽取原文 |
| POST | `/memories/tasks/:id/retry` | 重试所属用户的记忆任务 |
| POST | `/presentations/:id/retry` | 重试失败的 PPT 任务 |

会话文件可能为 `PARTIAL`，逐页返回 extractionMethod、qualityStatus、qualityMessage。记忆事实增加 kind（STATE/EVENT）、evidence、withdrawnAt，事件时间与观察时间分开。待办增加 editedFields 和 modelSuggestion；通知增加 CANCELLED 状态。

自动生成 PPT 的版本 previewMeta 包含材料文件 ID、sha256、状态和 parsedSha256；人工编辑版本不重新执行模型事实核对。聊天 SSE 必须收到 run.completed、run.failed 或 run.aborted；HTTP 200 后未收到终止事件即 EOF，前端按异常断流处理并查询后台状态。

## 自动联网与邮件重试协议

`POST /api/conversations/:id/messages` 的 `webSearch` 默认 `"auto"`，也接受 `"on"`、`"off"`；兼容旧客户端 `true`（开启）和 `false`（关闭）。自动模式识别时效性或明确联网请求，显式禁止联网优先。需检索但服务未配置/请求失败时返回 SSE `run.failed` 和明确提示，不以模型旧知识替代。空检索结果与服务失败不同，回答须说明未找到证据。

`POST /api/conversations/:conversationId/meetings/emails/:emailId/retry` 接受可选 JSON `{ "inboxChecked": true }`。不确定/部分投递未确认时返回 `{ "queued": false, "requiresInboxCheck": true, "reason": "..." }`；确认字段应在用户核对收件箱后提交。已发送或发送中的相同版本不会重复排队。

`GET /api/health/capabilities` 增加 `searchMode`、`mailMode`，取值 `disabled`、`mock`、`live`；live 表示已配置真实服务，不代表实时连通状态。Mock 邮件记录用 `errorCode: "MOCK_DELIVERY"` 区分，不等同于真实投递。

## 资源与请求限制

上传每批最多 20 文件、合计 50 MB，单个 PDF 20 MB、TXT 5 MB；整批校验并在同一事务内保存，重复内容不重复占用存储。账号原始上传额度默认 1024 MB。

登录、注册与改密按来源 IP 限流，登录/注册同时按用户名限流。AI 入口（消息、上传、重试与重分析）每账号每分钟最多 20 次、每天默认 200 次；按 UTC 日期重置，失败请求也计入。它是请求配额，不是模型 Token 计费。超限返回 429 和 `Retry-After`，限流服务故障返回 503；修改已有内容、停止生成和查看结果仍可用。浏览器跨来源写请求返回 403。
