# Sessflow Mesh Server

Self-hosted sync + archive + AI backend for the **Sessflow** extension. Designed to run on a node in your **Tailscale** tailnet — your tabs sync privately to *your* machine, never a third-party cloud.

## What it does
- **Sync** — last-write-wins mirror of your sessions (`POST /v1/sync`), with a **WebSocket** (`/v1/live`) that pushes a "changed" ping to your other devices for near-real-time sync.
- **Archive** — fetches every saved URL in the background, extracts readable text, and stores it (link-rot insurance). View any archived page at `/v1/page/:hash`.
- **Search** — FTS5 full-text search across all archived pages (`GET /v1/search?q=`).
- **Ask your tabs** — RAG: retrieves the most relevant archived pages and asks Claude, with citations (`POST /v1/ask`). The Anthropic key lives **here**, not in the browser.

## Run it

```bash
cd server
npm install
cp .env.example .env      # optional; edit as needed
npm start
```

On first start it prints a **device token** — paste that into the extension under **Settings → Cloud sync → Mesh**.

### Bind privately to your tailnet (recommended)
Set `SESSFLOW_HOST=tailscale` and the server auto-detects this node's Tailscale IP and binds **only** to it — never your LAN or the public internet:
```bash
SESSFLOW_HOST=tailscale npm start
#   Binding to Tailscale IP 100.x.y.z (private to your tailnet)
#   Point the extension here: http://<node>.<tailnet>.ts.net:7777
```
On startup it prints both the MagicDNS URL and the IP URL — paste either into **Settings → Cloud sync → Mesh** along with the device token. Because Tailscale encrypts and authenticates at the network layer, **no public IP, port-forwarding, or TLS cert is needed**. (`SESSFLOW_HOST` also accepts `0.0.0.0` for all interfaces, or a specific `100.x.y.z`.)

### One-command remote deploy
From your dev machine, push the server to any tailnet node over SSH — installs prod deps and runs it as a `systemd --user` service bound to Tailscale:
```bash
./deploy.sh dev@100.x.y.z          # e.g. your always-on node
```
No secrets are copied; the token is generated on the remote and printed at the end.

### Run as a service (systemd)
```ini
# /etc/systemd/system/sessflow-mesh.service
[Unit]
Description=Sessflow Mesh Server
After=network-online.target tailscaled.service

[Service]
WorkingDirectory=/home/youruser/sessflow/server
ExecStart=/usr/bin/node src/index.js
EnvironmentFile=/home/youruser/sessflow/server/.env
Restart=on-failure
User=youruser

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now sessflow-mesh
```

## API
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/health` | – | liveness + whether AI is configured |
| POST | `/v1/sync` | Bearer | push sessions + pull changes since `{since}` |
| GET  | `/v1/search?q=&limit=` | Bearer | FTS5 search over archived pages |
| POST | `/v1/ask` | Bearer | ask-your-tabs (RAG via Claude) |
| GET  | `/v1/page/:hash` | Bearer | readable archived copy of a page |
| GET  | `/v1/stats` | Bearer | counts: sessions / archived / queued |
| WS   | `/v1/live?token=` | token | live "changed" push to other devices |

All `/v1/*` calls require `Authorization: Bearer <token>`.
