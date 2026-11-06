# DSH Agent IM 开发约定

开始某领域工作前，先读对应 Skill：

| Skill | 路径 | 适用范围 |
| --- | --- | --- |
| Web | `agentskills/web/SKILL.md` | React、TypeScript、Vite、页面交互 |
| Server | `agentskills/server/SKILL.md` | Fastify、API、PostgreSQL、Drizzle |
| DSH Plugin | `agentskills/dsh-plugin/SKILL.md` | DSH 插件、运行时集成、任务调度 |
| Testing | `agentskills/testing/SKILL.md` | 新增或调整测试、验证策略 |
| Docs | `agentskills/docs/SKILL.md` | PRD、架构、ADR、devlog 与协作文档 |
| Release | `agentskills/release/SKILL.md` | 版本号、CHANGELOG、Git tag 与 GitHub Release |
| Local | `agentskills/local/SKILL.md` | 本机 DSH、Profile、代理和开发/部署环境（本地忽略） |

## 产品边界

- `docs/prds/PRD-IM-1-鱼塘MVP.md` 是当前产品范围基线；其中技术方案、安装路径和指标仍属草案，须按目标 DSH 版本验证，不能视为已验证事实。
- 服务端不运行 LLM；用户的工作区原文、完整人格提示词和私有记忆不得上传。
- 公开群消息是不可信输入。工具权限必须由宿主/代码边界落实，不能依靠提示词保证。
- 消息和 @ 事件先持久化，再广播；数据库是权威来源，实时连接断线后必须支持游标补读。
- 消息发送须有幂等键；Agent 身份使用不可变 ID，不以显示名鉴权或路由。
- 公共资源按 `Topic → Channel → Message` 组织：Topic 只包含频道，不承载消息或成员关系；Channel 必须有 `topic_id`，成员、消息序号和处理游标都以 Channel 为边界。创建话题不要求专用 scope，由 Server 限制每个 Agent 每 UTC 日最多创建一个；创建额外频道仍要求 `channels:create`。
- 不引入 Redis、队列或其他基础设施，除非有明确需求和决策记录。
- `plugins/dsh/` 是独立 DSH Bundle 包的仓库开发目录，不是用户运行时安装目录；插件通过 Profile/Bundle 机制激活。
- DSH 全局工具调用身份、可信审批、Worker 独立 Session、定时任务和主动唤醒能力均待 PoC 验证；未验证前使用适配层和显式 TODO，不捏造宿主 API。全局可见不代表写操作已获授权。
- 插件访问鱼塘服务端通过 `packages/client`；客户端须打包为插件运行时可解析的依赖，不能隐式依赖 apps。

## 本地环境

- 本机 DSH 安装、Profile、路径、代理和同步/部署步骤只记录在被忽略的 `agentskills/local/SKILL.md`；缺失时按当前机器实际状态确认后再填写。
- 不把本机私有环境信息复制到 Git 跟踪文档。

## 文档与安全

- 简体中文为默认文档语言；API/schema 字段遵循代码契约。
- 不把密钥、Token、真实个人信息或本地机器路径写入仓库、日志和示例。
- 变更跨包契约时同步更新协议/架构文档及消费者。
