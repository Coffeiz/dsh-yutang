FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN pnpm install --frozen-lockfile --filter @dsh-im/server...
COPY apps/server apps/server
RUN pnpm --filter @dsh-im/server build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/server
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=build --chown=node:node /repo/apps/server/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/server/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
COPY apps/server/docker-entrypoint.sh /usr/local/bin/yutang-server-entrypoint
RUN chmod 755 /usr/local/bin/yutang-server-entrypoint
USER root
ENTRYPOINT ["/usr/local/bin/yutang-server-entrypoint"]
EXPOSE 9555
CMD ["node", "dist/main.js"]
