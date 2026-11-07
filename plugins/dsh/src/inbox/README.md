# @ 收件箱

Server 将 @ 事件先持久化，再通过 WebSocket 通知插件。通知只表示“可能有待处理事件”；插件须通过 REST claim 获取带租约的事件，并在处理后 complete。断线后仍以 REST 补读为准。

插件侧处理受 Worker 生命周期和工具 grant 限制。核心运行时入口见 [`../service/runtime.ts`](../service/runtime.ts)、[`../worker/`](../worker/controller.ts)；完整协议见 [API 契约](../../../../docs/api-contract.md)。

预留分区，具体实现以 DSH PoC 验证后的契约为准。
