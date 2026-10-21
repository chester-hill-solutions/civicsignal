# The API.
#
# CivicSignal's server, on Bun.
#
# It is the same API the Cloudflare Worker serves — the same brief, the same
# retrieval, the same language lens — over one Postgres with pgvector instead of
# D1 and Vectorize. The Worker stays deployable as the rollback until the cut
# over, so the two can answer side by side for as long as it takes to be sure.
#
# It needs no filesystem, no git binary and no volume. The corpus is a
# database, the encoder is a service, and the state is the corpus's own
# revision — which the pipeline keeps, not this.

FROM oven/bun:1.3-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

# Dependencies first, so a change to the corpus does not reinstall them.
#
# **The vendored packages come before the install.** Two of the dependencies are
# `file:` references into `vendor/`, and bun resolves a `file:` dependency while
# it installs — so if the vendor directory is not there yet, the install fails
# with "Failed to install 2 packages" and the build stops. The two packages are
# the house's own: the corpus and the metering.
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile

COPY src ./src
COPY services ./services

# The port the service listens on. It is declared rather than inherited so that
# the health check and the port agree without a second place to change.
ENV PORT=8080
EXPOSE 8080

CMD ["bun", "services/api/server.ts"]
