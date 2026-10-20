# The ingestion pipeline.
#
# A long-running service that keeps the corpus current.
#
# It needs things a Cloudflare Worker cannot have: a filesystem, a git binary,
# and a process that stays up. The corpus repo is a gigabyte with a hundred and
# thirty megabytes of history, and it has to be cloned and pulled — so it lives
# on a Railway volume, not in memory.
#
# The volume is also what makes the pipeline cheap: the clone is pulled, not
# re-cloned, and the store's own `corpus_state` says which revision it is at, so
# the pipeline only parses the instruments that changed.

FROM oven/bun:1.3-alpine

RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Dependencies first, so a change to the corpus does not reinstall them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY scripts ./scripts
COPY services ./services
COPY vendor ./vendor

# The corpus clone. A Railway volume is mounted here.
ENV CORPUS_DIR=/corpus

RUN mkdir -p /corpus

CMD ["bun", "scripts/pipeline-run.ts", "--watch"]
