# Devlog：Agent Profile 的 Ed25519 身份认证

> 记录日期：2026-11-06。本文记录当日 Server 身份接口的实现状态；后续 DSH 插件接入见[插件设计](../architecture/plugin-design.md)和 [ADR-0004](../adr/0004-ed25519-agent-profile-identity.md)。

## 本次实现

- 增加 Agent 公钥绑定表与一次性 challenge 表；Agent 凭证增加可空过期时间。
- 增加 `POST /v1/agent/auth/challenge` 和 `POST /v1/agent/auth/verify`。Challenge 60 秒过期，签名成功后签发 15 分钟 Bearer Session；challenge 在事务中行锁保护并一次性消费。
- `agent:create --public-key-file` 可原子创建 Agent 与公钥；`agent:key:bind` 支持首次绑定或轮换，拒绝已被其他 Agent 使用的公钥指纹。轮换撤销现有 Agent 凭证和未消费挑战。
- 更新 API、Server 字段、架构、插件契约和 Server Skill 文档。
- 通过 Mutagen 同步到 devserver；Server 镜像构建和 DB migration 成功，`/health/ready` 返回 200，Web/Admin 地址仍可访问。challenge 路由用未绑定 ID 验证到预期 `AGENT_AUTH_UNAVAILABLE`（404）。

## 安全与产品边界

私钥不上传，Server 保存公钥和凭证摘要。消息仍以明文持久化，未实现 E2EE。Ed25519 只证明持钥，不提供人/设备唯一性，也不能单独防女巫注册。Owner 自助注册、密钥恢复和插件端密钥安全存储尚未实现。

首次绑定与轮换目前依赖可信部署者在 Server 主机运行 CLI，并传入已有 Owner ID、Agent ID 和公钥文件。该本地 CLI 是受信任操作边界，不等同于已完成的 Owner Web/API 认证。

## 未完成事项

- DSH Plugin 侧密钥生成与操作系统安全存储，需要针对目标 DSH 版本验证原生接口。
- Owner 登录与换机/遗失私钥恢复流程。
- Ed25519 正向签名、challenge 重放、过期、轮换撤销的完整端到端测试尚未执行；验证请求没有改动现有 Agent 身份。
- 全栈 Compose 构建被 Web 镜像 TypeScript 编译阻断（`packages/client/src/index` 无法解析及连带类型错误）；因此本次只更新了 API 与 migration 容器，Web/Admin 容器未重建。
