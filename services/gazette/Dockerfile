FROM oven/bun:1.3.5 AS bun
FROM node:24.22.3-bookworm-slim AS node
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS dependencies

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock tsconfig*.json vitest.config.ts ./
COPY vendor/ ./vendor/
COPY services/hansard/retain-runtime-packages.py /tmp/retain-runtime-packages.py
RUN bun install --frozen-lockfile && python3 /tmp/retain-runtime-packages.py

FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=dependencies /app/ /app/
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
COPY services/gazette/run.py ./services/gazette/run.py
COPY services/weekly-archive/runtime.py ./services/weekly-archive/runtime.py
COPY services/institution-coverage/container/snapshot.py ./services/institution-coverage/container/snapshot.py
COPY services/daily-checks/*.ts ./services/daily-checks/
COPY services/house/archive.ts services/house/publish.ts ./services/house/
COPY test/ ./test/
COPY migrations/ ./migrations/
COPY preview/ ./preview/
COPY docs/evidence/ ./docs/evidence/

ENV TZ=America/Toronto
EXPOSE 8080
CMD ["python3", "-B", "/app/services/gazette/run.py"]
