#!/usr/bin/env bash
# Run the retrieval evaluation end to end.
#
#   bash scripts/eval-run.sh                                        # the full corpus
#   bash scripts/eval-run.sh --corpus dist/eval-corpus.jsonl \
#        --vectors dist/eval-corpus.emb --queries dist/eval-query-vectors.json
#
# Starts its own embedding worker, because the reranker arm needs one and the
# worker must outlive the embedding job.
set -uo pipefail
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a

CORPUS=dist/statutes.jsonl
VECTORS=dist/statutes.emb
QUERIES=dist/query-vectors.json
while [ $# -gt 0 ]; do
  case "$1" in
    --corpus) CORPUS="$2"; shift 2;;
    --vectors) VECTORS="$2"; shift 2;;
    --queries) QUERIES="$2"; shift 2;;
    *) shift;;
  esac
done

npx wrangler dev --config tools/embed-worker/wrangler.jsonc --port 8799 --ip 127.0.0.1 > /tmp/embed-dev.log 2>&1 &
WRANGLER_PID=$!
trap 'kill $WRANGLER_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do
  curl -s --max-time 60 -X POST http://127.0.0.1:8799/embed \
    -H 'Content-Type: application/json' -d '{"texts":["warmup"]}' | grep -q '"vectors"' && break
  sleep 3
done

bun scripts/embed-queries.ts --out "$QUERIES"
bun scripts/eval-retrieval.ts --corpus "$CORPUS" --vectors "$VECTORS" --queries "$QUERIES"
