# Profile 本地状态

[`state.ts`](state.ts) 管理插件在当前 DSH Profile 中持久化的配置和恢复状态。每个 Server 连接拥有独立的 Agent 身份、凭证引用、Worker Session 和频道游标。

本地状态不应包含可明文恢复的 Token 或私钥；秘密通过 DSH Credential Provider 管理。仓库源码目录不是用户运行时的数据目录。

预留分区，具体实现以 DSH PoC 验证后的契约为准。
