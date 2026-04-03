# Codex Web Terminal

English | [简体中文](./README.zh-CN.md)

One thing only: use local `codex` sessions in your browser (including mobile).

Currently supports **Codex** only.

## Prerequisites

- Node.js 22+
- `codex` CLI installed and available in `PATH`
- For remote/external access: Tailscale installed on both desktop and phone, logged into the same account

## Quick Start (1 minute)

```bash
git clone https://github.com/SZZH/codex-cc-web-terminal.git
cd codex-cc-web-terminal
npm run setup
```

`npm run setup` guides you through `.env` setup, optional Tailscale setup,
dependency installation, and service startup.

Or run manually (macOS / Linux):

```bash
cd codex-cc-web-terminal
cp .env.example .env
# Set your own ACCESS_TOKEN in .env
npm install
npm run dev:up
```

On Windows (PowerShell or CMD), use:

```bash
npm install
npm run dev
```

Open:

- Frontend (recommended): `http://127.0.0.1:5173/#/sessions`
- Backend direct: `http://127.0.0.1:3210` (or your custom `PORT`)

## Mobile Access (2 ways)

### A. Same Wi-Fi

1. In `.env`, make sure `HOST=0.0.0.0`.
2. Open on your phone: `http://<your-lan-ip>:3210`
3. Sign in with `ACCESS_TOKEN`.

### B. Tailscale (recommended for remote network)

Required for this path: Tailscale on both desktop and mobile, signed into the same account.

1. Install and sign in on desktop: [Tailscale](https://tailscale.com/download)
2. Install Tailscale on Android/iOS and sign in to the same account
3. On desktop, run:

```bash
tailscale status
tailscale ip -4
```

4. Open on phone: `http://<desktop-100.x.x.x>:3210`

Recommended `.env` option:

```env
TAILSCALE_ONLY=true
```

## Deployment (PM2)

```bash
npm run service:start
npm run service:status
npm run service:logs
```

## Common Commands

```bash
npm run dev            # Cross-platform dev mode (server + web, foreground)
npm run dev:up         # macOS/Linux: start dev in background
npm run dev:down       # macOS/Linux: stop background dev processes
npm run check          # Quick checks
```

## Common Issues

1. `Cross-origin request rejected`
- Start with `npm run dev` (or `npm run dev:up` on macOS/Linux). Do not manually split startup commands.

2. `5173` is not reachable
- Run `npm run dev` first, then check port:
```bash
# macOS/Linux
lsof -iTCP:5173 -sTCP:LISTEN -n -P

# Windows
netstat -ano | findstr :5173
```

3. Phone says desktop is offline
- Check service status first: `npm run service:status`
- Then verify network path: same Wi-Fi or same Tailnet
- If you changed `PORT`, use the same port in your phone URL.

## Open Source

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
