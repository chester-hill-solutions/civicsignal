/**
 * Talking to the Cloudflare API with a token that expires.
 *
 * The wrangler OAuth token lasts an hour, and a corpus job lasts longer than
 * that: embedding 254,671 provisions takes hours, and loading them takes
 * longer. So a long job needs a way to keep its token fresh, and the answer
 * is not a new token — it is wrangler's own, which refreshes itself.
 *
 * So the token is **read from wrangler's configuration on every call** rather
 * than captured once, and a refusal triggers a refresh: wrangler is run, it
 * notices the token has expired, refreshes it and writes the new one back to
 * the configuration, and the call is retried.
 *
 * Running wrangler is the refresh. It is not elegant, but it is the same
 * refresh wrangler would have done on its own, it needs no OAuth client
 * credentials of our own, and it cannot fail in a way wrangler's own
 * authentication would not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where wrangler keeps its credentials. */
function configPath(): string {
  return join(process.env.HOME ?? '.', '.wrangler', 'config', 'default.toml');
}

/** The current token, read fresh. */
export function token(): string {
  const config = readFileSync(configPath(), 'utf8');
  const found = /oauth_token\s*=\s*"([^"]+)"/.exec(config)?.[1];
  if (!found) {
    throw new Error(
      'no Cloudflare token found. Run `npx wrangler login` — the token is the same one wrangler uses.',
    );
  }
  return found;
}

/**
 * Force wrangler to refresh its token.
 *
 * Wrangler refreshes when the token has expired, and it writes the new token
 * back to its configuration, so the next read of the token picks it up.
 */
async function refresh(): Promise<void> {
  const proc = Bun.spawnSync(
    ['npx', 'wrangler', 'd1', 'execute', 'civicsignal', '--remote', '--command', 'SELECT 1'],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  if (proc.exitCode !== 0) {
    // A failed refresh is not fatal by itself: the token may still be valid.
    // The caller retries and finds out.
  }
}

/** Back off before trying again. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a token that survives its own expiry, and against an API that
 * says no sometimes.
 *
 * A 401 is treated as "the token needs refreshing" rather than "the request is
 * wrong", because a request that is genuinely unauthorised is a 403 or a 400
 * with a message, and a 401 with no message is a stale token.
 *
 * **A 403 is not the end of the request.** The corpus load saw thousands of
 * them — code 7403, "the given account is not valid or is not authorized to
 * access this service" — scattered through a run that was otherwise perfectly
 * healthy, and the *same* request with the *same* token succeeds moments later.
 * So it is a refusal, not a verdict: back off and try again. A refusal that
 * *is* a verdict — a wrong database, a wrong account — survives the retries and
 * is still refused, which is the right outcome for it.
 *
 * **A thrown error is not the end of the request either.** A timeout or a reset
 * connection means the request never got an answer, so nothing was written, and
 * the row is still there to be written. An earlier version of the load let the
 * throw escape the retry loop, and six rows went missing that way.
 */
export async function fetchWithAuth(
  url: string,
  init: RequestInit = {},
  attempts = 6,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token()}`,
        },
      });
    } catch (error) {
      // The request never reached the API. Nothing was written.
      if (attempt === attempts - 1) throw error;
      await sleep(250 * 2 ** attempt);
      continue;
    }

    if (response.status === 401) {
      if (attempt === attempts - 1) return response;
      await refresh();
      continue;
    }
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      // Back off and try again. The body is not read here: the caller reads it
      // when it gives up, and a refusal that is a refusal keeps its body.
      if (attempt === attempts - 1) return response;
      await sleep(250 * 2 ** attempt);
      continue;
    }
    return response;
  }
  throw new Error('unreachable');
}
