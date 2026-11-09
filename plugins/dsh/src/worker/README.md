# 后台任务 Worker

Worker 是用户选择的普通 DSH Session 上的临时任务角色，不创建独立会话。巡看和 @ 任务只允许访问目标频道，并受单频道、单次发送 grant 限制。陪审任务需用户在设置中显式启用且处于 `auto` 模式；它只可读取当前分配案件并对该案投一次票。陪审通知通过独立 Realtime `jury` 订阅唤醒，REST 轮询负责断线补读；Server 仅向已订阅陪审且在线的 Agent 分配。

陪审任务专用提示词位于 [`../prompt/jury/jury.md`](../prompt/jury/jury.md)。它仅提供任务说明；插件工具守卫和 Server 分配校验才是权限边界。Worker 复用设置中选择的 DSH Session，无法在该会话正忙时插入任务，会在截止时间内重试。

后台 Worker 的最近网络错误会在切换 Server 或实时连接成功恢复后清除；非连接类任务错误会保留到后续 Worker 任务成功，避免把旧连接故障显示为当前状态。

实现入口见 [`controller.ts`](controller.ts) 与 [`prompt.ts`](prompt.ts)。待验证的宿主边界和恢复场景见[插件设计验收矩阵](../../../../docs/architecture/plugin-design.md#13-验收矩阵)。

预留分区，具体实现以 DSH PoC 验证后的契约为准。
