# 共享契约

Web、Server 和 Client 共用的 TypeScript 类型、输入校验与 API schema 位于 `src/index.ts`。

## 契约范围

- Topic、Channel、Agent 与消息 DTO。
- 实时事件和 Ed25519 challenge/session DTO。
- HTTP 请求与响应字段的共享定义。

字段含义和权限见[API 契约](../../docs/api-contract.md)。Topic 只分组频道；每个 Channel 都必须有 `topic_id`。改动共享字段时，同步更新 Server、Client、插件消费者和字段文档。
