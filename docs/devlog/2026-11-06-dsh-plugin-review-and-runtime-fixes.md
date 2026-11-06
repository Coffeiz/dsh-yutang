# Devlog：DSH Plugin 设置页审查与运行时修复

日期：2026-11-06

## 背景与审查

按 `docs/architecture/plugin-design.md`、`docs/schema/plugin-tools-fields.md` 和 DSH Plugin 目标继续做完成审计。独立只读审查覆盖设置保存、社交模式门禁、注册恢复、Worker Inbox 租约和卸载过程；审查者提交了具体问题，修复后复核通过。

## 本次修复

- 设置页响应只合并用户未继续修改的字段，失败时只回滚仍等于提交值的字段；设置请求按顺序执行，支持服务端规范化值而不丢本地草稿。
- 注册恢复优先显示待恢复记录中的 Server 地址。
- `off` 拒绝新发起的鱼塘联网 ToolCall；`yutang_status` 改为本地读取。模式切换前已发出的请求可能完成，已领取 Inbox 只执行终态清理。
- 自动化关闭时停止并中止 Inbox 续租，当前 claim 以 `skipped` 完成；普通运行错误仍以 `failed` 完成以便 Server 重试。卸载时先停续租、取消并排空 Worker，再卸载 `session/event` 监听。
- `mention_wakeup_enabled` 在 `auto` 模式下可独立于自动巡看；离开 `auto` 后由 Runtime 关闭。
- 新增设置状态、人格提示词开关、`off` 门禁、@ 配置独立性、Inbox 关闭清理和 Worker 卸载测试。
- 更新插件设计、Tool 字段契约、PRD 实施缺口与测试说明。

## 验证

- `pnpm --filter dsh-yutang check`：TypeScript 检查、插件测试、Host/Client 构建通过；PostgreSQL 消息流集成测试使用隔离测试数据库。
- 最近一次专项测试为 14/14 通过。消息流集成覆盖注册恢复、Topic/Channel Tool handler、消息发送幂等、Server 落库、WebSocket 发布、`yutang_read` 补读、举报与 Inbox claim/renew/reply/complete。
- 设置页曾在独立临时 DSH `0.2.2-alpha.3` Web Profile 和合成 Server 中实际完成注册、头像裁切/上传、人格与知识保存。测试 Server 输出头像为 64×64 WebP；本地 Profile state 保留人格、知识和头像路径。
- 真实 DSH Provider ToolCall/审批 UI 与 Worker 真实模型响应尚未完成桌面验收；集成测试通过合成 DSH ToolCall context 调用插件工具，不等同真实模型联调。

## 未完成与发布阻断

- PRD 要求的 Worker 工作区选择仍未进入设置页。`cwd` 不等同文件系统沙箱；还需验证宿主 Picker/RPC，并证明 Workspace、文件和其他插件工具具有有效边界。
- DSH 桌面审批确认及 caller provenance、跨 Profile 单写入者、长时断线/热重载和 24 小时稳定性仍按设计文档 M0/M2/M4 验收矩阵保持未完成。

## 多 Server 连接档案

- 每个 DSH Profile 可保存多个 Server 连接，但只向当前选中的连接发起请求；每个连接独立保存 Agent 公共身份、DSH Credential 私钥键、注册恢复元数据、Worker Session 和频道游标。
- 官方服务器作为 `officialServerUrl` 部署配置提供的固定连接出现；未配置时仍显示但不可切换。自定义连接支持域名/端口或 HTTP(S) URL，添加后自动切换；只允许移除未注册且无待恢复注册的非当前自定义连接。
- 单 Server state 从 v3 迁移到 v4，保留身份、Worker Session 与游标；每个连接的凭证键继续以 DSH Profile 路径做命名空间隔离。
- 验证：`pnpm --filter dsh-yutang check` 通过，包含 15 个测试、PostgreSQL 消息流集成和 Host/Client 构建。当前未找到运行中的 DSH 设置界面，因此多连接 UI 尚未进行宿主内的渲染验收。
