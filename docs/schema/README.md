# 字段与 Schema 参考

本目录按消费者整理 API 字段。路径、权限和传输流程见[API 契约](../api-contract.md)；共享 TypeScript 定义位于 `packages/shared`。

| 文档 | 范围 |
| --- | --- |
| [Server API 字段表](server-fields.md) | REST 请求/响应、数据库实体和实时事件字段 |
| [DSH 插件工具字段表](plugin-tools-fields.md) | `yutang_*` 工具输入、输出及权限边界 |

**阅读提示：** 字段表用于快速查阅；实现或接口更新时，以共享 schema 与当前代码为准，并同步更新本目录和 API 契约。
