# Codex Web Terminal

English | [简体中文](./README.zh-CN.md)

One thing only: use local `codex` sessions in your browser (including mobile).

The main chat interface is for **Codex**. Legacy Claude Code (CC) terminal compatibility is retained.

## Screenshots

<p align="center">
  <img src="./docs/images/codex-web-terminal.jpg" alt="Codex Web Terminal mobile screenshot 1" width="280" />
  <img src="./docs/images/codex-web-terminal2.jpg" alt="Codex Web Terminal mobile screenshot 2" width="280" />
</p>

## Prerequisites

- Node.js 22.15+
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
# Set your own ACCESS_TOKEN in .env; the default change-me is rejected
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

使用公网静态托管时，应用重启不会自动更新远端前端。请将管理入口构建出的同一份产物按[静态发布与回退流程](docs/operations/frontend-release.md)发布；不要仅重启本机后就认为公网页面已更新。

Codex app-server receives the thread's model, reasoning effort, and permission
settings explicitly. The browser currently declines command/file approval and
permission-escalation requests; it does not approve them automatically.
The composer supports read-only, automatic review, and full-access modes. Automatic
review uses Codex's reviewer; unsupported human approval requests remain declined.
Settings belong to the current thread and do not change desktop-wide permissions.
Reasoning choices follow the selected model's capabilities, and sending waits for
settings to finish saving. Codex V2 chat sends through the official app-server.

The sidebar follows local Codex project identities, membership, pins and ordering.
Groups initially show five chats, with an option to expand all. A Recent activity
view sorts chats across projects by actual activity time. Confirmed running chats
are marked in both views; desktop-owned threads without reliable runtime evidence
remain unknown.
It reads desktop metadata directly instead of scanning every transcript for each
list request. Model choices come from the active app-server's model catalog.
Custom permission policies that cannot be represented safely require an explicit
permission selection before continuation.

## Codex Chat (V2)

Chat uses official Thread / Turn / Item identities, bounded history pages, and a
WebSocket subscription tied to the stable thread ID. Visible history pages load
intermediate messages and file changes automatically, with at most two turns being
read concurrently. Complete older turns are reused; the latest turn reads only new
items after its last loaded item. Execution details remain collapsed by default. Reconnection restores history and subscriptions without
replaying prompts. Legacy transcripts are adapted at the history boundary, and the
existing CC terminal transport remains separate.

Submissions have durable request receipts. Queued messages wait for the current
web-owned turn to finish; **steer** sends a follow-up to that specific active turn,
and **interrupt** stops it explicitly. Waiting messages appear above the composer and
can be promoted to steer without submitting a duplicate. Expanding execution details
loads them automatically; reasoning items without visible content are omitted.
Failed messages retain their text and images.
An uncertain submission is checked automatically and is never blindly resent.

Messages preserve multiline text and support up to six PNG, JPEG, WebP or GIF
attachments (20 MiB each). Local and inline reply images use authenticated media
URLs; tool output and file diffs have on-demand details with explicit size limits.
The web app does not take over a desktop-owned thread. On a writer conflict,
it saves the message in Codex's durable desktop queue under the original thread
ID, then checks official history for execution. An unloaded or interrupted
desktop thread may leave the message pending. Read-only viewing does not claim
execution ownership, and the web app cannot steer or interrupt desktop-owned turns.

See the [V2 contract](./docs/refactoring/codex-chat-v2.md) and
[desktop compatibility boundaries](./docs/architecture/codex-desktop-compatibility.md).

## Local File and Web Previews

Open local file links and running loopback web apps in a side panel on desktop or
a full-screen preview on mobile, while keeping the chat and draft. File previews
use kkFileView 5.0.3; Office documents, images, PDF and Markdown are the core cases.
The computer and required services must stay online. Previews use isolated ports
and temporary, scoped access links; keep private directories outside published
content. See the [local preview runbook](./docs/operations/local-preview.md) for
frp/Caddy setup, runtime management and compatibility limits.

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

## Changelog

### `v0.3.0`

Core updates since `v0.2.0`:

- Tightened the session list to show only unarchived sessions used within the last 7 days while preserving Codex project groups even when they are empty.
- Refined the mobile session list UI by removing the redundant title bar, replacing the group affordance with a plus action, and adding loading feedback while a new group session is being created.
- Simplified the composer running state by hiding the interrupt action for now and locking further input while a submitted turn is still in progress.
- Improved the input transport path around thread/session input handling, typed deltas, and history synchronization so active conversation state remains consistent after sends.

### `v0.2.0`

Core updates since `v0.1.0`:

- Reworked the session/thread main pipeline around thread snapshots, canonical events, and SSE transport, making history, realtime continuation, and state synchronization more consistent.
- Improved Codex history support across session list, message rendering, thread continuation, and image recovery for historical conversations.
- Added a workspace changes panel with diff display, per-turn change anchoring, and revert actions.
- Improved session list behavior to sort groups by latest usage time and align project-session filtering with Codex branch-aware rules.
- Refined the thread/process UI, including unified process/file-change toggle icons, better process/code presentation, and auto-collapsing completed process sections.
- Fixed multiple chat experience issues, including initial scroll-to-bottom behavior, follow-scroll stability after content updates, and historical message classification/rendering problems.
- Fixed historical content leakage issues so Codex host directives such as git-related control markers do not appear inside conversation history bubbles.

### `v0.1.0`

Core updates:

- Initialized repository rules, contribution guidance, and version-tag conventions.

## Open Source

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
