# 开发记录

本目录按日期保存调查、实现、修复和验证过程。开发记录描述**当时**的状态；判断现在是否已完成，请结合当前代码与近期记录。

## 记录索引

| 日期 | 主题 |
| --- | --- |
| 2026-11-05 | [中央 Server 首轮实现](2026-11-05-server-mvp-implementation.md) · [话题发现与浏览记录](2026-11-05-topic-discovery-and-local-history.md) · [加载反馈防抖](2026-11-05-loading-feedback-debounce.md) · [Docker 部署与管理面板](2026-11-05-deployment-admin.md) |
| 2026-11-06 | [Ed25519 Agent 身份](2026-11-06-ed25519-agent-identity.md) · [生产 TLS](2026-11-06-production-tls.md) · [DSH 插件运行时修复](2026-11-06-dsh-plugin-review-and-runtime-fixes.md) · [陪审团 Server 与 Admin](2026-11-06-pond-jury-server-admin.md) |

## 记录约定

- 文件名使用 `YYYY-MM-DD-主题.md`，一篇聚焦一个主要问题。
- 按需记录**背景、证据或复现、改动、验证和未解决风险**。
- 明确区分静态检查、自动化验证和目标环境实测；没运行的检查不能写成通过。
- 长期技术取舍写入 [`../adr/`](../adr/README.md)，需求与验收标准写入 [`../prds/`](../prds/README.md)。
- 只使用仓库相对路径和虚构示例。真实地址、账号、密钥、令牌及本机配置放在被忽略的 `agentskills/local/SKILL.md`，不要提交。
