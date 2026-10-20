#!/usr/bin/env bash
# Provision CivicSignal on Railway, from the infrastructure as code.
#
#   bash scripts/deploy-railway.sh            # plan only — changes nothing
#   RAILWAY_APPLY=1 bash scripts/deploy-railway.sh   # plan, then apply
#
# Everything is declared in `.railway/railway.ts`: the corpus database, the
# customer database, the encoder and the pipeline. The plan is printed before
# anything is applied, and applying is a separate command, so nothing changes
# without being seen.
#
# The pull request workflow plans on every change to `.railway/` and applies when
# it merges. This script is for the first provisioning and for the times when a
# human wants to see the diff before it lands.
set -euo pipefail

PROJECT="${RAILWAY_PROJECT:-civicsignal}"
WORKSPACE="${RAILWAY_WORKSPACE:-457628da-bacc-4a40-aac3-a7141004534d}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export RAILWAY_CALLER="skill:use-railway@1.7.0"
export RAILWAY_AGENT_SESSION="railway-skill-$(date +%s)-railway-deploy"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "the authoring file"
if [ ! -f .railway/railway.ts ]; then
  echo "  .railway/railway.ts is missing — nothing to apply"
  exit 1
fi
echo "  .railway/railway.ts"

say "the project"
if railway project list --json 2>/dev/null | grep -q "\"$PROJECT\""; then
  echo "  $PROJECT already exists"
  railway link --project "$PROJECT"
else
  # Creating a project is the one thing outside the IaC graph. After this the
  # file owns everything.
  railway init --name "$PROJECT" --workspace "$WORKSPACE" --json
fi

say "the plan"
# `plan` only reads Railway state and prints the difference. Variable values are
# redacted, so a secret in the environment does not land in a terminal.
railway config plan

if [ "${RAILWAY_APPLY:-0}" != "1" ]; then
  say "not applied"
  cat <<'NOTES'
  Review the plan above, then:

    RAILWAY_APPLY=1 bash scripts/deploy-railway.sh

  Or merge a pull request that changes `.railway/` — the workflow plans it and
  applies it on merge.
NOTES
  exit 0
fi

say "applying"
# Destructive changes need confirming explicitly. The plan above is the review;
# this is the approval.
railway config apply --yes --confirm-destructive

say "afterwards"
cat <<'NOTES'
  1. Set the shared variables on the environment:
       ENCODER_TOKEN   a random string; the encoder's proxy checks it and the
                       pipeline sends it
       GITHUB_TOKEN    a GitHub token, to lift the corpus API's rate limit from
                       60 requests an hour to 5,000

  2. Apply the schema to the corpus database:
       psql "$CORPUS_DATABASE_URL" -f services/corpus-db/migrations/0001_corpus.sql

     The pgvector extension has to exist first. The image ships the library;
     the extension is created in the database with:
       CREATE EXTENSION IF NOT EXISTS vector;

     That is a privilege operation and it is the database owner's to run.

  3. The customer database gets its schema when the spine is extracted, at step
     one of the port. Until then the API still runs on Cloudflare Workers.
NOTES
