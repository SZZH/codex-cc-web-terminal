# Codex Web Terminal

English | [简体中文](./README.zh-CN.md)

One thing only: use local `codex` sessions in your browser (including mobile).

Currently supports **Codex** only.

## Prerequisites

- Node.js 22+
- `codex` CLI installed and available in `PATH`

## Quick Start (1 minute)

```bash
git clone https://github.com/ttm43/codex-cc-web-terminal.git
cd codex-cc-web-terminal
npm run setup
```

`npm run setup` guides you through `.env` setup, optional Tailscale setup,
dependency installation, and service startup.

Or run manually:

```bash
cd codex-cc-web-terminal
cp .env.example .env
# Set your own ACCESS_TOKEN in .env
npm install
npm run dev:up
```

On Windows, use:

```bash
npm install
npm run dev
```

Open:

- Frontend (recommended): `http://127.0.0.1:5173/#/sessions`
- Backend direct: `http://127.0.0.1:3210`

## Mobile Access (2 ways)

### A. Same Wi-Fi

1. In `.env`, make sure `HOST=0.0.0.0`.
2. Open on your phone: `http://<your-lan-ip>:3210`
3. Sign in with `ACCESS_TOKEN`.

### B. Tailscale (recommended for remote network)

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
npm run dev:up         # Start development mode (web HMR)
npm run dev:down       # Stop development processes
npm run check          # Quick checks
```

## Common Issues

1. `Cross-origin request rejected`
- Start with `npm run dev:up`. Do not manually split startup commands.

2. `5173` is not reachable
- Run `npm run dev:up` first, then check port:
```bash
lsof -iTCP:5173 -sTCP:LISTEN -n -P
```

3. Phone says desktop is offline
- Check service status first: `npm run service:status`
- Then verify network path: same Wi-Fi or same Tailnet

## Open Source

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
