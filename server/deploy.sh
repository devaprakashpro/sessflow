#!/usr/bin/env bash
# Deploy the Sessflow Mesh server to a node on your tailnet over SSH.
#
#   ./deploy.sh dev@100.117.69.10            # deploy to that host
#   SESSFLOW_DEPLOY_HOST=dev@host ./deploy.sh
#
# Idempotent: rsyncs the server dir, installs prod deps, (re)starts a systemd
# --user service bound to the node's Tailscale IP. No secrets are copied.
set -euo pipefail

HOST="${1:-${SESSFLOW_DEPLOY_HOST:-}}"
REMOTE_DIR="${SESSFLOW_REMOTE_DIR:-~/sessflow-mesh}"
[ -z "$HOST" ] && { echo "usage: ./deploy.sh user@tailscale-host"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"

echo "→ syncing server to $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude '.env' \
  "$HERE/" "$HOST:$REMOTE_DIR/"

echo "→ installing deps + (re)starting service"
ssh "$HOST" "bash -se" <<'REMOTE'
set -euo pipefail
cd ~/sessflow-mesh
command -v node >/dev/null || { echo "node not installed on host"; exit 1; }
npm ci --omit=dev || npm install --omit=dev

# make `systemctl --user` work over a non-interactive SSH session
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
loginctl enable-linger "$USER" >/dev/null 2>&1 || true   # keep running after logout

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/sessflow-mesh.service <<UNIT
[Unit]
Description=Sessflow Mesh Server
After=network-online.target

[Service]
WorkingDirectory=%h/sessflow-mesh
Environment=SESSFLOW_HOST=tailscale
Environment=SESSFLOW_PORT=7777
ExecStart=$(command -v node) src/index.js
Restart=on-failure

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now sessflow-mesh
sleep 1
systemctl --user --no-pager status sessflow-mesh | head -5
echo "--- token (paste into the extension) ---"
cat data/.sessflow-token 2>/dev/null || echo "(token prints in: journalctl --user -u sessflow-mesh)"
REMOTE

echo "✓ deployed. In the extension: Settings → Cloud sync → Mesh → http://<this-host>.<tailnet>.ts.net:7777"
