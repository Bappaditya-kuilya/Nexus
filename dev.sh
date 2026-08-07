#!/bin/bash
# dev.sh — starts everything locally in one terminal (tmux) or three.
# Usage: ./dev.sh

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Backend
(
  cd "$ROOT/backend"
  [ -f .env ] && export $(grep -v '^#' .env | xargs)
  source .venv/bin/activate
  echo "[backend] starting on :8000"
  python main.py
) &

# Website
(
  cd "$ROOT/website"
  [ ! -f .env.local ] && cp .env.local.example .env.local
  echo "[website] starting on :3000"
  pnpm dev --port 3000
) &

echo "Backend: http://localhost:8000"
echo "Website: http://localhost:3000"
echo "Docs:    http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop both."
wait
