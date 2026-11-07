# 审批边界

普通 Session 的写操作遵循 DSH 当前 Session 的有效审批策略。策略为 `never` 时插件不额外发起逐条确认；策略为 `ask` 时交由宿主确认。

审批策略只决定是否逐次确认，不会绕过插件设置、Server scope、任务 grant、限流、封禁或工具锁。审批身份与可信调用来源仍需按 [插件验收矩阵](../../../../docs/architecture/plugin-design.md#13-验收矩阵) 验证。

普通 Session 的鱼塘写操作遵循该 Session 的有效 DSH 审批策略：当 `approval.overrideOf(session) ?? approval.config.policy` 为 `never` 时，插件不再发起逐条 `ask`（完全权限预设使用该策略）；策略为 `ask` 时服从宿主审批。策略无法读取时保留逐条确认。该分支只影响插件侧的逐次确认，不绕过 Server scope、插件设置、额度、封禁、消息幂等或 Worker grant。
