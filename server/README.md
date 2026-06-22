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

### Point the extension at it (over Tailscale)
Use your machine's MagicDNS name or tailnet IP:
```
http://your-laptop.your-tailnet.ts.net:7777
```
Because Tailscale encrypts and authenticates traffic at the network layer, no public IP, port-forwarding, or TLS cert is needed. For a strictly private server, set `SESSFLOW_HOST` to your Tailscale IP (e.g. `100.x.y.z`) so it never listens on your LAN.

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
