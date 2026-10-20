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

/**
 * Fetch with a token that survives its own expiry.
 *
 * A 401 is treated as "the token needs refreshing" rather than "the request is
 * wrong", because a request that is genuinely unauthorised is a 403 or a 400
 * with a message, and a 401 with no message is a stale token.
 */
export async function fetchWithAuth(
  url: string,
  init: RequestInit = {},
  attempts = 3,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token()}`,
      },
    });
    if (response.status !== 401) return response;
    if (attempt === attempts - 1) return response;
    await refresh();
  }
  throw new Error('unreachable');
}
