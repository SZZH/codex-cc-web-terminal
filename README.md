# Codex/CC Web Terminal

Browser-based multi-session terminal for running native `codex` and `cc`/`claude` on your Windows or macOS machine.

## What It Does

- Opens real PTY shell sessions on the host machine
- Auto-starts native `codex` or `cc` in each new or resumed session
- Starts both CLIs in full-access mode by default
- Streams terminal output live to a browser
- Supports multiple concurrent sessions
- Lists saved native Codex sessions from `~/.codex/sessions`
- Lists saved native CC sessions from `~/.claude/projects`
- Lets you reopen saved Codex or CC sessions from the browser
- Lets you pick the working directory from an in-page path dropdown
- Lets you rename the active live session directly from the CLI page
- Uses a short-lived HttpOnly session cookie after token login
- Supports optional login rate limiting and network allowlists
- Supports managed restarts with `pm2`
- Supports optional auto-restore after login
- Works from:
  - your PC at `http://localhost:3210`
  - your phone on the same LAN
  - your phone over Tailscale

## Prerequisites

- Install native `codex` and/or `cc` (`claude`) on the host machine.
- Install Node.js 22 or newer.
- If you want phone access over Tailscale, install Tailscale first and sign in on both the host and the phone.
- Platform shell defaults:
  - Windows: Windows PowerShell is used by default.
  - macOS: your login shell from `$SHELL` is used by default, usually `/bin/zsh`.
- Decide whether you want:
  - local + LAN access
  - local + Tailscale-only access with `TAILSCALE_ONLY=true`

## Setup

1. Copy `.env.example` to `.env`
2. Set a strong `ACCESS_TOKEN`
3. Optional: set `SHELL_BIN` / `SHELL_ARGS` if you want a non-default shell.
4. If you want Tailscale phone access, make sure Tailscale is already installed, connected, and has assigned an IP on the host.
5. Optional: tighten access with `TAILSCALE_ONLY=true` or `TRUSTED_CIDRS`
6. Optional: tune session TTL / rate limits / heartbeat timings
7. Install dependencies:

```bash
npm install
```

8. Start the server directly:

```bash
npm start
```

9. Or run it under `pm2` with the shared service entrypoint:

```bash
npm run service:start
```

## Access

- Local PC: `http://localhost:3210`
- Same Wi-Fi phone: `http://<your-pc-lan-ip>:3210`
- Tailscale phone: `http://<your-tailscale-ip>:3210`

Before the UI will work, open the correct address for your network path, enter the `ACCESS_TOKEN` from `.env`, then create a new session.
If `TAILSCALE_ONLY=true`, the same-Wi-Fi LAN address is blocked; use `http://localhost:3210` on the PC or `http://<your-tailscale-ip>:3210` from your phone.
The token is exchanged for an HttpOnly session cookie; subsequent API and WebSocket requests use that cookie instead of sending the token again.

## PM2 Management

- Unified service entrypoint:

```bash
npm run service:start
npm run service:restart
npm run service:stop
npm run service:status
npm run service:list
npm run service:logs
```

- Development watch mode:

```bash
npm run service:start:dev
```

- `stop` only stops the service. It does not restart it.
- `restart` waits for `/api/health` before returning.
- `list` shows the managed `codex-cc-web-terminal` PM2 apps without the extra health output from `status`.
- `scripts/service.mjs` is the shared implementation used by both Windows and macOS.
- On Windows, `service.ps1`, `start.ps1`, `stop.ps1`, `restart.ps1`, `status.ps1`, and `logs.ps1` still exist as thin wrappers if you prefer PowerShell.

- Windows PowerShell wrappers:

```powershell
.\scripts\service.ps1 -Action status
.\scripts\service.ps1 -Action start -Mode prod
.\scripts\service.ps1 -Action restart -Mode prod
.\scripts\service.ps1 -Action stop
.\\scripts\\service.ps1 -Action list
.\scripts\service.ps1 -Action logs
```

```powershell
.\scripts\start.ps1 -Mode dev
```

## Auto Start

- The production process is managed by `pm2`.
- PM2 state is persisted with `pm2 save`.
- Shared restore command:

```bash
npm run service:resurrect
```

- Windows:
  - keep using Task Scheduler if you want login-time recovery
  - the scheduled task can run `.\scripts\pm2-resurrect.ps1`
- macOS:
  - use `launchd`
  - inspect the rendered plist with `npm run launchd:render`
  - install the agent with `npm run launchd:install`
  - verify it with `npm run launchd:list`
  - remove it with `npm run launchd:uninstall`
  - the installer renders `scripts/launchd/com.codex-cc-web-terminal.plist.template` into `~/Library/LaunchAgents/com.codex-cc-web-terminal.plist` using the current Node executable and repo path

## Session Behavior

- New browser sessions start a real PTY and launch the selected provider.
- The New Session page exposes a path dropdown under `Working directory` so you can pick folders without typing the full path.
- The New Session page also lets you choose between `codex` and `cc`.
- Saved native Codex sessions from `~/.codex/sessions` and CC sessions from `~/.claude/projects` are listed in the Sessions panel.
- Live sessions stay visible in the browser list, while saved history is switched by provider so long Claude history lists stay manageable.
- Reopening a saved session starts a new live PTY that resumes that provider session.
- Browser session names are auto-titled from the first meaningful input when possible.
- Live session titles can also be edited manually from the CLI header.
- Historical session timestamps are displayed in `DISPLAY_TIMEZONE`.

## Network Notes

- If you want phone access on the same Wi-Fi or over Tailscale, keep `HOST=0.0.0.0`.
- If Windows Firewall prompts for Node.js access, allow it on the network type you plan to use.
- Tailscale access usually looks like `http://<tailscale-ip>:3210`.
- If you only want local + Tailscale access, set `TAILSCALE_ONLY=true`.
- If you want a custom allowlist, set `TRUSTED_CIDRS` to a comma-separated list like `127.0.0.0/8,100.64.0.0/10`.

## Notes

- Sessions are in-memory in this first version.
- Each new session launches the configured shell and immediately runs the selected provider CLI.
- Resumed Codex sessions launch `codex resume --all <session-id>`.
- Resumed CC sessions launch `claude --resume <session-id>` by default. Set `CC_BIN=cc` if you prefer that command name.
- Claude sessions auto-advance the initial workspace trust and bypass-permissions confirmations so the browser session lands in the Claude UI instead of hanging on startup prompts.
- Claude mobile paste uses bracketed paste handling, and the terminal interrupt button switches to `Ctrl+C` while a Claude session is active.
- Default launch flags are controlled by `.env`:
  - `SHELL_BIN` and `SHELL_ARGS` let you override the host shell
  - `CODEX_FULL_ACCESS=true`
  - `CODEX_NO_ALT_SCREEN=true`
  - `CC_FULL_ACCESS=true`
  - `DISPLAY_TIMEZONE=Australia/Melbourne`
  - leave `DEFAULT_CWD` empty to use your own home directory
  - optional `CODEX_MODEL`, `CODEX_PROFILE`, `CODEX_EXTRA_ARGS`, `CC_MODEL`, `CC_EXTRA_ARGS`, and `CC_SESSIONS_DIR`
- `/api/health` returns basic uptime, session, auth, and WebSocket counters for monitoring.
