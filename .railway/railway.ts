import { defineRailway, github, postgres, project, service } from 'railway/iac';

/**
 * The corpus plane.
 *
 * The product plane — the API, the MCP server, the chat surface, the billing —
 * stays on Cloudflare Workers. It scales to zero, it costs a rounding error per
 * query, and it is already built.
 *
 * The corpus plane needs things a Worker cannot have: a filesystem, a git
 * binary, a process that stays up, and a database with an approximate
 * nearest-neighbour index. The corpus repo is a gigabyte with a hundred and
 * thirty megabytes of history, and it has to be cloned and pulled.
 *
 *   postgres  the corpus rows and their vectors, in one table, in one database
 *   encoder   EmbeddingGemma 2, served from the .litertlm artefact itself
 *   pipeline  the continuous ingest: fetch the corpus, reconcile, embed, write
 *
 * There is no volume. The pipeline does not clone the corpus: it streams the
 * tree from the public repository over HTTPS and keeps only the commit SHA, so
 * it needs no disk, no git binary and no volume that only one service can
 * mount.
 *
 * ## Two secrets, and why they are shared
 *
 * `ENCODER_TOKEN` is a **shared variable**, set once in the dashboard, and both
 * the encoder and the pipeline read it. The encoder's proxy checks it and the
 * pipeline sends it. Two separate variables would be two chances to set them
 * differently, and a mismatch presents as a pipeline that cannot reach the
 * encoder for no visible reason.
 *
 * ## Two variables rather than one URL
 *
 * The pipeline gets the encoder's **domain**, not a URL, and composes the URL
 * at runtime. Railway provides the private domain to every service and it is
 * not known until the service exists, so a URL assembled at plan time would have
 * to be a guess.
 *
 * Apply with `railway config plan` and then `railway config apply`.
 */
export default defineRailway((ctx) => {
  const database = postgres('corpus');

  const encoder = service('encoder', {
    source: github('chester-hill-solutions/civicsignal', {
      rootDirectory: 'services/encoder',
    }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
    },
    healthcheck: '/health',
    variables: {
      ENCODER_TOKEN: ctx.shared.ENCODER_TOKEN,
    },
  });

  const pipeline = service('pipeline', {
    source: github('chester-hill-solutions/civicsignal', {
      rootDirectory: 'services/pipeline',
    }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
    },
    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      // The private domain, not the public one: the pipeline is inside the
      // project, so the encoder does not have to be reachable from the internet.
      ENCODER_DOMAIN: encoder.env.RAILWAY_PRIVATE_DOMAIN,
      ENCODER_PORT: '8080',
      ENCODER_TOKEN: ctx.shared.ENCODER_TOKEN,
      // The corpus repo changes every three to eight days. Six hours is often
      // enough and cheap; the pipeline does nothing when the revision has not
      // moved.
      PIPELINE_INTERVAL_SECONDS: '21600',
    },
  });

  return project('civicsignal', {
    resources: [database, encoder, pipeline],
  });
});
