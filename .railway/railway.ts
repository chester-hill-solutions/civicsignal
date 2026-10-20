import { database, defineRailway, github, group, postgres, project, ref, service } from 'railway/iac';

/**
 * CivicSignal, on one host.
 *
 * One project, one environment, one private network. A Bun service, the corpus
 * database, the encoder, the pipeline and — when it lands — the harness.
 *
 * ## Why two databases
 *
 * Railway's managed Postgres does not ship pgvector, and the extension cannot be
 * added afterwards because the library is not in the image. So the database that
 * holds the vector index has to be a pgvector image, declared here as a custom
 * image rather than inherited from a template, so that the whole environment is
 * reproducible from this file.
 *
 * That splits the data by lifecycle, which is the right split anyway:
 *
 * - `corpus` — the provisions and their vectors. **Rebuildable**: the upstream
 *   repository is the backup, and the pipeline can reconstruct the whole corpus
 *   in about two minutes. It needs no managed backups, and it needs the extension.
 * - `customer` — the API keys, the customers and the usage counters. **Not
 *   rebuildable.** It gets the managed database, with its backups and its
 *   point-in-time recovery, and it does not need the extension. That is also why
 *   there is no bucket: the half that cannot be rebuilt is the half the managed
 *   database protects, and the half that can be rebuilt does not need it.
 *
 * The API holds a pool for each. The corpus pool is read-mostly; the customer
 * pool is small and write-heavy.
 *
 * ## Two secrets, and why they are shared
 *
 * `ENCODER_TOKEN` is a **shared variable**, set once in the dashboard, and both
 * the encoder and the pipeline read it. The encoder's proxy checks it and the
 * pipeline sends it. Two separate variables would be two chances to set them
 * differently, and a mismatch presents as a pipeline that cannot reach the
 * encoder for no visible reason.
 *
 * `GITHUB_TOKEN` raises the corpus API's rate limit from 60 requests an hour to
 * 5,000, which is what makes a full backfill practical.
 *
 * ## A domain rather than a URL
 *
 * The pipeline gets the encoder's **domain**, not a URL, and composes the URL at
 * run time. Railway provides the private domain to every service and it is not
 * known until the service exists, so a URL assembled at plan time would have to
 * be a guess.
 *
 * ## The pipeline is a service, and that is a cost
 *
 * It sleeps between cycles, but it is a running process with memory, and the
 * authoring DSL has no cron for a long-running service. It is the one service
 * here that is not on the critical path, and moving it behind a scheduled
 * invocation of the API is a later step.
 *
 * Apply with `railway config plan` and then `railway config apply`. The plan is
 * reviewed before anything changes.
 */
export default defineRailway((ctx) => {
  /**
   * The corpus database. The pgvector image, declared rather than inherited from
   * a template, so the environment is reproducible from this file.
   */
  const corpus = database('corpus', 'postgres', {
    image: 'pgvector/pgvector:pg18',
    output: 'CORPUS_DATABASE_URL',
  });

  /**
   * The customer database: keys, customers, counters. The managed one, with its
   * backups and its point-in-time recovery, because none of it can be rebuilt.
   */
  const customer = postgres('customer');

  /**
   * The encoder.
   *
   * EmbeddingGemma 2, text 270M, served from the artefact itself: one 157 MB
   * LiteRT bundle, run by `litert-lm` behind an OpenAI-compatible API, with a
   * proxy in front that checks a bearer token because `litert-lm serve` has no
   * authentication of its own.
   *
   * The reason it is self-hosted rather than called: the browser can run the same
   * file, so a client that embeds locally and a server that embeds the corpus are
   * in the same vector space by construction rather than by approximation.
   */
  const encoder = service('encoder', {
    source: github('chester-hill-solutions/civicsignal', {
      rootDirectory: 'services/encoder',
    }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
    },
    healthcheck: '/health',
    healthcheckTimeout: 120,
    variables: {
      ENCODER_TOKEN: ctx.shared.ENCODER_TOKEN,
    },
  });

  /**
   * The continuous ingest.
   *
   * Stateless: it streams the corpus tree from the public repository over HTTPS
   * and keeps only the commit SHA, so it needs no disk, no git binary and no
   * volume. It reconciles by provision — the LIMS id, unique across all
   * 1,128,174 provisions and stable across re-consolidation — and re-embeds only
   * what moved. A typical corpus commit changes 56 provisions.
   */
  const pipeline = service('pipeline', {
    source: github('chester-hill-solutions/civicsignal', {
      rootDirectory: 'services/pipeline',
    }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
    },
    env: {
      // `ref` rather than `corpus.env.…`: the database names its own output, and
      // the SDK's type for a custom output is not modelled yet.
      CORPUS_DATABASE_URL: ref(corpus, 'CORPUS_DATABASE_URL'),
      ENCODER_DOMAIN: encoder.env.RAILWAY_PRIVATE_DOMAIN,
      ENCODER_PORT: '8080',
      ENCODER_TOKEN: ctx.shared.ENCODER_TOKEN,
      GITHUB_TOKEN: ctx.shared.GITHUB_TOKEN,
      // The corpus repository changes every three to eight days. Six hours is
      // often enough, and the pipeline does nothing when the revision has not
      // moved.
      PIPELINE_INTERVAL_SECONDS: '21600',
    },
  });

  const data = group('Data', [corpus, customer]);
  const compute = group('Compute', [encoder, pipeline]);

  // The API and the harness join here as their steps land:
  //
  //   api       step 3 — the Bun server, beside the Worker until the cut over
  //   harness   step 7 — the embedded OpenCode, one directory per customer
  //
  // They are not declared yet because their Dockerfiles do not exist, and an
  // apply that created a service which could not build would break the
  // environment it was supposed to describe.

  return project('civicsignal', {
    resources: [data, compute],
  });
});
