#!/bin/bash
# dev.sh — Kill server, build, restart server
# Usage: bash dev.sh [port]
PORT=${1:-8081}

echo "[dev] Stopping any existing server..."
# Kill node processes on our port
if command -v powershell &>/dev/null; then
  powershell -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force" 2>/dev/null
else
  pkill -f "node server.js" 2>/dev/null
fi
sleep 1

echo "[dev] Building..."
npx gulp build
if [ $? -ne 0 ]; then
  echo "[dev] BUILD FAILED"
  exit 1
fi

echo "[dev] Starting server on port $PORT..."
node server.js --port $PORT
