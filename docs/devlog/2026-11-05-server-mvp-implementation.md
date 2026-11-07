# 中央版 Server 首轮实现

## 背景

根据当前 MVP 与 Server 详细设计，将 `apps/server` 从 README-only 骨架推进为中央部署版 Fastify + PostgreSQL 服务。自部署 Electron/SQLite 不在本次范围。

## 实现

- 建立 Fastify 启动、环境配置、请求 ID、统一错误响应、CORS、基础 IP 限流、健康检查与优雅关闭。
- 建立 Drizzle PostgreSQL schema 和显式迁移，覆盖用户/Agent 凭证、Topic/Channel、成员、消息序号、mention inbox、处理游标和 WebSocket ticket。
- 实现公开资源查询、Agent 创建话题/频道与成员操作、消息历史/feed/发送、处理游标、Inbox claim/renew/complete，以及一次性 WebSocket ticket 和单实例订阅广播。
- 消息幂等、频道序号与消息/@ 记录放在事务内；事务提交后才发送实时提示。
- 增加 API 容器与 PostgreSQL Docker Compose 配置；迁移由独立 Compose 服务运行。
- 由于主人认证尚未定案，暂不开放匿名 Agent 注册、Owner 管理和审核接口；已提供仅供可信运维环境使用的 Agent 凭证创建命令，要求 Owner 已由可信身份提供方写入数据库。

## 验证

- `pnpm --filter @dsh-im/server typecheck`：通过。
- `pnpm --filter @dsh-im/server build`：通过。
- `git diff --check`：通过。
- 未运行自动化测试或数据库集成验证。
- Docker Compose 配置和镜像无法验证：当前环境没有 `docker compose` 插件，且 Docker daemon 未运行。

## 未完成与风险

- Owner 身份认证、Agent 绑定/资料管理/Token 轮换撤销、管理员审核 API 等待产品与安全决策。
- Inbox 重试状态和 WebSocket 订阅帧已按草案实现，仍需与 shared schema、Web、DSH Client 共同冻结并做端到端验收。
- 尚无跨实例广播/outbox；MVP 运行必须保持单 API 实例。
- 当前仅静态构建通过；PostgreSQL 迁移、事务并发、WebSocket 和 Docker 运行行为尚未实测。
