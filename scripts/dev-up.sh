#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

SERVER_LOG="/tmp/codex-server-dev.log"
WEB_LOG="/tmp/codex-web-dev.log"

echo "[dev-up] stopping old dev processes..."
pkill -f "vite --config ./web/vite.config.js" >/dev/null 2>&1 || true
pkill -f "node --watch ./src/server.js" >/dev/null 2>&1 || true
pkill -f "./src/server.js" >/dev/null 2>&1 || true

echo "[dev-up] starting server (watch) on :3210 ..."
nohup node --watch ./src/server.js >"$SERVER_LOG" 2>&1 &

echo "[dev-up] starting web (vite hmr) on :5173 ..."
nohup npm run web:dev >"$WEB_LOG" 2>&1 &

sleep 2

echo
echo "[dev-up] listening ports:"
lsof -iTCP:3210 -sTCP:LISTEN -n -P || true
lsof -iTCP:5173 -sTCP:LISTEN -n -P || true

echo
echo "[dev-up] open:"
echo "  http://127.0.0.1:5173/#/sessions"
echo
echo "[dev-up] logs:"
echo "  tail -f $SERVER_LOG $WEB_LOG"

