# 发布规范

本规范覆盖版本号、更新日志、Git tag 和 GitHub Release。发布流水线定义在 `.github/workflows/release.yml`：发布一个 GitHub Release 会同时构建并推送 Server/Web Docker 镜像，以及发布 DSH 插件 npm 包。

## 版本号

- 仓库使用统一版本号。根目录 `package.json` 是版本号来源；其余第一方 `package.json` 必须与之相同。新增第一方 package 时，也要将它加入 `.github/workflows/release.yml` 的版本校验清单。
- 版本号遵循语义化版本 `MAJOR.MINOR.PATCH`。当前处于 `0.x` 阶段：兼容性功能和范围较大的改进升 `MINOR`；修复及小幅维护升 `PATCH`；破坏性 API、数据或配置变更至少升 `MINOR`，并在更新日志中标明迁移影响。进入 `1.0.0` 后按 SemVer：破坏性变更升 `MAJOR`，兼容功能升 `MINOR`，修复升 `PATCH`。
- 正式 Git tag 仅使用 `vX.Y.Z`，例如 `v0.1.1`。tag、GitHub Release 标题和所有第一方 package 版本必须一致；GitHub Release 标题直接写 tag，不加产品名前缀或额外说明。
- 当前流水线会将每次发布的镜像标记为 `latest`，因此暂不支持预发布版本和 GitHub 的预发布标记。启用预发布前，先调整流水线，避免预发布覆盖稳定版 `latest`。
- 已发布的 npm 版本不可复用。版本更新和对应 CHANGELOG 条目应随发布代码一起通过 PR 合入；不要在发布时临时改版本或补写说明。

### 版本更新检查

准备版本 PR 时：

1. 更新根目录及所有第一方 `package.json` 的版本号。
2. 将 `CHANGELOG.md` 中 `[待发布]` 的已完成内容整理到新版本小节，并填写发布日期。
3. 确认当前发布范围、迁移影响、贡献者和反馈报告者信息准确。
4. 合入后创建同版本 tag 和 Release。发布工作流会校验 tag 格式、package 版本及 CHANGELOG 标题；不一致时不会开始发布。

## 更新日志规范

`CHANGELOG.md` 是面向使用者的更新记录，也是 GitHub Release 正文的事实来源。只记录该版本中用户或 Server 部署者能观察到的变化：

- **重大变更**：不兼容的 API、数据、权限或配置变化，并说明迁移要求。
- **新功能**：新增的用户能力。
- **改进**：已有功能、性能或体验的变化。
- **修复**：用户可感知的问题修复；涉及安全时说明影响，不公开利用细节。
- **贡献者**：实际进入该版本的代码、测试、文档或设计贡献。
- **反馈与问题报告**：帮助定位本版本问题的 issue 报告者。

条目应短而具体，使用简体中文，先写结果，再视需要说明影响。产品名、协议名、命令和字段名保留其官方拼写。避免提交流水账、内部实现细节、排障过程、未经验证的效果和未公开信息；这些内容放在开发记录或 PR 中。致谢必须依据 GitHub PR/issue 元数据核对账号和编号，不根据昵称或 commit message 猜测。没有对应项目时保留章节并写“暂无”。

每个版本按以下结构使用简体中文撰写：

```markdown
## [0.1.1] - YYYY-MM-DD

### 重大变更
- 暂无。

### 新功能
- 面向用户的新能力。

### 改进
- 面向用户的改进。

### 修复
- 用户可感知的问题修复。

### 贡献者
- 感谢 [@login](https://github.com/login) 提交 PR #123。

### 反馈与问题报告
- 感谢 [@login](https://github.com/login) 通过 [#45](https://github.com/Coffeiz/dsh-yutang/issues/45) 提供反馈。
```

将示例替换为已核实内容。确实没有条目时写“暂无”；不得把示例账号或编号原样留在实际发布说明中。

## Git 标签与 GitHub 发布说明

- tag 附注使用单行 `vX.Y.Z：一句话摘要`，只说明发布重点，不复制完整更新内容。
- GitHub Release 标题使用纯 `vX.Y.Z`，正文复制 `CHANGELOG.md` 中对应版本小节的全文，保留全部章节。
- 不使用自动生成的提交列表替代 Release 正文；如果 GitHub 先生成草稿说明，应按 CHANGELOG 小节覆写。
- tag 应指向包含该版本代码、版本号和 CHANGELOG 的提交。创建 Release 前确认该 tag 尚未存在，并确认 CI 已通过。
- 一旦任何发布产物已对外发布，不移动该版本 tag；一般修复应升一个新版本。若流水线部分失败，先核对 npm 和两个镜像仓库哪些产物已发布，只补发失败产物，不能重复发布已成功的 npm 版本。
- `.github/workflows/release.yml` 提供手动恢复入口：合入工作流修复后，在 `main` 上运行 `Release`，填写原有 `release_tag`，并在 `artifacts` 中只选失败的产物组（`images` 或 `plugin`）；若两组均未发布则选 `all`。恢复任务会从原 tag 读取产品代码，不改版本号或 tag。
- Release 的正文不得包含凭据、内部地址、私有链接、真实个人信息或仅用于排障的敏感细节。

## npm Trusted Publishing

插件通过 npm Trusted Publishing 使用 GitHub Actions OIDC 发布，不使用长期 npm 发布令牌：

1. 在 npm 包设置中将 GitHub Actions 配置为 Trusted Publisher，仓库填写 `Coffeiz/dsh-yutang`，Workflow filename 填 `release.yml`。该名称必须与 `.github/workflows/release.yml` 匹配；无需填写路径或环境名。
2. 发布任务授予 `id-token: write`，使用 Node.js 24 和 npm `11.5.1` 或更新版本，再运行 `npm publish --access public`。
3. 新建的 Trusted Publisher 配置须在两天内完成首次成功发布，否则需要重新创建配置。

私有 GitHub 仓库可使用 Trusted Publishing，但 npm 不会为私有仓库生成 provenance。仓库公开后，OIDC 发布会自动生成 provenance。发布权限由 npm Trusted Publisher 配置和 GitHub OIDC 工作流共同限制；不得添加或传递 `NPM_TOKEN` / `NODE_AUTH_TOKEN`。

详见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。
