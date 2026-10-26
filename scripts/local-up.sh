#!/usr/bin/env bash
# One-shot local environment: k3d cluster -> images -> Helm release.
#   scripts/local-up.sh
# Optional: LLM_API_KEY=... scripts/local-up.sh   (enables the chat agent)
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER="${CLUSTER:-urumi}"
TAG="${TAG:-0.1.0}"
CHART=infra/helm/urumi-platform

if ! k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "==> creating k3d cluster '$CLUSTER' (Traefik on host port 8088)"
  # k3s ships Traefik (ingress), local-path (storage) and kube-router NetworkPolicy enforcement:
  # the same components as the k3s VPS target. metrics-server is dropped to save memory.
  k3d cluster create "$CLUSTER" \
    --agents 0 \
    --port "${HOST_PORT:-8088}:80@loadbalancer" \
    --k3s-arg "--disable=metrics-server@server:0" \
    --wait
fi
# On Windows k3d writes host.docker.internal into the kubeconfig, which can resolve to a LAN
# address the firewall blocks; the API port is published on localhost, so use that.
PORT="$(kubectl config view -o jsonpath="{.clusters[?(@.name==\"k3d-$CLUSTER\")].cluster.server}" | grep -oE '[0-9]+$')"
kubectl config set-cluster "k3d-$CLUSTER" --server="https://127.0.0.1:$PORT" >/dev/null
kubectl config use-context "k3d-$CLUSTER" >/dev/null

echo "==> building images"
scripts/build-images.sh ${PREBUILT:+--prebuilt} "$TAG"

echo "==> importing images into the cluster"
k3d image import -c "$CLUSTER" \
  "urumi/gateway:$TAG" "urumi/woo-mcp:$TAG" "urumi/inventory-mcp:$TAG" "urumi/support-mcp:$TAG" "urumi/dashboard:$TAG"

echo "==> installing the Helm release"
EXTRA=()
if [ -n "${LLM_API_KEY:-}" ]; then EXTRA+=(--set-string "secrets.llmApiKey=$LLM_API_KEY"); fi
helm upgrade --install urumi "$CHART" -f "$CHART/values-local.yaml" "${EXTRA[@]}" --wait --timeout 20m

echo
helm get notes urumi
