/**
 * Writing rows into D1.
 *
 * The write path is shared by the load and the repair, because the repair is
 * the load with a different idea of which rows to write. Two copies of a
 * retry loop is two copies of a bug.
 *
 * ## The API, and why it is one row at a time
 *
 * The D1 REST API has no batch endpoint — `/query` takes one statement — so
 * the throughput comes from having several in flight. The account's own limit
 * is what bounds it, and the answer comes back as a 429 when it is reached, so
 * the concurrency is tuned to stay under it rather than to find it.
 *
 * ## The retries, and what they are for
 *
 * Three kinds of failure cost a row, and none of them should:
 *
 * - **A rate limit or a server error.** Nothing was written. Back off.
 * - **A refusal (403).** Cloudflare answers a scattered few of thousands of
 *   requests with "the given account is not valid or is not authorized to
 *   access this service", and the same request with the same token succeeds
 *   moments later. `fetchWithAuth` retries those.
 * - **A dropped connection or a timeout.** The request never got an answer, so
 *   nothing was written, and the row is still there to be written. A throw
 *   must not be the end of a row.
 */
import { fetchWithAuth } from './cloudflare-auth';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'ad5ec479b9a421faa2ed06c3d1c2b23a';
const DATABASE_ID = process.env.D1_DATABASE_ID ?? '8056b1a0-f858-4f89-a332-91f7f350eb7b';

const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

/** The columns, in the order the parameters are given. */
export const COLUMNS = [
  'id',
  'corpus_id',
  'act',
  'citation',
  'section',
  'status',
  'schedule',
  'part',
  'heading',
  'text',
  'source_url',
  'jurisdiction',
  'in_force',
  'language',
  'topics',
  'search_text',
] as const;

const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ');
export const INSERT_SQL = `INSERT OR REPLACE INTO statute_sections (${COLUMNS.join(', ')}) VALUES (${PLACEHOLDERS})`;

export const CONCURRENCY = 6;

export interface Row {
  [key: string]: unknown;
}

/** The parameters for one row, in the order the placeholders expect them. */
export function paramsFor(row: Row): unknown[] {
  return COLUMNS.map((column) => {
    const value = row[column];
    if (value === undefined || value === null) return null;
    return value as string | number;
  });
}

/** One row's parameters, as D1's JSON parameters format wants them. */
export function d1Params(row: Row): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  COLUMNS.forEach((column, index) => {
    const value = row[column];
    params[column] = value === undefined || value === null ? null : (value as string | number);
  });
  return params;
}

/** Run a statement against D1 and return the rows it produced. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const response = await fetchWithAuth(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`D1 refused the query: ${response.status} ${body.slice(0, 300)}`);
  }
  const result = (await response.json()) as {
    success: boolean;
    /** The statement's results, one entry per statement. */
    result?: { results?: T[]; success?: boolean; errors?: { message: string }[] }[];
    errors?: { message: string }[];
  };
  if (!result.success) {
    throw new Error(`D1 refused the query: ${result.errors?.[0]?.message ?? 'unknown'}`);
  }
  const statement = result.result?.[0];
  if (statement && statement.success === false) {
    throw new Error(`D1 refused the query: ${statement.errors?.[0]?.message ?? 'unknown'}`);
  }
  return statement?.results ?? [];
}

/**
 * Write rows, and report what happened.
 *
 * The rows are written in the order they are given, and the returned `failed`
 * list is the rows that did not make it — because a load that reports "done"
 * while quietly dropping rows is the failure mode this whole arrangement
 * exists to prevent.
 */
export async function writeRows(
  rows: Row[],
  options: {
    concurrency?: number;
    onProgress?: (sent: number, total: number) => void;
    /** Called after every row, with whether it was written. */
    onRow?: (index: number, ok: boolean) => void;
  } = {},
): Promise<{ sent: number; failed: number; failures: { id: string; error: string }[] }> {
  const concurrency = options.concurrency ?? CONCURRENCY;
  let sent = 0;
  let failed = 0;
  const failures: { id: string; error: string }[] = [];
  let next = 0;

  const write = async (row: Row): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetchWithAuth(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: INSERT_SQL, params: paramsFor(row) }),
      });

      if (response.status === 429 || response.status >= 500) {
        // A rate limit or a transient failure: back off and try again. The
        // row is not lost, because nothing was written.
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`D1 refused row ${row['id']}: ${response.status} ${body.slice(0, 300)}`);
      }
      const result = (await response.json()) as { success: boolean; errors?: { message: string }[] };
      if (!result.success) {
        throw new Error(`D1 refused row ${row['id']}: ${result.errors?.[0]?.message ?? 'unknown'}`);
      }
      return;
    }
    throw new Error(`D1 kept refusing row ${row['id']}`);
  };

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++;
      if (index >= rows.length) return;
      const row = rows[index]!;
      let ok = false;
      try {
        await write(row);
        ok = true;
      } catch (error) {
        failed++;
        const message = String(error).slice(0, 200);
        failures.push({ id: String(row['id'] ?? index), error: message });
        console.error(`  ${message}`);
      }
      options.onRow?.(index, ok);
      sent++;
      options.onProgress?.(sent, rows.length);
    }
  });
  await Promise.all(workers);

  return { sent, failed, failures };
}
