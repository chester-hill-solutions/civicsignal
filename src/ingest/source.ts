
/**
 * The corpus, as a source rather than a filesystem.
 *
 * The corpus is a public git repository, and the pipeline needs exactly two
 * things from it: the revision it is at, and the content of the instruments at
 * that revision. It does **not** need a working tree.
 *
 * That distinction is worth a gigabyte. A clone is 1 GB on disk with 130 MB of
 * git history, it needs a git binary, it needs a volume that only one service
 * can mount, and a `git pull` over object storage is thousands of small round
 * trips against a filesystem with no rename and no partial writes — and an
 * interrupted pull leaves a corrupt tree.
 *
 * So the pipeline is **stateless**. It asks GitHub what the current revision is,
 * streams the tree for that revision, parses each instrument as it arrives, and
 * writes what changed. The only state is the commit SHA, which is already in
 * `corpus_state`.
 *
 * The tree comes as a tarball — one request, no rate limit, no pagination —
 * and it is **streamed**, not extracted. The whole archive is 878 MB; the
 * English instruments are 321 MB of it in 5,868 files, the largest of which is
 * 13 MB. Decompressed one instrument at a time, the pipeline's memory cost is
 * the size of the largest instrument rather than the size of the corpus.
 *
 * The consequence is that the pipeline can run anywhere: a Railway service, a
 * cron job, a GitHub Action. It has no disk and no image to keep warm.
 */

export const CORPUS_REPO = 'justicecanada/laws-lois-xml';
const API = `https://api.github.com/repos/${CORPUS_REPO}`;
const TARBALL = `https://codeload.github.com/${CORPUS_REPO}/tar.gz`;

/** The paths in the corpus this product ingests. */
export const INSTRUMENT_PATHS = [
  'eng/acts/',
  'eng/regulations/',
] as const;

/** The same tree, in French. The corpus has it; the ingest was looking in the wrong place. */
export const FRENCH_INSTRUMENT_PATHS = ['fra/lois/', 'fra/reglements/'] as const;

export interface CorpusRevision {
  commit: string;
  date: string;
}

export interface InstrumentFile {
  /** The path within the corpus, e.g. `eng/acts/C-34.xml`. */
  path: string;
  content: string;
}

export interface CorpusSource {
  /** The revision the corpus is at. */
  head(): Promise<CorpusRevision>;
  /** Every instrument file at a revision, streamed. */
  instruments(revision: string, paths?: readonly string[]): AsyncGenerator<InstrumentFile>;
}

/**
 * The corpus, over HTTPS.
 *
 * Nothing is stored, so a run can be interrupted and repeated: the store's
 * `corpus_state` says which revision it is at, and the run picks up from there.
 */
export class GitHubCorpusSource implements CorpusSource {
  constructor(
    private readonly options: {
      /** A token raises the rate limit from 60 requests an hour to 5,000. */
      token?: string;
      /** The branch to follow. */
      branch?: string;
      /** Overridable for tests. */
      api?: string;
      tarball?: string;
    } = {},
  ) {}

  private get api(): string {
    return this.options.api ?? API;
  }

  private get tarball(): string {
    return this.options.tarball ?? TARBALL;
  }

  private headers(accept: string): Record<string, string> {
    return {
      accept,
      'user-agent': 'civicsignal-corpus-pipeline',
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
    };
  }

  async head(): Promise<CorpusRevision> {
    const branch = this.options.branch ?? 'main';
    const response = await fetch(`${this.api}/commits/${branch}`, {
      headers: this.headers('application/vnd.github+json'),
    });
    if (!response.ok) {
      throw new Error(`the corpus repository returned ${response.status}`);
    }
    const body = (await response.json()) as {
      sha?: string;
      commit?: { committer?: { date?: string } };
    };
    if (!body.sha) throw new Error('the corpus repository did not name a revision');
    return { commit: body.sha, date: body.commit?.committer?.date?.slice(0, 10) ?? '' };
  }

  /**
   * Stream the instruments at a revision.
   *
   * The tarball is fetched for a **pinned SHA**, not for the branch, so the tree
   * cannot shift under the run: the revision `head()` named is the revision that
   * gets parsed.
   */
  async *instruments(
    revision: string,
    paths: readonly string[] = INSTRUMENT_PATHS,
  ): AsyncGenerator<InstrumentFile> {
    const response = await fetch(`${this.tarball}/${revision}`, {
      headers: this.headers('application/vnd.github+json'),
    });
    if (!response.ok) {
      throw new Error(`the corpus tarball returned ${response.status}`);
    }
    if (!response.body) throw new Error('the corpus tarball had no body');

    // **The web standard, not `node:zlib`.**
    //
    // `DecompressionStream` is in every runtime that has a `fetch` — Bun, Node,
    // and the Workers runtime — and `node:zlib` is in none of the Workers
    // runtime's guaranteed surface. The pipeline is about to run *as* a Worker,
    // and a module that imports `node:zlib` cannot be bundled for one.
    //
    // The tar reader takes an async iterable of buffers and `Buffer.from`
    // accepts a `Uint8Array`, so the chunks arrive as they do and are wrapped
    // where they are used.
    const gunzip = response.body.pipeThrough(new DecompressionStream('gzip'));

    for await (const entry of readTar(gunzip)) {
      if (!entry.path.endsWith('.xml')) continue;
      // The archive's entries are prefixed with the repository and the revision,
      // e.g. "laws-lois-xml-main/eng/acts/C-34.xml".
      const normalised = entry.path.replace(/^[^/]+\//, '');
      if (!paths.some((prefix) => normalised.startsWith(prefix))) continue;
      yield { path: normalised, content: entry.content.toString('utf8') };
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * A tar reader
 * ──────────────────────────────────────────────────────────────────────────── */

const BLOCK = 512;

interface TarHeader {
  name: string;
  size: number;
  type: string;
}

/**
 * Read a tar stream.
 *
 * The format is simple enough to read directly and simple enough to test, and
 * it is the difference between the pipeline needing a gigabyte of disk and
 * needing none. Git's archive format is what the tarball already is.
 */
export async function* readTar(
  // The chunks arrive as `Uint8Array` — that is what a `ReadableStream`
  // yields, in every runtime — and are wrapped where they are used.
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ path: string; content: Buffer }> {
  const iterator = source[Symbol.asyncIterator]();

  /**
   * The bytes that have arrived but not been consumed.
   *
   * A queue rather than one buffer, and that is the whole trick. Appending to a
   * single buffer means copying it on every chunk, and the corpus's largest
   * instrument is 14 MB, so a 64 KB chunk size would copy a gigabyte to read
   * one file — and the archive is 878 MB. The queue copies each byte once.
   */
  const chunks: Buffer[] = [];
  let queued = 0;
  let exhausted = false;

  async function pull(): Promise<boolean> {
    if (exhausted) return false;
    const next = await iterator.next();
    if (next.done) {
      exhausted = true;
      return false;
    }
    const chunk = Buffer.from(next.value);
    chunks.push(chunk);
    queued += chunk.length;
    return true;
  }

  /** Take exactly `count` bytes off the front of the queue, or null if there are not that many. */
  function take(count: number): Buffer | null {
    if (queued < count) return null;
    const out = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const head = chunks[0]!;
      const slice = Math.min(head.length, count - written);
      head.copy(out, written, 0, slice);
      written += slice;
      if (slice === head.length) chunks.shift();
      else chunks[0] = head.subarray(slice);
    }
    queued -= count;
    return out;
  }

  /**
   * Discard the padding that follows an entry's content.
   *
   * It is at most 511 bytes and it sits immediately after the content, so it is
   * usually already in the queue. When it is not, more has to arrive — and the
   * bytes taken have to be exactly the padding, because taking the whole queue
   * would swallow the next entry's header and everything after it would be
   * garbage. That failure only shows when a chunk boundary lands inside an
   * entry, which is why reading a whole archive in one piece never sees it.
   */
  async function discardPadding(size: number): Promise<void> {
    const padding = padded(size) - size;
    if (padding <= 0) return;
    while (queued < padding) {
      if (!(await pull())) return;
    }
    take(padding);
  }

  let pending: TarHeader | null = null;
  let longName: string | null = null;

  for (;;) {
    if (!pending) {
      let block: Buffer | null = null;
      while (!block) {
        if (queued < BLOCK && !(await pull())) return;
        block = take(BLOCK);
      }
      const header = parseTarHeader(block!);
      if (!header) return; // the end-of-archive marker
      if (header.type === 'L') {
        // A long name: the body of this entry is the name, and the next header
        // is the file's own.
        while (queued < header.size) {
          if (!(await pull())) return;
        }
        longName = take(header.size)!.toString('utf8').replace(/\0+$/, '');
        await discardPadding(header.size);
        continue;
      }
      pending = header;
    }

    const header = pending;
    while (queued < header.size) {
      if (!(await pull())) return;
    }
    const body = take(header.size)!;
    await discardPadding(header.size);
    pending = null;

    // '0' and '\0' are a regular file; '5' is a directory.
    if (header.type === '0' || header.type === '\0') {
      const path = longName ?? header.name;
      longName = null;
      yield { path, content: body };
    } else {
      // A long name belongs to the next file, not to this one. Leaving it set
      // would attach it to whatever file came after.
      longName = null;
    }
  }
}

/** The number of bytes an entry occupies, padded to the block size. */
function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function parseTarHeader(block: Buffer): TarHeader | null {
  // Two zero blocks mark the end of the archive.
  if (block.every((byte) => byte === 0)) return null;
  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  const sizeText = readString(block, 124, 12).replace(/\0/g, '').trim();
  const size = sizeText ? parseInt(sizeText, 8) : 0;
  const type = String.fromCharCode(block[156] ?? 48);
  return { name: prefix ? `${prefix}/${name}` : name, size, type };
}

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}
