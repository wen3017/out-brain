# 架构与数据模型

前端使用 Vue 3、Vite、Vue Router 和 Pinia；后端使用 NestJS，API 与 Worker 独立运行。PostgreSQL 保存业务数据，Prisma 管理迁移，Redis/BullMQ 执行异步任务。Pi Agent Runtime 负责模型与工具调用，前端通过内部 SSE 事件接收执行状态。

## 代码分工

- `apps/web/src/views/`：会话、待办、记忆、日志、PPT 和登录页面。
- `apps/api/src/modules/`：按业务划分的控制器与服务。
- `apps/api/src/infra/`：数据库、缓存和后台任务。
- `packages/contracts/`：共享 Schema 与事件协议。
- `apps/api/prisma/`：数据库模型与增量迁移。

## Agent Runtime 开发约束

- Agent 入口必须经 `AgentRuntimePort`，Controller 和领域服务不得直接依赖 Pi 事件类型；
- 使用 Pi Agent 高层 `Agent` 类，不另建自定义循环；
- 自定义模型由 `PiModelsService` 注册为 OpenAI-compatible Provider；
- PostgreSQL transcript 用于恢复会话，Pi 不保存第二份业务真相；
- `beforeToolCall` 校验租户、资源归属、模式、功能开关和工具额度；
- `afterToolCall` 截断并脱敏返回内容；
- 浏览器只消费稳定的内部 SSE 事件；
- 有副作用的工具必须串行并带领域幂等键；
- Provider 错误、工具错误、中止、重启中断和最大轮次必须映射为不同状态。

当前主要领域工具：

- `retrieve_documents`
- `retrieve_memory`
- `search_web`
- `analyze_meeting`
- `generate_presentation`

会议结构化提交和 PPT 结构化提交同样由 Pi Agent + TypeBox 工具 Schema 驱动，进入领域层后再使用 Zod 严格校验。

## 后台任务与一致性

BullMQ 队列名为 `nbboss`，当前任务包括：

- `file.parse`
- `meeting.analyze`
- `memory.extract`
- `presentation.generate`

实现约束：

- TXT 同批上传通过延迟去重合并成一次分析；
- 相同会议文件快照的重复任务直接复用结果，避免重复待办和邮件；
- 确定性输入错误不进行无意义重试；
- Provider 临时错误有限重试；重试耗尽前领域状态保持处理中；
- 长模型任务使用覆盖 Provider 超时窗口的 BullMQ 锁；
- 来源删除后，迟到的文件和记忆任务必须安全结束，不能恢复孤儿数据；
- PPT 保存使用 Redis 锁生成连续、不可变版本；
- 会话/文件删除先原子移动到 trash，数据库成功后异步清理，数据库失败则恢复文件。

## 数据模型

PostgreSQL 是业务数据与 Pi Agent transcript 的唯一权威来源；Redis 只承担 BullMQ 和短期分布式锁。

- **User / RefreshToken**：账号与 Refresh Token 哈希。
- **Conversation**：用户归属、不可变模式、会议处理状态。
- **Message**：可见对话及隐藏的 Pi assistant/toolResult transcript；`metadata.piMessage` 用于精确恢复。
- **AgentRun / AgentEvent / ToolExecution**：Run 状态、事件顺序、工具审计、Token 用量和耗时。
- **FileAsset / DocumentPage / DocumentChunk**：随机路径原件、按页文本、带页码和字符偏移的分块、可选 pgvector。
- **Meeting / MeetingDocument / Risk / Todo / EmailDelivery**：会议聚合、缓存键、证据风险、AI 待办与邮件结果。
- **MemoryEntity / MemoryFact**：实体-属性-值事实链；`supersededById` 保留版本，`observedAt` 防止异步旧任务覆盖新值，`userEdited` 保护人工修正。
- **SearchRun**：一次回答可对应多次查询，保存查询、检索时间和来源。
- **ActivityLog**：按账号隔离的操作与任务日志，保存级别、分类、参考编号及受限元数据，按保留期限清理。
- **Presentation / PresentationVersion**：异步 Artifact 状态；Slide JSON 为源数据，PPTX 为每版不可变导出物。

所有用户资源通过 User→Conversation 或显式 `userId` 形成租户边界。除服务层所有查询都带用户范围外，数据库触发器还会拒绝 AgentRun/FileAsset/Todo 的冗余 `userId` 与父资源不一致，以及 MeetingDocument 跨会话关联。外键使用级联删除；会话删除后还会递归删除对应随机存储目录。重新分析或删除会议来源时，会同步移除相应自动记忆并重建剩余历史链，用户手工修正不被静默删除。


数据库结构以 `apps/api/prisma/schema.prisma` 和迁移文件为准。接口见 [API 文档](api.md)，启动与维护见 [部署与开发](deployment.md)。
