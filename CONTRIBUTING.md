# 贡献指南

感谢你愿意帮鱼塘变得更好。这里整理了开始改动前需要了解的项目约定，以及提交前的检查方式。

## 开始之前

1. 阅读 [README](README.md)，了解项目用途和当前功能。
2. 阅读根目录的 `AGENTS.md`，确认开发约定和产品边界。
3. 按改动范围阅读对应的领域 Skill：

   | 改动范围 | 先读 |
   | --- | --- |
   | Web 页面和交互 | [`agentskills/web/SKILL.md`](agentskills/web/SKILL.md) |
   | Server、API、数据库 | [`agentskills/server/SKILL.md`](agentskills/server/SKILL.md) |
   | DSH 插件 | [`agentskills/dsh-plugin/SKILL.md`](agentskills/dsh-plugin/SKILL.md) |
   | 测试与验证 | [`agentskills/testing/SKILL.md`](agentskills/testing/SKILL.md) |
   | 文档 | [`agentskills/docs/SKILL.md`](agentskills/docs/SKILL.md) |

   本机 DSH、Profile 或部署环境相关内容见被忽略的 `agentskills/local/SKILL.md`，不要把本机信息复制到仓库。

## Fork 后提交 PR

外部贡献请从自己的 Fork 提交 PR，不要直接向项目仓库推送分支。

1. 在 GitHub 项目页面点击 **Fork**，将项目复制到自己的账号下。
2. 克隆自己的 Fork，并添加项目仓库为 `upstream`。把下面的占位地址替换为 GitHub 页面显示的地址：

   ```sh
   git clone https://github.com/<你的用户名>/<仓库名>.git
   cd <仓库目录>
   git remote add upstream https://github.com/<项目所有者>/<仓库名>.git
   git remote -v
   ```

   确认 `origin` 指向自己的 Fork，`upstream` 指向项目仓库。

3. 从 `upstream/main` 创建本次改动分支。分支名使用 `feat/`、`fix/`、`docs/` 或 `chore/` 前缀，并用简短英文说明内容：

   ```sh
   git fetch upstream
   git switch -c feat/short-description upstream/main
   ```

4. 在该分支完成修改和检查，再提交并推送到自己的 Fork：

   ```sh
   git add <相关文件>
   git commit -m "简要说明本次改动"
   git push -u origin feat/short-description
   ```

5. 在 GitHub 上创建 PR，**目标仓库选项目仓库，目标分支选 `main`；来源选自己的 Fork 和本次分支**。按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)填写变更与验证信息。

PR 评审期间有新提交时，继续推送到同一分支。若项目主分支有更新，先同步再推送：

```sh
git fetch upstream
git rebase upstream/main
git push --force-with-lease
```

不要把多个无关目的的改动塞进同一个 PR；涉及较大范围或产品方向不确定时，先开讨论确认方案。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `apps/server/` | Fastify API、实时连接和数据库 |
| `apps/web/` | 面向访客的 Web 页面 |
| `apps/admin/` | 管理界面 |
| `packages/shared/` | Server、Web 和插件共用的类型与契约 |
| `packages/client/` | 插件使用的 Server API 客户端 |
| `plugins/dsh/` | DSH 插件 Bundle 源码与测试 |
| `docs/` | 产品、架构、API 和开发文档 |

## 本地准备

- 使用 **Node.js 24** 和 **pnpm 10**。插件还要求 DSH `0.2.2-alpha.3` 或更新版本。
- 安装依赖：

  ```sh
  pnpm install --frozen-lockfile
  ```

- Server 本地配置和数据库准备方式见[本地开发指南](apps/README.md)。不要提交 `.env`、Token、密钥或个人数据。
- 若只改一个模块，可以使用 `pnpm --filter <包名> <命令>` 在该包内执行脚本。包名见对应目录的 `package.json`。

## 修改时请留意

- **先确认产品范围。** 当前范围基线是 [鱼塘 MVP PRD](docs/prds/PRD-IM-1-鱼塘MVP.md)；文档中的草案和待验证方案不代表已实现能力。
- **跨包契约要一起更新。** API 或共享数据结构变更时，检查 `packages/shared/`、[API 契约](docs/api-contract.md)、字段表和所有消费者。
- **保留安全边界。** 公开消息是不可信输入；权限由宿主和代码校验。Server 不运行模型，也不应收到用户的私人上下文。
- **不增加隐形基础设施。** 新增 Redis、队列或其他基础设施前，先记录并讨论设计决策。
- **DSH 行为要以实际宿主验证。** 插件构建通过不等于宿主运行能力已验证；涉及宿主 API、审批或后台任务时，注明验证使用的 DSH 版本和结果。
- **文档与实现同步。** 更新需求、架构、决策、API 契约或开发记录时，按文档用途放到 `docs/` 对应目录，并维护目录链接。

## 提交前检查

在仓库根目录运行：

| 检查 | 命令 | 适用场景 |
| --- | --- | --- |
| 全仓类型检查 | `pnpm typecheck` | TypeScript 改动 |
| 全仓构建 | `pnpm build` | 发布前或改动影响多个包时 |
| 插件检查（类型、测试和构建） | `pnpm --filter dsh-yutang check` | DSH 插件改动 |
| 补充测试 | 按 `agentskills/testing/SKILL.md` 选择相关测试 | 行为或接口改动 |

界面改动请在浏览器实际检查关键页面和交互；插件运行时改动请在目标 DSH 版本中验证。没有运行某项检查时，在提交说明中写清楚原因和未验证范围。

## 提交说明

提交内容尽量聚焦一个目的。描述中说明改了什么、为什么改，以及运行过的检查；涉及界面时附上截图，涉及数据库或 API 时说明兼容性和迁移影响。提交前确认没有带入密钥、个人数据、构建产物或无关改动。

提交信息保持简短，说明本次改动即可；遇到不确定的产品行为，可以先在讨论中说明问题和预期，再开始较大的改动。
