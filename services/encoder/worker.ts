/**
 * The encoder, as a Cloudflare Container.
 *
 * **EmbeddingGemma 2 is served from the `.litertlm` artefact** — the same file
 * the browser runs — so the client and the server are in the same vector space
 * by construction rather than approximately. That is the whole reason the
 * product embeds with this file and not with a hosted model.
 *
 * A Worker cannot run it: the file is 157 MB and a Worker's memory limit is
 * 128 MB. A Durable Object cannot either — the same limit. A container can,
 * and it is the same Docker image the Railway deployment would have run, so
 * the artifact is not duplicated: one Dockerfile, two places it can be built.
 *
 * ## The shape
 *
 * A container is reached through a Durable Object, because that is how
 * Cloudflare's containers work: the object owns the container's lifecycle, and
 * it is the thing that makes sure the same container serves the same requests.
 * So there are three pieces:
 *
 *     the Worker  →  the Durable Object  →  the container
 *     (auth)         (the instance)         (the model)
 *
 * The Worker checks the bearer token and nothing else. The object is the
 * instance. The container is the model.
 *
 * The token check is in the Worker rather than in the container because the
 * container's port is only reachable through the object, which is only
 * reachable through the Worker — so the check cannot be bypassed, and it
 * costs nothing in the container's cold start.
 */
import { Container, getContainer } from '@cloudflare/containers';

/** The port the container's service listens on. */
const CONTAINER_PORT = 8080;

export interface Env {
  /** The Durable Object namespace, so the Worker can reach the instance. */
  ENCODER_OBJECT: DurableObjectNamespace<Encoder>;
  /** The shared secret the encoder checks. */
  ENCODER_TOKEN?: string;
}

/**
 * The Durable Object that owns the container.
 *
 * Every request goes to the same container for the same object, so the model
 * is loaded once and stays loaded — which is the difference between an encoder
 * that answers in a second and one that answers in a minute.
 */
export class Encoder extends Container<Env> {
  /** The port the service inside the container listens on. */
  defaultPort = CONTAINER_PORT;

  /** How long the container stays up after its last request. */
  sleepAfter = '10m';

  /** The path the runtime health-checks while the container starts. */
  pingEndpoint = 'health';

  async fetch(request: Request): Promise<Response> {
    const token = this.env.ENCODER_TOKEN ?? '';

    // The token is passed to the container **when it starts**, rather than
    // being put in the container's configuration.
    //
    // The configuration is a file in a repository, and a secret in a
    // configuration file is a secret in a repository. The Durable Object
    // already holds the secret as a binding, so it hands it over at the
    // moment the container needs it, and the container compares against it
    // exactly as it would against any other token.
    const started = await this.ctx.storage.get<string>('token');
    if (started !== token) {
      // A container started with a different token is holding the old one, and
      // starting a running instance does nothing. So it is stopped and started
      // again — which is also what a rotated token wants: the new secret takes
      // effect immediately rather than at the next inactivity timeout.
      await this.stop();
      await this.ctx.storage.put('token', token);
      await this.startAndWaitForPorts({
        ports: [CONTAINER_PORT],
        startOptions: token ? { envVars: { ENCODER_TOKEN: token } } : undefined,
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
      });
    }

    return this.containerFetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      // Unauthenticated, and it says nothing about the model.
      return Response.json({ ok: true });
    }

    if (url.pathname !== '/embed' && url.pathname !== '/embed-query') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    // The token, checked in constant time.
    //
    // An unauthenticated embedding endpoint on somebody's bill is a liability:
    // the model is public, the endpoint is cheap to abuse, and a scraping job
    // pointed at it costs the owner money without doing anything useful.
    const presented = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    const expected = env.ENCODER_TOKEN ?? '';
    if (!expected || !constantTimeEqual(presented, expected)) {
      return Response.json({ error: 'a bearer token is required' }, { status: 401 });
    }

    // The body, read before the request is forwarded, so that a refused
    // request does not leave an unread body on a keep-alive connection — on
    // which the unread body *is* the next request.
    const body = await request.text();

    const stub = getContainer(env.ENCODER_OBJECT, 'encoder');

    // The token goes on to the container, which checks it too.
    //
    // The container's port is only reachable through the object, which is only
    // reachable through this Worker, so the check here cannot be bypassed —
    // but the container is a separate program with its own idea of what a
    // request is, and it is entitled to refuse one that arrives without a
    // token. One token, checked twice, and it is the same token.
    const response = await stub.fetch(
      new Request(`https://encoder${url.pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The token travels in a header of its own, because the Worker's
          // secret is what it forwards — putting the same secret in the
          // container's configuration would put it in a configuration file,
          // and a secret in a configuration file is a secret in a repository.
          'X-Encoder-Token': expected,
        },
        body,
      }),
    );

    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
    });
  },
};

/** The comparison, in constant time. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
