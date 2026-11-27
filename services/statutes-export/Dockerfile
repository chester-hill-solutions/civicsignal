FROM oven/bun:1.3.5 AS bun
FROM node:24.22.3-bookworm-slim AS node
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS dependencies

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor/ ./vendor/
RUN bun install --frozen-lockfile --production

FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=dependencies /app/node_modules/ ./node_modules/
COPY scripts/ingest-statutes.ts scripts/check-corpus-invariants.mjs ./scripts/
COPY src/ingest/statutes.ts ./src/ingest/
COPY src/corpora/d1-store.ts ./src/corpora/
COPY migrations/ ./migrations/
COPY services/statutes-export/run.py ./services/statutes-export/run.py
COPY services/weekly-archive/runtime.py ./services/weekly-archive/runtime.py
COPY services/institution-coverage/container/snapshot.py ./services/institution-coverage/container/snapshot.py

ENV GIT_TERMINAL_PROMPT=0 LANG=C.UTF-8
EXPOSE 8080
CMD ["python3", "-B", "/app/services/statutes-export/run.py"]
