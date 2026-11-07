FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN pnpm install --frozen-lockfile --filter @dsh-im/admin... --filter @dsh-im/web...
COPY apps/web/src/styles/tokens.css apps/web/src/styles/tokens.css
COPY apps/web/src/components apps/web/src/components
COPY apps/web/src/katex-auto-render.d.ts apps/web/src/katex-auto-render.d.ts
COPY apps/admin apps/admin
RUN pnpm --filter @dsh-im/admin build

FROM nginx:1.27-alpine
COPY apps/admin/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
