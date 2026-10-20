#!/usr/bin/env bash
# Provision the corpus plane on Railway.
#
#   bash scripts/deploy-railway.sh
#
# Three services, declared in `.railway/railway.ts`:
#
#   postgres  — the corpus rows and their vectors, in one table, in one database
#   encoder   — EmbeddingGemma 2, served from the .litertlm artefact itself
#   pipeline  — the continuous ingest: pull the corpus, reconcile, embed, write
#
# The product plane — the API, the MCP server, the chat surface, the billing —
# stays on Cloudflare Workers. It scales to zero and costs a rounding error per
# query; the corpus plane needs a disk, a git binary and a process that stays up,
# and none of those exist in a Worker.
#
# The plan is printed before anything is applied, and applying is a separate
# command, so nothing changes without being seen.
set -euo pipefail

# The workspace id, not its name: an apostrophe in a name breaks the default
# value of a parameter expansion, and an exact id is the documented practice.
WORKSPACE="${RAILWAY_WORKSPACE:-457628da-bacc-4a40-aac3-a7141004534d}"
PROJECT="${RAILWAY_PROJECT:-civicsignal}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export RAILWAY_CALLER="skill:use-railway@1.7.0"
export RAILWAY_AGENT_SESSION="railway-skill-$(date +%s)-railway-deploy"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "the project"
if railway project list --json 2>/dev/null | grep -q "\"$PROJECT\""; then
  echo "  $PROJECT already exists"
  railway link --project "$PROJECT"
else
  # Creating a project is the one thing the CLI does outside the IaC graph.
  railway init --name "$PROJECT" --workspace "$WORKSPACE" --json
fi

say "the plan"
# `plan` only reads Railway state and prints what would change. Variable values
# are redacted, so a secret in the environment does not land in a terminal.
railway config plan

say "applying"
if [ "${RAILWAY_APPLY:-0}" = "1" ]; then
  # Destructive changes need confirming explicitly. The plan above is the
  # review; this is the approval.
  railway config apply --yes --confirm-destructive
else
  echo "  not applied. Review the plan, then:"
  echo "    RAILWAY_APPLY=1 bash scripts/deploy-railway.sh"
fi

say "afterwards"
cat <<'NOTES'
  1. Set the shared variable ENCODER_TOKEN on the environment. Both the encoder
     and the pipeline read it, and it is a secret, so it is not in source.

  2. Apply the schema:
       psql "$DATABASE_URL" -f services/corpus-db/migrations/0001_corpus.sql

     The pgvector extension has to exist first. If it does not, `CREATE EXTENSION
     vector;` has to be run by the database owner — it is a privilege operation
     and the agent does not run those.

  3. The corpus's own content is fetched by the pipeline, not by this script.
NOTES
