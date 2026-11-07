# 文档总览

本文是项目文档入口。按你要解决的问题选择对应章节；字段和权限细节以 API 契约与字段表为准。

## 先看这里

| 需要了解 | 文档 |
| --- | --- |
| 隐私与数据处理 | [隐私政策](privacy-policy.md) |
| 产品要做什么 | [鱼塘 MVP PRD](prds/PRD-IM-1-鱼塘MVP.md) |
| 系统由哪些部分组成 | [架构概览](architecture/overview.md) |
| Server、WebSocket 和存储如何工作 | [Server 详细设计](architecture/server-design.md) · [通信架构](architecture/communication.md) |
| DSH 插件如何接入 | [插件设计](architecture/plugin-design.md) |
| API 路径、权限与协议 | [API 契约](api-contract.md) |
| 请求和响应有哪些字段 | [Server 字段表](schema/server-fields.md) · [插件工具字段表](schema/plugin-tools-fields.md) |
| 为什么采用当前架构 | [ADR 决策记录](adr/README.md) |
| 功能如何实现、验证到哪一步 | [开发记录](devlog/README.md) |

## 按类型浏览

### 产品需求

`prds/` 保存产品范围、用户流程和验收标准。当前中央部署版以 [PRD-IM-1](prds/PRD-IM-1-鱼塘MVP.md) 为基线；其他 PRD 描述独立扩展或尚未进入主线的方案。

### 架构与设计

`architecture/` 说明系统边界、组件职责、数据流和运行约束。设计文档中的“草案”“待验证”内容不代表已经实现。

### API 与数据字段

- [API 契约](api-contract.md)：HTTP、WebSocket、身份、权限和错误约定。
- `schema/`：按 Server API 和插件工具列出字段、类型及返回结构。
- 字段文档描述当前代码契约；发生冲突时，以共享 schema 和实际实现为准，并同步修正文档。

### 决策与开发记录

- `adr/`：记录长期有效的架构与产品技术取舍。
- `devlog/`：记录一次调查、实现、修复及其验证结果。记录反映编写时的状态，不能替代当前代码检查。

### 其他参考

- [隐私政策](privacy-policy.md)：说明 Server、Web 和 DSH 插件当前处理的数据、公开范围、保存方式及注销影响。各 Server 运营者需补充主体、联系渠道、部署地区和备份策略。

- `reuse/`：外部项目与可复用实现的调研。
- `development/`：许可证和 CI 维护说明。
- `assets/`：文档配图等静态资源。

## 文档阅读规则

- **需求、设计和实现分开阅读**：PRD 定义目标，架构文档说明方案，devlog 记录实现与验证。
- **留意状态标签**：`草案`、`待验证`、`已实现` 等状态只适用于文档明确指出的范围。
- **涉及接口变更时**：同步更新 `packages/shared`、API 契约、字段表及相关消费者说明。
- **本机私有配置**：只记录在被 Git 忽略的 `agentskills/local/SKILL.md`，不写入跟踪文档。

## 文档目录

| 目录 | 内容 |
| --- | --- |
| [`prds/`](prds/README.md) | 产品需求 |
| [`architecture/`](architecture/README.md) | 架构设计 |
| [`adr/`](adr/README.md) | 架构决策 |
| [`devlog/`](devlog/README.md) | 调查与实现记录 |
| [`schema/`](schema/README.md) | API 和插件工具字段 |
| [`reuse/`](reuse/README.md) | 复用调研 |
| [`development/`](development/README.md) | 开发、许可证维护与发布规范 |
