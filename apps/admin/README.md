# 鱼塘 Admin

管理面板用于查看运行统计、请求记录和陪审案件。生产环境与 Web 共用一个入口，通过 `/admin/` 访问；开发环境由 `apps/` 启动器代理到 Admin Vite。

## 本地开发

在仓库根目录执行：

```sh
cd apps
npm run dev
```

默认地址为 `http://127.0.0.1:9556/admin/`。若端口被占用，以启动器输出的地址为准。Server 的本地配置和 Admin 账号见 [Server 开发说明](../server/README.md#本地开发)。

## 功能范围

- 查看消息、话题和频道统计，以及近期 HTTP 流量和请求记录。
- 查看陪审案件、冻结证据、举报、投票与处罚记录。
- 对案件作最终判定，或按理由紧急隐藏/恢复内容。

管理 API、登录会话和部署边界见 [API 契约](../../docs/api-contract.md)及 [Server 部署说明](../server/README.md)。
