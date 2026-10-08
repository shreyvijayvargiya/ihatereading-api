#!/usr/bin/env bash
# Start GuideForge API + web (durable background processes)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/Cellar/node/25.9.0_1.reinstall/bin:${PATH:-}"

mkdir -p /tmp
if ! curl -sf -m 2 http://127.0.0.1:8790/api/health >/dev/null; then
  (cd "$ROOT/server" && node src/index.js >>/tmp/guideforge.log 2>&1) &
  disown || true
  sleep 1
fi

if ! curl -sf -m 2 -o /dev/null http://127.0.0.1:5174/; then
  (cd "$ROOT/web" && npm run dev >>/tmp/guideforge-web.log 2>&1) &
  disown || true
  sleep 1
fi

echo "GuideForge API  http://127.0.0.1:8790/api/health"
echo "GuideForge Web  http://127.0.0.1:5174"
curl -s http://127.0.0.1:8790/api/health || true
echo
