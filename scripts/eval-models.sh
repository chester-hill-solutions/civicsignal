#!/usr/bin/env bash
# Compare embedding models on the same labelled set.
#
# The question this answers is narrow and worth answering before any index is built:
# does a vector arm earn its running cost, and if so, with which model?
#
# The task-prefix problem is why the model comparison exists at all. EmbeddingGemma was
# trained with SearchQuery and Document prefixes, and the Workers AI schema for
# embeddinggemma-300m accepts no parameter for them, so the model Cloudflare hosts
# cannot be prompted the way it was trained. Whether that matters is measurable, and
# this measures it.
#
#   bash scripts/eval-models.sh                       # all three models
#   bash scripts/eval-models.sh @cf/qwen/qwen3-embedding-0.6b
set -uo pipefail
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID=ad5ec479b9a421faa2ed06c3d1c2b23a

MODELS=("$@")
if [ ${#MODELS[@]} -eq 0 ]; then
  MODELS=(
    "@cf/baai/bge-m3"
    "@cf/google/embeddinggemma-300m"
    "@cf/qwen/qwen3-embedding-0.6b"
  )
fi

npx wrangler dev --config tools/embed-worker/wrangler.jsonc --port 8799 --ip 127.0.0.1 > /tmp/embed-dev.log 2>&1 &
WRANGLER_PID=$!
trap 'kill $WRANGLER_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do
  curl -s --max-time 60 -X POST http://127.0.0.1:8799/embed \
    -H 'Content-Type: application/json' -d '{"texts":["warmup"]}' | grep -q '"vectors"' && break
  sleep 3
done

for model in "${MODELS[@]}"; do
  slug="${model#@cf/}"
  slug="${slug//[^a-zA-Z0-9]/-}"
  echo
  echo "══════════════════════════════════════════════════════════════"
  echo "  $model"
  echo "══════════════════════════════════════════════════════════════"
  if [ ! -f "dist/statutes.$slug.emb" ]; then
    bun scripts/embed-corpus.ts --model "$model" || continue
  else
    echo "  (vector store already present)"
  fi
  bun scripts/embed-queries.ts --model "$model" --out "dist/query-vectors.$slug.json"
  bun scripts/eval-retrieval.ts --vectors "dist/statutes.$slug.emb" --queries "dist/query-vectors.$slug.json"
done
