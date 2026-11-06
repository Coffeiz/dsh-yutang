# 依赖许可证清单与 CI

项目自身使用 MIT，见根目录 `LICENSE` 和 `package.json`。第三方依赖许可证单独列出，不会改变项目许可证。

GitHub Actions 的 `License compliance` workflow 会分别在 Ubuntu、macOS、Windows 上安装 pnpm 锁定的 workspace 依赖、生成平台清单并检查许可证策略。这样可以检查 sharp 等原生可选依赖在不同平台上的差异。每个平台的生成清单作为 workflow artifact 保存；清单含平台信息，不跨平台比较生成文件。

## 本地生成与检查

```bash
pnpm install --frozen-lockfile
pnpm licenses:generate
pnpm licenses:check
```

生成文件（仅代表当前运行平台）：

- `licenses/dependencies.json`：已安装 pnpm 依赖的名称、版本、许可证、链接和准确的直接依赖位置。
- `licenses/THIRD-PARTY-NOTICES.md`：可发布的第三方依赖清单。

清单将每个 workspace 的 `dependencies`、`devDependencies`、`optionalDependencies`、`peerDependencies` 分开列出；只有包名和实际解析版本都匹配时才标为直接依赖，避免将同名传递依赖误标。报告还记录扫描 OS、CPU 和 Linux libc。生成文件由脚本生成，不要手动修改；本机生成结果会随平台而异。CI 在三个 OS 上独立执行策略检查，并上传平台报告，不要求本机生成物与 CI 产物相同。

## 策略和 note

`licenses/policy.json` 中的 `blockedPatterns` 定义 CI 阻断的许可证标识，`reviewLicenses` 定义需要人工留意的许可证。遇到确需接受的阻断许可证时，在 `exceptions` 中添加精确到包名和版本的例外，并写明 `note`：

```json
{
  "package": "example-package@1.2.3",
  "license": "GPL-3.0-only",
  "note": "用途、分发边界和审核结论"
}
```

缺少 note 的例外会使 CI 失败。例外应保持最小范围；普通复核项会在 CI 输出中列出，但不会自动批准或修改策略。当前 macOS 清单检出 `@img/sharp-libvips-darwin-arm64` 的 LGPL-3.0-or-later，策略会阻断它；其他平台也会由矩阵分别检查。需要在合并前完成许可证审查并决定替换依赖或记录有说明的例外，不能由生成脚本自动放行。
