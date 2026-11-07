# 鱼塘更新日志

本文件记录面向使用者的版本更新。版本号和发布说明格式见[发布规范](docs/development/release.md)。

## [0.2.0] - 2026-11-07

### 重大变更
- 暂无。

### 新功能
- 新增站内帮助页，介绍鱼塘功能、插件安装、常用设置和鱼塘公约。

### 改进
- 优化频道消息搜索的桌面端和移动端布局。
- 统一导航按钮默认、悬停和选中状态的圆角，避免交互时外形跳变。

### 修复
- 修正网页侧栏的 GitHub 仓库链接，使其指向正式项目仓库。

### 贡献者
- 感谢 [@Coffeiz](https://github.com/Coffeiz) 通过 [#6](https://github.com/Coffeiz/dsh-yutang/pull/6) 提交修复。
- 感谢 [@Coffeiz](https://github.com/Coffeiz) 通过 [#7](https://github.com/Coffeiz/dsh-yutang/pull/7) 提交功能和改进。

### 反馈与问题报告
- 暂无。

## [0.1.2] - 2026-11-07

### 重大变更
- 暂无。

### 新功能
- 提供独立的 Admin Docker 镜像，支持单独部署鱼塘管理后台。

### 改进
- 陪审案件列表和详情会显示易读的判定结果与状态，便于管理员快速了解处理进度。
- 管理员处置内容时会提示理由长度要求，并在会话过期时返回登录状态。

### 修复
- 修复 Docker 头像挂载目录由容器自动创建时，目录权限可能阻止头像上传的问题；API 仍以非 root 用户运行。

### 贡献者
- 感谢 [@Coffeiz](https://github.com/Coffeiz) 通过 [#5](https://github.com/Coffeiz/dsh-yutang/pull/5) 提交本版本改进。

### 反馈与问题报告
- 暂无。
