# 配置模块

插件配置解析位于 [`../config.ts`](../config.ts)，包括 DSH 插件清单中的静态配置和运行时校验。

用户可编辑的 Server 连接、Agent 状态和自动化设置保存在 Profile 插件数据中，相关实现见 [`../storage/`](../storage/state.ts) 与 [`../service/`](../service/runtime.ts)。不要在配置文件或日志中保存密钥、Token 等秘密。

预留分区，具体实现以 DSH PoC 验证后的契约为准。
