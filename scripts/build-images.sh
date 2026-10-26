#!/usr/bin/env bash
# Builds the platform's five images. Usage:
#   scripts/build-images.sh [--prebuilt] [tag] [registry-prefix]
#
# Default: multi-stage builds (npm ci + esbuild/vite inside Docker). Reproducible; use for CI/releases.
# --prebuilt: bundle on the host (npm run build), then copy only the output into runtime images.
#             Much lighter on memory and bandwidth; the runtime layers are identical.
#
# e.g. scripts/build-images.sh 0.1.0                  -> urumi/gateway:0.1.0 ...
#      scripts/build-images.sh 0.1.1 ghcr.io/acme     -> ghcr.io/acme/urumi/gateway:0.1.1 ... (then docker push)
set -euo pipefail
cd "$(dirname "$0")/.."
PREBUILT=false
if [ "${1:-}" = "--prebuilt" ]; then PREBUILT=true; shift; fi
TAG="${1:-0.1.0}"
PREFIX="${2:-}"
name() { if [ -n "$PREFIX" ]; then echo "$PREFIX/urumi/$1:$TAG"; else echo "urumi/$1:$TAG"; fi; }
export DOCKER_BUILDKIT=1

if [ "$PREBUILT" = true ]; then
  [ "${SKIP_HOST_BUILD:-}" = 1 ] || npm run build --workspaces --if-present
  ctx="$(mktemp -d)"
  trap 'rm -rf "$ctx"' EXIT
  for app in gateway woo-mcp inventory-mcp support-mcp; do
    echo "==> $(name "$app") (prebuilt)"
    rm -rf "${ctx:?}"/* && cp "apps/$app/dist/index.js" "apps/$app/dist/index.js.map" "$ctx/"
    docker build -f infra/docker/prebuilt.Dockerfile -t "$(name "$app")" "$ctx"
  done
  echo "==> $(name dashboard) (prebuilt)"
  rm -rf "${ctx:?}"/* && cp -r apps/dashboard/dist "$ctx/dist" && cp infra/docker/dashboard-nginx.conf infra/docker/dashboard-security-headers.conf "$ctx/"
  docker build -f infra/docker/prebuilt-dashboard.Dockerfile -t "$(name dashboard)" "$ctx"
  exit 0
fi

for app in gateway woo-mcp inventory-mcp support-mcp; do
  echo "==> $(name "$app")"
  docker build -f infra/docker/node-service.Dockerfile --build-arg APP="$app" -t "$(name "$app")" .
done
echo "==> $(name dashboard)"
docker build -f infra/docker/dashboard.Dockerfile -t "$(name dashboard)" .
