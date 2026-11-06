# 插件运行时服务

[`runtime.ts`](runtime.ts) 连接 DSH 宿主、Profile 状态、Server API 和插件功能。它负责共享运行时状态与生命周期；具体 API 请求通过 `packages/client`，不得从插件中直接依赖 `apps/`。

预留分区，具体实现以 DSH PoC 验证后的契约为准。
