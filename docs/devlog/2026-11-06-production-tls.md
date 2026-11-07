# 2026-11-06 生产 TLS 部署入口

## 目标

为生产 Docker Compose 增加 HTTPS/WSS 外部入口和可选 PostgreSQL TLS，同时保持 `npm run dev` 的 HTTP/WS 本地开发流程。

## 实现

- 新增可选 `tls` Compose profile，由 Caddy 处理 ACME 证书、HTTP→HTTPS 重定向和同域名 `/admin/` 路由。
- Web、Admin 与 API 的默认宿主机端口绑定到 loopback；生产公网入口使用 Caddy 的 80/443。
- Admin 生产构建使用 `/admin/` base，保持 Admin API 和静态资源都在同域路径下可访问。
- Admin Cookie 检测直连 HTTPS、可信反向代理的 `X-Forwarded-Proto: https`，也支持显式 `ADMIN_COOKIE_SECURE=true`。
- 新增 `DB_SSL_MODE=disable|require|verify-full` 与可选 `DB_SSL_CA_FILE`；迁移和 API 使用同一设置。默认 `disable`，不改变 npm dev 或现有本地 PostgreSQL 行为。

## 运行要求

公网 TLS 需要 `WEB_DOMAIN` 指向服务器、`WEB_ORIGIN=https://<WEB_DOMAIN>` 且公网 TCP 80/443 可达；通过 `docker compose --profile tls up --build -d` 启动。外部 PostgreSQL 建议 `verify-full`；自定义 CA 文件需由部署环境只读挂载。

## 验证状态

本次仅核对实现与配置，没有实际运行 Compose、申请证书或连接外部 PostgreSQL；部署环境的 DNS、端口放行和数据库证书仍需按目标环境验证。
