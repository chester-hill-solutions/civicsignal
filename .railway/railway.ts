import { database, defineRailway, github, group, image, postgres, project, ref, service, preserve, volume } from 'railway/iac';

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
  // The engine is `private`, not `postgres`.
  //
  // `postgres` is Railway's **managed** Postgres, and its image does not ship
  // pgvector — the library is not in the image, so the extension cannot be
  // added afterwards. The corpus holds the vector index, so it has to be a
  // pgvector image, and `private` is the engine that says "this image, with a
  // volume, and no managed features".
  /**
   * The corpus database is a **service running the pgvector image**, not one of
   * Railway's managed databases, and that is a deliberate choice rather than an
   * accident.
   *
   * The corpus holds the vector index, and Railway's managed Postgres image
   * does not ship pgvector — the library is not in the image, so the extension
   * cannot be added afterwards. The image has to be `pgvector/pgvector`.
   *
   * And a managed Postgres with a custom image is something Railway's dashboard
   * can do and **this file cannot express**: `database(name, 'postgres', {
   * image })` creates a managed Postgres and ignores the image, and
   * `database(name, 'private', { image })` is a generic container that Railway
   * gives none of the managed Postgres variables to. A *service* with an image
   * source is the shape that matches what is actually running.
   *
   * The credentials are declared rather than generated, so the database starts
   * with a password that is written down somewhere other than a Railway
   * variable nobody has read. The image reads them on startup.
   *
   * The volume is declared here, because a volume is something this file can
   * say. The corpus is rebuildable — the upstream repository is its backup —
   * but rebuilding it costs two hours of embedding, which is not nothing.
   */
  const corpusVolume = volume('corpus-volume', { mountPath: '/var/lib/postgresql/data' });

  /**
   * The corpus database.
   *
   * A **custom-image** database, because the corpus holds the vector index and
   * Railway's managed Postgres image does not ship pgvector — the library is not
   * in the image, so the extension cannot be added afterwards.
   *
   * The credentials are declared rather than generated, so the database starts
   * with a password that is written down somewhere other than a Railway
   * variable nobody has read. The image reads them on startup.
   */
  const corpus = service('corpus', {
    source: image('pgvector/pgvector:pg18'),
    variables: {
      // The image's own credentials, so the database starts with a password
      // that is written down somewhere other than a Railway variable nobody has
      // read.
      // The credentials the volume was initialised with. A Postgres volume
      // keeps its own password — `POSTGRES_PASSWORD` is only read when the
      // data directory is created — so these have to match what is already
      // there, and the shared password is the shared password.
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: 'railway',
      POSTGRES_PASSWORD: ctx.shared.CORPUS_DATABASE_PASSWORD,
      // **And the connection variables, declared explicitly.**
      //
      // A service running an image is a generic container: Railway does not
      // synthesise `DATABASE_URL` for it, because it does not know the image is
      // Postgres. So the file says what a Postgres would have said, and the
      // plan stops proposing to delete them.
      PGHOST: 'corpus.railway.internal',
      PGPORT: '5432',
      PGDATA: '/var/lib/postgresql/data/pgdata',
      PGDATABASE: 'railway',
      PGUSER: 'postgres',
      PGPASSWORD: ctx.shared.CORPUS_DATABASE_PASSWORD,
      DATABASE_URL: ctx.shared.CORPUS_DATABASE_URL,
    },
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
    // The build context is the **repository root**, not the service's
    // directory: the Dockerfile copies `services/encoder/server.py`, and a
    // context of `services/encoder` has no `services/encoder` inside it.
    source: github('chester-hill-solutions/civicsignal'),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'services/encoder/Dockerfile',
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
    // The build context is the repository root, for the same reason: the
    // Dockerfile copies `package.json`, `src`, `services` and `vendor`, all of
    // which are at the root.
    source: github('chester-hill-solutions/civicsignal'),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'services/pipeline/Dockerfile',
    },
    env: {
      // `ref` rather than `corpus.env.…`: the database names its own output, and
      // the SDK's type for a custom output is not modelled yet.
      // The corpus database's URL, as a shared variable — see the note on the
      // corpus service above for why it is not a reference to a resource in
      // this graph.
      CORPUS_DATABASE_URL: ctx.shared.CORPUS_DATABASE_URL,
      ENCODER_DOMAIN: encoder.env.RAILWAY_PRIVATE_DOMAIN,
      ENCODER_PORT: '8080',
      ENCODER_TOKEN: ctx.shared.ENCODER_TOKEN,
      // The GitHub token is the pipeline's own, set once by hand, and the IaC
      // leaves it alone. Only the pipeline talks to the corpus repository, so
      // there is nothing to share it with — and a shared secret is a secret with
      // two chances to be set differently.
      GITHUB_TOKEN: preserve(),
      // The corpus repository changes every three to eight days. Six hours is
      // often enough, and the pipeline does nothing when the revision has not
      // moved.
      PIPELINE_INTERVAL_SECONDS: '21600',
    },
  });

  /**
   * The API.
   *
   * CivicSignal's server, on Bun. The same brief, the same retrieval and the
   * same language lens as the Cloudflare Worker, over one Postgres with
   * pgvector instead of D1 and Vectorize.
   *
   * It sits **beside** the Worker rather than in front of it: the Worker stays
   * deployable as the rollback until the cut over, so the two can answer side
   * by side for as long as it takes to be sure.
   */
  const api = service('api', {
    // The build context is the repository root, for the same reason as the
    // pipeline's: the Dockerfile copies `package.json`, `src`, `services` and
    // `vendor`, all of which are at the root.
    source: github('chester-hill-solutions/civicsignal'),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'services/api/Dockerfile',
    },
    healthcheck: '/health',
    healthcheckTimeout: 120,
    env: {
      // The corpus database, and the customer database, and the encoder — the
      // three things the API talks to.
      CORPUS_DATABASE_URL: ctx.shared.CORPUS_DATABASE_URL,
      CUSTOMER_DATABASE_URL: customer.env.DATABASE_URL,
      // The encoder's **domain**, not a URL, composed at run time — the private
      // domain is not known until the service exists.
      ENCODER_URL: `http://${encoder.env.RAILWAY_PRIVATE_DOMAIN}:8080`,
      ENCODER_TOKEN: ctx.shared.ENCODER_TOKEN,
      FREE_FUSE_LIMIT: '1000',
    },
  });

  const data = group("Data", [corpus, customer, corpusVolume]);
  const compute = group('Compute', [encoder, pipeline, api]);

  // The harness joins here as its step lands:
  //
  //   harness   step 7 — the embedded OpenCode, one directory per customer
  //
  // It is not declared yet because its Dockerfile does not exist, and an apply
  // that created a service which could not build would break the environment it
  // was supposed to describe.

  return project('civicsignal', {
    resources: [data, compute],
  });
});
