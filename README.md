# Codex Web Term

Browser-based multi-session terminal for running native `codex` on your Windows machine.

## What It Does

- Opens real PowerShell PTY sessions on your Windows host
- Auto-starts native `codex` in each new or resumed session
- Starts `codex` in full-access mode by default
- Streams terminal output live to a browser
- Supports multiple concurrent sessions
- Lists saved native Codex sessions from `~/.codex/sessions`
- Lets you reopen saved Codex sessions from the browser
- Uses a short-lived HttpOnly session cookie after token login
- Supports optional login rate limiting and network allowlists
- Supports managed restarts with `pm2`
- Supports Windows logon auto-restore through Task Scheduler
- Works from:
  - your PC at `http://localhost:3210`
  - your phone on the same LAN
  - your phone over Tailscale

## Setup

1. Copy `.env.example` to `.env`
2. Set a strong `ACCESS_TOKEN`
3. Optional: tighten access with `TAILSCALE_ONLY=true` or `TRUSTED_CIDRS`
4. Optional: tune session TTL / rate limits / heartbeat timings
3. Install dependencies:

```powershell
npm install
```

4. Start the server directly:

```powershell
npm start
```

5. Or run it under `pm2`:

```powershell
npm run prod
```

## Access

- Local PC: `http://localhost:3210`
- Same Wi-Fi phone: `http://<your-pc-lan-ip>:3210`
- Tailscale phone: `http://<your-tailscale-ip>:3210`

Enter the access token in the page, then create a new session.
The token is exchanged for an HttpOnly session cookie; subsequent API and WebSocket requests use that cookie instead of sending the token again.

## PM2 Management

- Unified service entrypoint:

```powershell
.\scripts\service.ps1 -Action status
.\\scripts\\service.ps1 -Action start -Mode prod
.\scripts\service.ps1 -Action restart -Mode prod
.\scripts\service.ps1 -Action stop
.\scripts\service.ps1 -Action logs
```

- `stop` only stops the service. It does not restart it.
- `restart` waits for `/api/health` before returning.
- Use `service.ps1` as the main operator entrypoint. The older `start.ps1`, `stop.ps1`, `restart.ps1`, `status.ps1`, and `logs.ps1` scripts still exist, but `service.ps1` is the preferred wrapper.

- Development watch mode:

```powershell
.\scripts\start.ps1 -Mode dev
```

- Production-style managed mode:

```powershell
.\scripts\start.ps1 -Mode prod
```

- Restart:

```powershell
.\scripts\restart.ps1 -Mode prod
```

- Status:

```powershell
.\scripts\status.ps1
```

- Logs:

```powershell
.\scripts\logs.ps1
```

## Windows Auto Start

- The production process is managed by `pm2`.
- PM2 state is persisted with `pm2 save`.
- Windows logon recovery is handled by the scheduled task:
  - `Codex Web Term PM2 Startup`
- That task runs:
  - `.\scripts\pm2-resurrect.ps1`
- Current behavior:
  - after Windows logon, the task restores PM2
  - if `codex-web-term` is missing, it starts it again
  - this is logon-time recovery, not a pre-login Windows service

## Session Behavior

- New browser sessions start a real `PowerShell` PTY and launch `codex`.
- Saved native Codex sessions from `~/.codex/sessions` are listed in the Sessions panel.
- Reopening a saved session starts a new live PTY that resumes that Codex session.
- Browser session names are auto-titled from the first meaningful input when possible.
- Historical session timestamps are displayed in `Australia/Melbourne`.

## Windows Network Notes

- If you want phone access on the same Wi-Fi or over Tailscale, keep `HOST=0.0.0.0`.
- If Windows Firewall prompts for Node.js access, allow it on the network type you plan to use.
- Tailscale access usually looks like `http://<tailscale-ip>:3210`.
- If you only want local + Tailscale access, set `TAILSCALE_ONLY=true`.
- If you want a custom allowlist, set `TRUSTED_CIDRS` to a comma-separated list like `127.0.0.0/8,100.64.0.0/10`.

## Notes

- Sessions are in-memory in this first version.
- Each new session launches `PowerShell` and immediately runs `codex`.
- Resumed sessions launch `codex resume --all <session-id>`.
- Default launch flags are controlled by `.env`:
  - `CODEX_FULL_ACCESS=true`
  - `CODEX_NO_ALT_SCREEN=true`
  - `DISPLAY_TIMEZONE=Australia/Melbourne`
  - leave `DEFAULT_CWD` empty to use your own home directory
  - optional `CODEX_MODEL`, `CODEX_PROFILE`, and `CODEX_EXTRA_ARGS`
- This version is intentionally Codex-only.
- `/api/health` returns basic uptime, session, auth, and WebSocket counters for monitoring.
