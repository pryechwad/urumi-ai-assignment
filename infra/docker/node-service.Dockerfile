# syntax=docker/dockerfile:1.7
# Builds one Node service from the monorepo (APP = gateway | woo-mcp | inventory-mcp | support-mcp).
# Stage 1 bundles it with esbuild; stage 2 is node:alpine plus that single file, run as non-root.
FROM node:24-alpine AS build
WORKDIR /src
ARG APP
# Every workspace manifest is copied so `npm ci` can validate the lockfile; only the
# requested workspace's dependencies are actually installed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/mcp-kit/package.json packages/mcp-kit/
COPY apps/gateway/package.json apps/gateway/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/inventory-mcp/package.json apps/inventory-mcp/
COPY apps/support-mcp/package.json apps/support-mcp/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w apps/${APP} -w packages/mcp-kit --include-workspace-root --no-audit --no-fund --ignore-scripts
COPY scripts ./scripts
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
RUN npm run build -w apps/${APP}

FROM node:24-alpine
ARG APP
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build --chown=node:node /src/apps/${APP}/dist/ ./
USER node
CMD ["node", "--enable-source-maps", "index.js"]
