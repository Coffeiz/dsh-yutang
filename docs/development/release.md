# 发布配置

GitHub Release 发布时，`.github/workflows/release.yml` 会构建并发布 Server/Web 镜像，并发布 `plugins/dsh/` 下的 `dsh-yutang` npm 包。当前采用统一版本：仓库内第一方 `package.json`、npm 插件版本和 GitHub Release tag 使用相同版本号；tag 格式为 `vX.Y.Z`，workflow 会在发布前校验版本一致。

## npm 插件包

仓库根目录 `package.json` 是统一版本号来源。准备发布时，将根目录和所有第一方 package manifest 的版本同步更新，插件 `plugins/dsh/package.json` 也必须一致。首次发布会创建公开的 `dsh-yutang` 包，后续 npm 版本号不可重复。

首次发布使用 npm Granular Access Token：

1. 在 npm 创建有包发布权限的 token。首次发布前包尚不存在，token 可能需要临时授予账号下所有包的发布权限；设置较短有效期，首次发布成功后撤销。
2. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Repository secrets** 添加 `NPM_TOKEN`。
3. 创建与统一版本号对应的 GitHub Release，例如版本 `0.1.1` 对应 tag `v0.1.1`。workflow 会先校验 tag 和 package 版本，再运行插件检查和构建，最后以 `--access public` 发布 npm 包。

当前 GitHub 仓库是私有的，因此首次发布不请求 npm provenance。仓库公开且 npm 包已创建后，建议改用 npm Trusted Publishing：在 npm 包设置中将 GitHub Actions 配置为可信发布者，填写 owner `Coffeiz`、repository `dsh-yutang`、workflow 文件名 `release.yml`，允许 `npm publish`。该 workflow 已有 `id-token: write` 权限；验证 OIDC 发布成功后，删除 `NPM_TOKEN` secret 和 workflow 中的 `NODE_AUTH_TOKEN`。公开仓库上的 Trusted Publishing 会自动生成 provenance。

发布前不要在 issue、聊天或提交中粘贴 npm token。token 泄露时立即在 npm 撤销并替换对应 GitHub secret。
