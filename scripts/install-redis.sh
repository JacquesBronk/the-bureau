#!/bin/bash
set -euo pipefail

# Deploy Redis to a remote Docker host (e.g., Proxmox)
# Usage: ./install-redis.sh user@proxmox-host

REMOTE_HOST="${1:?Usage: ./install-redis.sh user@hostname}"
REDIS_PORT="${2:-6379}"

echo "Deploying Redis to ${REMOTE_HOST}..."

# Copy docker-compose.yml to remote host
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ssh "$REMOTE_HOST" "mkdir -p ~/claude-peers"
scp "$PROJECT_DIR/docker-compose.yml" "$REMOTE_HOST:~/claude-peers/"

# Start Redis on remote host
ssh "$REMOTE_HOST" "cd ~/claude-peers && docker compose up -d"

echo "Redis deployed. Test with: redis-cli -h ${REMOTE_HOST%%@*} -p ${REDIS_PORT} ping"
