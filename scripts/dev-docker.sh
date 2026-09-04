#!/usr/bin/env bash
#
# Build the node and (re)load it into a local n8n running in Docker.
#
#   ./scripts/dev-docker.sh          build, install into the container, restart
#   ./scripts/dev-docker.sh --fresh  also wipe the n8n database and start over
#
# n8n ends up on http://localhost:5678 with the node installed the same way a
# community package is: unpacked under <data>/nodes/node_modules and listed as a
# dependency in <data>/nodes/package.json.
#
# The container reaches your machine as host.docker.internal, so to point the
# credential at a locally running Artificial Studio backend use
# http://host.docker.internal:3001 as the Base URL — inside the container,
# localhost is the container itself.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${N8N_DEV_DATA:-$REPO/.n8n-docker}"
CONTAINER="${N8N_DEV_CONTAINER:-n8n-as}"
IMAGE="docker.n8n.io/n8nio/n8n:latest"
PORT="${N8N_DEV_PORT:-5678}"

if [[ "${1:-}" == "--fresh" ]]; then
  echo "==> Removing container and data"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$DATA"
fi

echo "==> Building"
cd "$REPO"
npm run build

echo "==> Packing and installing into $DATA/nodes"
mkdir -p "$DATA/nodes"
TARBALL="$(npm pack --silent | tail -1)"
trap 'rm -f "$REPO/$TARBALL"' EXIT

cd "$DATA/nodes"
[[ -f package.json ]] || npm init -y >/dev/null
npm install "$REPO/$TARBALL" --omit=dev --omit=peer --no-audit --no-fund >/dev/null

# n8n reads this file to decide which community packages to load. npm records the
# tarball path as the version, which is meaningless once the files are unpacked,
# so pin it to the real version instead.
VERSION="$(node -p "require('$REPO/package.json').version")"
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.name = 'installed-nodes';
  pkg.dependencies = { 'n8n-nodes-artificialstudio': '$VERSION' };
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"

# The image runs as uid 1000 and needs to write its database here.
chmod -R 777 "$DATA"

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> Restarting $CONTAINER"
  docker restart "$CONTAINER" >/dev/null
else
  echo "==> Starting $CONTAINER"
  docker run -d --name "$CONTAINER" \
    -p "$PORT:5678" \
    -v "$DATA:/home/node/.n8n" \
    -e N8N_SECURE_COOKIE=false \
    -e N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true \
    -e N8N_RUNNERS_ENABLED=true \
    -e N8N_DIAGNOSTICS_ENABLED=false \
    --add-host=host.docker.internal:host-gateway \
    "$IMAGE" >/dev/null
fi

echo -n "==> Waiting for n8n"
for _ in $(seq 1 60); do
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" || true)" == "200" ]]; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 2
done

if docker logs "$CONTAINER" --since 2m 2>&1 | grep -q 'Failed to load package "n8n-nodes-artificialstudio"'; then
  echo "!! n8n could not load the package:"
  docker logs "$CONTAINER" --since 2m 2>&1 | grep -A2 'Failed to load package' | head -5
  exit 1
fi

echo "==> n8n is on http://localhost:$PORT"
echo "    logs:  docker logs -f $CONTAINER"
echo "    stop:  docker rm -f $CONTAINER"
