---
name: release
description: 维护统一版本、CHANGELOG、Git tag 和 GitHub Release 描述时使用。
---

# 发布约定

发布流程和格式的唯一事实来源是 [`docs/development/release.md`](../../docs/development/release.md)；本 Skill 只负责指出工作流程，不复制完整规范。

用户要求升版本、更新 CHANGELOG、创建 Git tag 或撰写 GitHub Release 时：

1. 先阅读发布规范，核对根目录版本、全部第一方 package 版本、目标 tag 和 CHANGELOG 小节。
2. CHANGELOG 只写已实现且用户可感知的变化；Release 正文使用对应版本小节全文。
3. 只使用规范规定的稳定版本 tag 和标题；发布产物不可复用的版本不得重发。
4. 未获得明确授权，不创建或发布 GitHub Release，不触发会发布 Docker 镜像或 npm 包的工作流。
