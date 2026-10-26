# syntax=docker/dockerfile:1.7
# Builds the React dashboard and serves the static files with unprivileged nginx on :8080.
# /api and /mcp are routed to the gateway by the Ingress, not by this container.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/mcp-kit/package.json packages/mcp-kit/
COPY apps/gateway/package.json apps/gateway/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/inventory-mcp/package.json apps/inventory-mcp/
COPY apps/support-mcp/package.json apps/support-mcp/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w apps/dashboard --include-workspace-root --no-audit --no-fund
COPY apps/dashboard ./apps/dashboard
RUN npm run build -w apps/dashboard

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infra/docker/dashboard-nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/docker/dashboard-security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /src/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
