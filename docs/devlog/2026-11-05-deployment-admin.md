# Docker 部署与管理面板

## 实现

- 默认 Compose 提供 API、迁移、Web 与独立 Admin，并连接外部 PostgreSQL；显式叠加 `docker-compose.db.yml` 才会启动 PostgreSQL 容器。数据库连接配置拆分为 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。
- Web 与 Admin 镜像分别包含 Nginx；入口域名、绑定地址及端口通过环境变量配置。管理端默认仅绑定宿主机回环地址，开发时由主站 `/admin` 代理。
- 管理接口使用环境配置的账号密码与内存会话，提供消息、主题、频道趋势及请求日志。流量按请求声明长度和可计量响应体估算，按小时写入 PostgreSQL；不包含 WebSocket 及协议开销。
- 管理页使用项目令牌绘制趋势图；开发用 `/design` 展示图表令牌。

## 已验证

- Web、Admin 和 Server 生产构建通过。
- 在临时 PostgreSQL 上执行迁移，验证登录、统计接口及日、周、月数据点数量；并发读取流量统计结果一致。
- 通过 Web 开发服务器验证 `/admin`、资源和登录/统计 API 代理；浏览器验证管理登录及面板渲染。
- 在隔离目录模拟 Server 镜像依赖安装及运行目录，成功执行迁移。

## 待验证及限制

- 当前环境缺少 Docker Compose 插件，Docker 守护进程未运行，尚未构建镜像或验证 Compose、Nginx 与 WebSocket 的容器端到端行为。
- 流量是近似值，异常退出可能丢失尚未写入的数据；请求日志和管理员会话保存在进程内，重启后清空。
- 管理入口应置于可信反向代理之后，由部署者配置 HTTPS 和访问限制。域名设置本身不构成访问控制。
- 目前为单 API 实例设计；管理会话、实时广播和日志不会跨实例共享。
