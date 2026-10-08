# 部署与开发

所有命令均从仓库根目录运行。

## 前置条件

推荐直接使用 Docker Compose：

- Docker Desktop，或 macOS 上的 Colima；
- Docker Compose v2，或独立的 `docker-compose`；
- 至少为容器预留约 4 GB 内存。

本地开发还需要：

- Node.js `>=22.19.0`，推荐 Node.js 24；
- pnpm `11.22.0`；
- PostgreSQL 16 + pgvector；
- Redis 7。

启用仓库声明的 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
```

## 配置

复制配置模板：

```bash
cp .env.example .env
chmod 600 .env
```

### 必需配置

| 变量 | 说明 | 示例/默认值 |
|---|---|---|
| `DATABASE_URL` | Prisma PostgreSQL 连接 | Compose 内使用主机名 `postgres` |
| `REDIS_URL` | BullMQ 与分布式锁 | Compose 内使用 `redis://redis:6379` |
| `JWT_ACCESS_SECRET` | Access Token 签名密钥 | 至少 32 个随机字符 |
| `JWT_REFRESH_SECRET` | Refresh Token 签名密钥 | 至少 32 个随机字符，不能与 Access 相同 |
| `STORAGE_ROOT` | API、Worker、备份共用的绝对路径；不接受相对路径 | Compose 中为 `/app/data/uploads` |
| `LLM_BASE_URL` | OpenAI-compatible API 根地址 | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `LLM_API_KEY` | 模型密钥 | 仅写入本机 `.env` |
| `LLM_MODEL` | 模型 ID | `glm-5.3` |
| `WEB_ORIGIN` | CORS 允许的 Web 地址 | `http://localhost:3000` |

不要把真实密钥写入 README、`.env.example`、源码、测试快照或日志。`.env` 已被 `.gitignore` 排除。

### Agent 与超时

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `LLM_TIMEOUT_MS` | `180000` | 单次 Provider 调用硬超时 |
| `LLM_MAX_RETRIES` | `2` | Provider 临时错误重试数 |
| `LLM_MAX_RETRY_DELAY_MS` | `30000` | 最大重试等待时间 |
| `PI_AGENT_THINKING_LEVEL` | `medium` | Pi Agent 思考等级 |
| `PI_AGENT_MAX_TOOL_TURNS` | `8` | 单次 Run 最大工具轮次 |
| `PI_AGENT_TOOL_EXECUTION` | `parallel` | 默认工具执行方式；副作用工具单独强制串行 |
| `PI_AGENT_VERSION` | `0.87.1` | 运行时基线标识 |
| `MEETING_UPLOAD_DEBOUNCE_MS` | `2000` | 同批 TXT 自动分析防抖窗口 |

### 可选 Embedding

```dotenv
EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
```

三项全部留空时使用 BM25；三项完整配置后使用向量 + BM25 + RRF。部分配置会在启动时拒绝，以便及时发现错误；运行中向量服务异常会回退 BM25。

### 联网搜索

默认关闭：

```dotenv
SEARCH_ENABLED=false
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=
```

无真实 Key 时可使用确定性 Mock：

```dotenv
SEARCH_ENABLED=true
SEARCH_PROVIDER=mock
```

### 邮件

默认关闭：

```dotenv
SMTP_ENABLED=false
SMTP_PROVIDER=smtp
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
SMTP_TO=
```

本地验证可使用：

```dotenv
SMTP_ENABLED=true
SMTP_PROVIDER=mock
SMTP_TO=demo@example.test
```

Mock 不会发送真实邮件。

### 可选视觉模型

```dotenv
VISION_ENABLED=false
VISION_BASE_URL=
VISION_API_KEY=
VISION_MODEL=
```

视觉能力是扩展接口，默认关闭。

## Docker Compose 启动

### 最短上手路径

```bash
make setup
# 编辑 .env，替换两个 JWT Secret；填写模型配置并设置 LLM_ENABLED=true 以启用 AI
make up
make ps
```

然后访问 <http://localhost:3000>。常用命令可通过 `make help` 查看。

### 标准 Docker 环境

```bash
docker compose up -d --build
```

如果环境仍使用独立命令：

```bash
docker-compose up -d --build
```

访问：

- Web：<http://localhost:3000>
- Liveness：<http://localhost:3001/api/health/live>
- Readiness：<http://localhost:3001/api/health/ready>
- 能力开关：<http://localhost:3001/api/health/capabilities>

### Colima

```bash
colima start
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock docker-compose up -d --build
```

检查状态：

```bash
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock docker-compose ps
```

也可以让 Makefile 使用指定的 Compose 命令和 Docker Host：

```bash
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock \
  make up
```

Makefile 会自动选择 `docker compose` 或 `docker-compose`；如需强制指定，仍可传入
`COMPOSE=docker-compose`。Colima 默认只共享用户目录，因此请将仓库克隆到
`$HOME` 下（例如 `$HOME/workspace/out-brain`），不要从 `/tmp` 启动挂载了本地文件的服务。

### 日志

```bash
docker compose logs -f api worker web
docker compose logs -f postgres redis
```

后台任务日志为结构化 JSON，包含 `traceId`、不可逆用户标识、资源、任务类型、状态、耗时、尝试次数和错误码，不记录提示词正文或凭据。

### 停止与清理

保留数据库及上传文件：

```bash
docker compose down
```

同时永久删除数据库、上传文件和 PPTX：

```bash
docker compose down -v
```

请勿在需要保留演示数据时使用 `-v`。

## 本地开发

### Windows 一键运行（无需 Docker）

在 Windows PowerShell 中，先安装 Node.js 24、pnpm 11.22.0，以及带有
“使用 C++ 的桌面开发”组件的 Visual Studio 2022（首次编译 pgvector 需要）。
配置脚本使用 Windows 自带的 `curl.exe` 和 `tar.exe`，无需安装系统服务。

首次配置可双击项目根目录的 `start.cmd`，选择“3. First-time setup”，也可执行：

```powershell
pnpm setup:local
```

脚本会安装项目依赖，并将 PostgreSQL 16.15、pgvector 0.8.6 和 Redis 7.2.16
配置到项目的 `.local` 目录。PostgreSQL 使用
[EDB 官方发行包](https://www.enterprisedb.com/download-postgresql-binaries)，
pgvector 从[官方源码](https://github.com/pgvector/pgvector)编译，
Redis 使用 [redis-windows 社区维护的 Windows 便携构建](https://github.com/redis-windows/redis-windows)，
用于本地开发。下载文件均校验固定 SHA256。

首次运行会生成根目录 `.env`，使用随机数据库密码和两个不同的 JWT 密钥；
已有 `.env` 会保留。该方式的 `DATABASE_URL` 和 `REDIS_URL` 必须指向本机，
不要保留 Compose 模板中的 `postgres`、`redis` 主机名。

编辑根目录 `.env`，填写 `LLM_API_KEY`、设置 `LLM_ENABLED=true`，并确认 `LLM_BASE_URL`、`LLM_MODEL`
与实际账号一致。保留 `LLM_ENABLED=false` 时可以使用页面、注册登录和基础服务；启用模型但缺少 Key 时启动会明确报错。

Windows 启动器也支持项目目录外的 `%LOCALAPPDATA%\NBBOSS\provider.json`：
其中 `baseUrl`、`model` 指定模型服务，`apiKeyDpapi` 保存由当前 Windows 用户通过
`ConvertFrom-SecureString`（不指定 `-Key`）生成的加密密钥。
存在此配置时，它会覆盖 API 和 Worker 的模型配置；密钥仅在启动时注入这两个进程，
不会写入项目 `.env`，也不会注入前端或构建进程。修改此配置后先停止再启动项目。
DPAPI 加密配置不能直接拷贝给其他 Windows 用户使用。

以后双击 `start.cmd`，或运行：

```powershell
pnpm start:local
```

启动脚本会构建共享模块和 API、应用数据库迁移，并在后台启动 PostgreSQL、Redis、
API、Worker 和 Vite；就绪后打开 <http://localhost:3000>。首次进入页面需要注册账号。
关闭启动窗口或浏览器不会停止后台服务。默认端口为 3000、3001、5432、6379；
若端口已被其他程序占用，脚本会报错，不会停止或接管其他程序。

停止时在 `start.cmd` 菜单选择“2. Stop application”，或运行：

```powershell
pnpm stop:local
```

停止会保留数据库、Redis 和上传数据。修改 `.env` 或 API 源码后需要先停止再启动；
前端源码由 Vite 自动热更新。重复执行启动命令会复用已由本项目启动的服务。

路径说明：

- 配置：`.env`（不要提交或分享真实密钥）
- 服务日志：`.local/logs/`（API/Worker/Web 各有 `stdout.log`、`stderr.log`）
- 数据库：`.local/data/postgres/`
- Redis 数据：`.local/data/redis/`
- 上传和生成文件：`data/uploads/`

`.local`、`.env` 和数据目录均已排除 Git 提交；`.local` 也已排除 Docker 构建。
不要删除 `.local/data`，其中包含本地业务数据。

### 安装依赖

```bash
pnpm install --frozen-lockfile
pnpm db:generate
```

### 启动基础设施

```bash
docker compose up -d postgres redis
```

如果 API/Worker 在宿主机运行，`.env` 中连接地址应使用宿主机端口：

```dotenv
DATABASE_URL=postgresql://nbboss:nbboss@localhost:5432/nbboss?schema=public
REDIS_URL=redis://localhost:6379
STORAGE_ROOT=/absolute/path/to/out-brain/data/uploads
```

执行迁移：

```bash
pnpm db:migrate
```

### 启动 API、Web 和 Worker

终端一：

```bash
pnpm --filter @nbboss/api dev
```

终端二：

```bash
pnpm --filter @nbboss/web dev
```

终端三：

```bash
WORKER_MODE=true pnpm --filter @nbboss/api dev
```

也可使用：

```bash
pnpm dev
```

该命令启动 API 和 Web，Worker 仍需单独启动。

## 数据库与迁移

Prisma Schema 位于：

```text
apps/api/prisma/schema.prisma
```

开发环境创建迁移：

```bash
pnpm --filter @nbboss/api exec prisma migrate dev --name <migration_name>
```

重新生成 Client：

```bash
pnpm db:generate
```

生产式/Compose 启动使用：

```bash
pnpm --filter @nbboss/api exec prisma migrate deploy
```

不要使用 `prisma db push` 代替正式迁移提交。新增跨实体关联时，除了服务层用户 Scope，还应评估是否需要数据库级租户完整性约束。

## 测试

### 静态检查与单元测试

```bash
pnpm -r typecheck
pnpm -r test
```

覆盖共享契约、风险 Schema、检索排序、Adapter、Pi Agent 事件、工具失败、最大轮次、中止、Provider 超时/限流、记忆冲突、日期/颜色规范化等。

### 集成测试

先启动完整 Compose 环境，然后执行：

```bash
set -a
source .env
set +a
pnpm test:integration
```

覆盖真实 PostgreSQL/Redis/API/Worker、Refresh Rotation、IDOR、数据库租户约束、文件生命周期、200 页 PDF、BM25、多 PDF 引用、会议缓存、记忆删除竞态、PPT 并发版本和 10 用户并发。

### E2E

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Playwright 默认访问 `http://localhost:3000`，覆盖注册、会话模式、未登录跳转、上传、工具状态、待办、记忆、PPT 编辑和 1050px 桌面断点。

## 安全要求

- 密码必须使用 Argon2id；
- Refresh Token 数据库只保存 SHA-256 哈希；
- Access/Refresh Token 使用 HttpOnly、SameSite Cookie；
- 所有资源查询必须包含当前用户 Scope；
- 上传必须同时校验扩展名、MIME、大小、PDF 签名和 TXT UTF-8；
- 文件磁盘名必须使用随机 UUID；
- 日志不得写入密码、Cookie、Token、API Key、完整提示词或完整用户文件；
- Provider 原始错误不得直接返回给浏览器；
- `.env` 权限建议保持 `0600`；
- 如果密钥曾通过聊天、截图或其他非密钥渠道暴露，必须轮换。

## 故障排查

### API 不健康

```bash
docker compose ps
docker compose logs api postgres redis
curl -i http://localhost:3001/api/health/ready
```

### Worker 没有处理任务

```bash
docker compose logs worker redis
```

确认 API 与 Worker 使用同一镜像：

```bash
docker inspect out-brain-api-1 out-brain-worker-1 \
  --format '{{.Name}} {{.Image}} {{.State.Status}}'
```

### 文件一直处于 PROCESSING

检查 Worker、Redis 和上传 Volume；确认 API 与 Worker 都挂载到 `/app/data/uploads`。

### 模型请求失败

核对 `LLM_BASE_URL`、`LLM_MODEL` 和本机 `.env` 中的 Key。根据页面参考编号查询结构化日志，不要把真实 Key 粘贴到终端输出、Issue 或聊天中。

### 数据库 Schema 不一致

```bash
pnpm --filter @nbboss/api exec prisma migrate status
pnpm --filter @nbboss/api exec prisma migrate deploy
pnpm db:generate
```

### 清理失败任务（仅开发环境）

优先检查错误原因和修复代码，不要在生产环境直接清队列。开发环境确认数据可丢弃后，可通过 BullMQ API 或删除对应 Redis Volume 重置。

## 本机服务配置

Windows 可运行 `start.cmd configure` 配置服务；邮箱使用 SMTP 授权码。配置保存在当前用户的 `%LOCALAPPDATA%/NBBOSS/services.json`，由 DPAPI 加密，修改后重启 API 和 Worker。

`APP_TIME_ZONE=Asia/Shanghai` 控制模型相对日期的时间基准，支持有效 IANA 时区；无效配置回退 Asia/Shanghai。

## 运行与访问控制

启动时校验独立 JWT 密钥、数据库地址、外部服务必需项与额度；错误只显示变量名，不输出凭据。新环境默认 `LLM_ENABLED=false`，配置好模型后显式开启。`.env` 改动需重启 API 和 Worker；Windows 外部模型配置有效时会自动启用模型。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `REGISTRATION_ENABLED` | `true` | 首次建立账号后可改为 `false` 关闭自助注册 |
| `AUTH_RATE_LIMIT` | `100` | 每来源 IP 每 15 分钟认证请求上限，另有每用户名每操作 20 次限制 |
| `AI_DAILY_REQUEST_LIMIT` | `200` | 每账号每天 AI 入口请求数，UTC 零点重置；不是 Token 账单 |
| `USER_STORAGE_MB` | `1024` | 每账号原始上传文件总额度；生成文件不计入此额度，应监控磁盘 |
| `COOKIE_SECURE` | `false` | 本地 HTTP 使用 false，HTTPS 部署设 true |
| `TRUST_PROXY_HOPS` | `0` | 信任的反向代理层数 0–3；Compose API 固定 1 层，Nginx 覆盖来源 IP 头 |
| `WEB_BIND_ADDRESS` | `127.0.0.1` | Compose Web 端口绑定；公网使用独立 HTTPS 入口 |

生产设置 `NODE_ENV=production` 时必须同时设置 HTTPS 的 `WEB_ORIGIN` 与 `COOKIE_SECURE=true`。`WEB_ORIGIN` 必须是浏览器实际访问的唯一 Origin（协议、主机、端口，不含路径或结尾斜杠）。不要对公网直接暴露 API、数据库或 Redis；只有受控代理可以连接启用代理信任的 API。Compose 的数据库默认密码仅用于本地部署，正式环境须在数据库与 API/Worker 连接配置中一并替换。

`/api/health/ready` 只作为 API 基础依赖就绪检查，便于 Worker 依赖 API 启动；业务监控使用 `/api/health/system`，它还要求 Worker 心跳。Compose 已启用 Redis AOF、独立数据卷和自动重启。进程恢复无法替代数据备份；后台任务丢失时会显示失败并允许人工重试。

Windows 邮件窗口可勾选“启用邮件”，保存后重启生效，不会在保存时发送。通用企业 SMTP 可用 `.env` 或命令行配置；发件与收件配置各为一个邮箱。真实邮件连接与收件情况取决于部署环境，不由能力接口保证。

## 数据备份与恢复

仓库提供 `scripts/maintenance.mjs`，使用 PostgreSQL 原生自定义格式备份数据库，同时复制上传原件与 PPTX，生成 SHA256 完整性清单。凭据不进入备份。备份包含业务数据，目录应位于仓库外、限制读取权限，并按公司要求加密与保留。

工具需要 Node.js、已安装项目依赖和匹配版本的 Prisma Client。本地使用 PostgreSQL 16 的 `pg_dump` / `pg_restore`；Windows 自动使用 `.local/postgres/pgsql/bin`，其他环境可通过 `PG_BIN` 指定目录。Docker 模式使用容器内的数据库工具，宿主机通过 Compose 已绑定的本机端口连接数据库与 Redis。

备份必须暂停所有 API/Worker 写入实例。Windows：

```powershell
pnpm stop:app
# 等待 Worker 心跳过期（约 20 秒）；PostgreSQL 和 Redis 保持运行。
pnpm backup F:\backups\nbboss-20261007 local
pnpm start:local
```

Docker：

```bash
docker compose stop web worker api
# 等待约 20 秒；保留 postgres/redis 运行和已创建的 API 容器。
pnpm backup /secure-backups/nbboss-20261007 docker
docker compose up -d
```

已有备份目录不会被覆盖。失败目录没有有效清单，不能作为可恢复备份。多机部署需先在所有节点停止写入，单机探测不能替代集群维护窗口。

恢复在**隔离的新环境**操作：准备启用 pgvector 的空 PostgreSQL 数据库、独立空 Redis、空上传目录，并将目标连接和存储路径注入环境变量或目标 `.env`。不要先启动应用或执行迁移，否则数据库已不为空。Docker 先 `up -d postgres redis`，再 `create api`，不启动 API/Worker；确保目标使用新项目名与新卷，并且本机数据库端口未被旧环境占用。

```bash
pnpm restore /secure-backups/nbboss-20261007 local
# Docker 目标则将最后一个参数改为 docker。
# 恢复成功后，再迁移并启动应用。
```

恢复拒绝覆盖非空数据库/Redis/上传目录，先校验所有备份文件，再导入数据并修正本机与 Docker 的文件路径差异。只使用与备份相同版本的项目恢复，成功后再升级迁移。数据库与文件无法跨介质原子恢复；任何阶段失败时保持目标停机，排除原因后重新准备空目标，不要直接启动部分恢复的数据。

恢复会吊销所有旧登录，并把历史待发/发送中邮件标为需人工核对，避免恢复快照后自动重复发信。恢复后先保持 `SMTP_ENABLED=false`，检查文件下载、会议记录和邮件状态，再按业务需要启用服务。Redis 队列不从快照重放；中断任务由 Worker 检查后显示可重试状态。

## 数据边界

当前系统以账号隔离数据，适合个人工作空间形式的内部部署。模型会接收本轮问题、必要会话上下文与相关文件/记忆片段；启用 Embedding 会向向量服务发送文本片段，联网搜索会向 Tavily 发送查询，邮件会把风险摘要发送到配置收件邮箱。公司资料部署应选择获准的服务与收件范围，必要时关闭联网和邮件。

组织级 SSO、角色审批、共享知识库、管理员重置密码及集中审计导出仍属于后续产品范围；不要把目前的账号隔离当作这些功能已经存在。日志保留期按 `LOG_RETENTION_DAYS` 配置，备份保留策略由部署方执行。
