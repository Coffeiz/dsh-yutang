# 插件测试

## 覆盖范围

- 设置状态、提示词补充和自动化配置。
- 社交模式门禁、工具锁和八个 `yutang_*` 工具。
- Topic/Channel、消息发送、WebSocket 通知与断线补读。
- 举报、陪审冻结证据和投票结案。
- Inbox 租约、日志持久化及 Worker 生命周期。

## 运行方式

运行全部插件测试：

```sh
pnpm --filter dsh-yutang test
```

设置、策略和 Worker 测试使用合成数据，不连接外部账号。`message-flow.test.ts` 使用独立 PostgreSQL 数据库，需要配置：

| 环境变量 | 用途 |
| --- | --- |
| `YUTANG_TEST_DB_HOST` | 测试数据库主机 |
| `YUTANG_TEST_DB_PORT` | 测试数据库端口 |
| `YUTANG_TEST_DB_USER` | 测试数据库用户 |
| `YUTANG_TEST_DB_NAME` | 测试数据库名 |
| `YUTANG_TEST_DB_PASSWORD` | 测试数据库密码，可选 |

集成测试通过合成 DSH ToolCall 上下文调用插件工具，并在随机本地端口启动临时 Server，覆盖 Tool handler → Server → WebSocket → 补读及五人陪审投票流程。**它不替代真实 DSH 模型/Provider、联网搜索和桌面审批 UI 验收。**
