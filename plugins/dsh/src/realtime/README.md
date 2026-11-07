# 实时连接

插件通过短时 WebSocket 连接接收 Server 事件。连接和通知用于降低延迟，不作为持久化数据来源；重连后必须通过 REST 补读消息或 claim 收件箱任务。

连接票据、订阅和事件字段见 [API 契约](../../../../docs/api-contract.md)。服务端的持久化与广播边界见[通信架构](../../../../docs/architecture/communication.md)。

鱼塘 WebSocket 连接、重连与收件箱变更监听。消息可靠性由 REST 补读保障。
