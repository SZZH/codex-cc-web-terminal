#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[dev-down] stopping dev processes..."
pkill -f "vite --config ./web/vite.config.js" >/dev/null 2>&1 || true
pkill -f "node --watch ./src/server.js" >/dev/null 2>&1 || true
pkill -f "./src/server.js" >/dev/null 2>&1 || true

echo "[dev-down] done."
