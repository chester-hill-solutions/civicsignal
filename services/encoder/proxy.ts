/**
 * The encoder's front door.
 *
 * `litert-lm serve` has no authentication, and an unauthenticated embedding
 * endpoint on somebody's Railway bill is a liability: the model is public and
 * the endpoint is cheap to abuse, and a scraping job pointed at it costs the
 * owner money without doing anything useful.
 *
 * So the runtime listens on the loopback interface and this proxies it. It
 * checks a bearer token, forwards the request, and refuses everything else.
 *
 * The token is compared in constant time. A timing difference on a shared
 * secret is a real difference, and the fix is two lines.
 */
const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM = `http://127.0.0.1:${process.env.UPSTREAM_PORT ?? 9379}`;
const TOKEN = process.env.ENCODER_TOKEN ?? '';

/** Constant-time comparison of two strings of equal expected length. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function authorised(request: Request): boolean {
  if (!TOKEN) {
    // No token configured is a deployment error, not an open door.
    return false;
  }
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  return safeEqual(presented, TOKEN);
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    // The health check is unauthenticated but says nothing about the model.
    if (new URL(request.url).pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (!authorised(request)) {
      return Response.json(
        { error: { type: 'unauthorized', message: 'A bearer token is required.' } },
        { status: 401 },
      );
    }

    const upstream = await fetch(`${UPSTREAM}${new URL(request.url).pathname}${new URL(request.url).search}`, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: request.method === 'POST' ? await request.text() : undefined,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  },
});

console.log(`the encoder is listening on ${server.port}`);
