#!/usr/bin/env bash
# Start the local embedding worker, embed the evaluation questions, run the evaluation,
# stop the worker.
set -uo pipefail
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a

npx wrangler dev --config tools/embed-worker/wrangler.jsonc --port 8799 --ip 127.0.0.1 > /tmp/embed-dev.log 2>&1 &
WRANGLER_PID=$!
trap 'kill $WRANGLER_PID 2>/dev/null' EXIT

for i in $(seq 1 40); do
  if curl -s --max-time 60 -X POST http://127.0.0.1:8799/embed \
       -H 'Content-Type: application/json' -d '{"texts":["warmup"]}' | grep -q '"vectors"'; then
    break
  fi
  sleep 3
done

bun scripts/embed-queries.ts "$@"
bun scripts/eval-retrieval.ts "$@"
