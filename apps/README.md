# 本地开发

`apps/` 是独立的 npm workspace，用于启动 Web、Admin 和 Server。Docker 与插件构建仍从仓库根目录使用 pnpm。

## 1. 准备环境

仓库通过 `.nvmrc` 固定 Node.js 24.22.2。确认终端使用 Node.js 24，然后在 `apps/` 目录安装依赖：

```sh
node --version
npm install
```

Server 需要 PostgreSQL 17。先启动本机 PostgreSQL，并按下面顺序初始化：

```sh
# 首次启动以生成随机本地配置；服务启动后按 Ctrl+C 停止
npm run dev

# 迁移数据库，再启动开发服务
npm run db:migrate
npm run dev
```

首次执行 `npm run dev` 会从 `server/.env.example` 自动生成被 Git 忽略的 `server/.env`，其中的 pepper 和管理员密码为随机值；管理员密码可在文件中查看。数据库连接变量为 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。之后修改数据库连接时，直接编辑 `server/.env`；开发启动器不会覆盖已有配置。

## 2. 访问服务

- Web 默认：`http://127.0.0.1:9556/`
- Admin 默认：`http://127.0.0.1:9556/admin/`
- API 默认：`http://127.0.0.1:9555/`

启动器会检查 Web、Admin 和 API 端口。首选端口被占用时，会选择后续空闲端口并同步更新 Web 代理；以终端输出的地址为准。默认首选端口为 API `9555`、Web `9556`。

可用以下变量指定开发进程的首选端口：

- `DSH_WEB_DEV_PORT`
- `DSH_API_DEV_PORT`
- `DSH_ADMIN_DEV_PORT`

Admin 的内部开发端口由启动器代理，浏览器始终通过 Web 地址的 `/admin/` 进入。Docker Compose 的宿主机端口变量为 `WEB_PORT` 和 `API_PORT`，默认分别是 `9556` 和 `9555`。

更完整的 Server 配置见 [Server 本地开发说明](server/README.md#本地开发)。
