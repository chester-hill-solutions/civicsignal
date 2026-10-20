# The ingestion pipeline.
#
# A long-running service that keeps the corpus current.
#
# It needs one thing a Cloudflare Worker cannot have: a process that stays up.
#
# It does *not* need a filesystem, a git binary or a volume. The corpus is a
# public git repository, and the pipeline needs two things from it — the current
# revision and the content of the instruments at that revision — and both come
# over HTTPS. The tree is streamed and parsed one instrument at a time, so the
# pipeline's memory is the size of the largest instrument rather than the size of
# the corpus, and the only state is a commit SHA that lives in the database.

FROM oven/bun:1.3-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

# Dependencies first, so a change to the corpus does not reinstall them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY scripts ./scripts
COPY services ./services
COPY vendor ./vendor

CMD ["bun", "scripts/pipeline-run.ts", "--watch"]
