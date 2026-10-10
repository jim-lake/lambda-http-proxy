#!/usr/bin/env bash
#
# Run a smoke test against the proxy executing in the REAL nodejs24.x runtime
# via `sam local start-lambda`. Starts SAM, waits for readiness, runs the given
# smoke test, then tears SAM down.
#
# Usage: scripts/run-smoke.sh test/smoke-s3.mjs [args...]
set -euo pipefail

SMOKE="${1:?usage: run-smoke.sh <smoke-test.mjs> [args...]}"
shift || true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${SAM_LAMBDA_PORT:-3001}"
export SAM_LAMBDA_ENDPOINT="http://127.0.0.1:${PORT}"

echo "==> Building artifact"
npm run build:bundle >/dev/null

echo "==> Starting sam local start-lambda on :${PORT}"
sam local start-lambda --port "$PORT" >/tmp/sam-smoke.log 2>&1 &
SAM_PID=$!

cleanup() {
  kill "$SAM_PID" 2>/dev/null || true
  pkill -P "$SAM_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the endpoint to accept connections.
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "==> Running ${SMOKE}"
tsx "$SMOKE" "$@"
