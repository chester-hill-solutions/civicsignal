"""Seed the dedicated, unbound committee staging D1 from the approved session base.

Set up the new database with preview/committees/migrations, then run
python3 scripts/seed-committee-staging.py [--probe]. Each imported file carries
its own transactional checkpoint. A retry re-derives and checks every checkpoint.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
LOCAL = runpy.run_path(str(ROOT / "scripts/materialize-committee-corpus.py"))
TABLES, KEYS = LOCAL["TABLES"], LOCAL["KEYS"]
SESSION = "45-1"
ACCOUNT = "ad5ec479b9a421faa2ed06c3d1c2b23a"
DATABASE = "fb9b6314-4b06-4690-a893-7277a8ea00bb"
NAME = "civicsignal-stage-committees-45-1"
BASE = ROOT / "docs/evidence/2026-11-25/committee-cloudflare-base.json"
SOURCE = ROOT / "data/corpus/committees/committee.sqlite"
MAX_STATEMENT_BYTES = 90_000
SHARD_BYTES = 4 * 1024 * 1024
PILOT_BYTES = 512 * 1024
FTS_ROWS = 10_000


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    if not isinstance(value, str) or "\0" in value:
        raise ValueError("Unexpected committee SQL value")
    return "'" + value.replace("'", "''") + "'"


def statements(rows, table):
    prefix = f"INSERT INTO {table} ({','.join(TABLES[table])}) VALUES ".encode()
    parts, size = [], len(prefix) + 2
    for row in rows:
        item = ("(" + ",".join(literal(value) for value in row) + ")").encode()
        if len(prefix) + len(item) + 2 > MAX_STATEMENT_BYTES:
            raise ValueError(f"{table} tuple exceeds the supported D1 statement size")
        if size + len(item) + bool(parts) > MAX_STATEMENT_BYTES:
            yield prefix + b",".join(parts) + b";\n", len(parts)
            parts, size = [], len(prefix) + 2
        size += len(item) + bool(parts)
        parts.append(item)
    if parts:
        yield prefix + b",".join(parts) + b";\n", len(parts)


def shards(statements):
    content = bytearray()
    count = 0
    limit = PILOT_BYTES
    for sql, rows in statements:
        if len(content) + len(sql) > limit and content:
            yield content, count
            content, count, limit = bytearray(), 0, SHARD_BYTES
        content.extend(sql)
        count += rows
    if content:
        yield content, count


def index_shards(maximum):
    content = bytearray()
    count = 0
    for lo in range(1, maximum + 1, FTS_ROWS):
        hi = min(lo + FTS_ROWS - 1, maximum)
        content.extend(
            (
                f"INSERT INTO cc_fts(rowid,session,language,document_id,position,text) "
                f"SELECT rowid,session,language,document_id,position,text FROM cc_passages WHERE rowid BETWEEN {lo} AND {hi};\n"
            ).encode()
        )
        count += hi - lo + 1
        if lo == 1 or count == 5 * FTS_ROWS:
            yield content, count
            content, count = bytearray(), 0
    if content:
        yield content, count


def cli(args, *, env=None):
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, **(env or {})},
    )
    if result.returncode:
        raise RuntimeError(
            f"{Path(args[0]).name} failed: {result.stderr[-1200:]} {result.stdout[-500:]}"
        )
    output = result.stdout.strip()
    # Wrangler can write config notices before its --json array.
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        for index in range(len(output)):
            if output[index : index + 2] == "[\n":
                try:
                    return json.JSONDecoder().raw_decode(output[index:])[0]
                except json.JSONDecodeError:
                    continue
        raise ValueError(f"{Path(args[0]).name} did not return a structured result")


def cf(*args):
    read = args[0] in ("get", "raw") or (
        args[0] == "query" and args[-1].lstrip().upper().startswith("SELECT")
    )
    for attempt in range(3):
        try:
            return cli(["cf", "d1", *args])
        except RuntimeError as error:
            if not read or attempt == 2 or not transient(error):
                raise
            delay = 12 * (attempt + 1) if "7429" in str(error) else 2**attempt
            time.sleep(delay)


def transient(error):
    return any(
        message in str(error).lower()
        for message in ("fetch failed", "timeout", "429", "503", "502")
    )


def query(sql):
    results = cf("query", DATABASE, "--sql", sql)
    if not results or any(not result.get("success") for result in results):
        raise RuntimeError("Staging D1 query failed")
    return results[-1]["results"]


def identify():
    remote = cf("get", DATABASE)
    if remote["uuid"] != DATABASE or remote["name"] != NAME:
        raise RuntimeError("Unexpected D1 identity")
    return remote


def initialize(base_id):
    sql = "SELECT name FROM sqlite_schema WHERE name='cc_seed_identity'"
    if not query(sql):
        migration = query("SELECT name FROM d1_migrations ORDER BY name")
        if migration != [{"name": "0001_committee_preview.sql"}]:
            raise RuntimeError("Expected a freshly migrated staging D1")
        for table in [*TABLES, "cc_snapshot", "cc_fts_docsize"]:
            if query(f"SELECT 1 AS existing FROM {table} LIMIT 1"):
                raise RuntimeError(f"Will not seed untracked data in {table}")
        query(f"""CREATE TABLE cc_seed_identity(base TEXT PRIMARY KEY);
            INSERT INTO cc_seed_identity VALUES({literal(base_id)});
            CREATE TABLE cc_seed_chunks(phase TEXT, ordinal INTEGER, rows INTEGER, digest TEXT,
              PRIMARY KEY(phase,ordinal))""")
    if query("SELECT base FROM cc_seed_identity") != [{"base": base_id}]:
        raise RuntimeError("Destination belongs to a different source snapshot")


def write_chunk(tmp, config, phase, ordinal, content, rows, prior):
    digest = sha256(content).hexdigest()
    expected = {"phase": phase, "ordinal": ordinal, "rows": rows, "digest": digest}
    if (phase, ordinal) in prior:
        if prior[(phase, ordinal)] != expected:
            raise RuntimeError(
                f"Committed {phase} chunk {ordinal} does not match source"
            )
        return
    stamp = f"INSERT INTO cc_seed_chunks VALUES ({literal(phase)},{ordinal},{rows},{literal(digest)});\n".encode()
    path = tmp / "chunk.sql"
    with path.open("wb") as file:
        file.write(content)
        file.write(stamp)
    start = time.monotonic()
    wrangler = str(ROOT / "node_modules/.bin/wrangler")
    command = [
        wrangler,
        "d1",
        "execute",
        "SEED",
        "--config",
        str(config),
        "--remote",
        "--yes",
        "--json",
        "--file",
        str(path),
    ]
    for attempt in range(3):
        try:
            (result,) = cli(
                command,
                env={
                    "WRANGLER_SEND_METRICS": "false",
                    "WRANGLER_LOG_PATH": str(tmp / "wrangler.log"),
                },
            )
            if not result.get("success"):
                raise RuntimeError(f"D1 import failed for {phase} {ordinal}")
            meta = result["meta"]
            break
        except (ValueError, RuntimeError) as error:
            # A lost client response after commit must not replay a completed chunk.
            marker = query(
                f"SELECT * FROM cc_seed_chunks WHERE phase={literal(phase)} AND ordinal={ordinal}"
            )
            if marker == [expected]:
                meta = {"verifiedRemoteCheckpoint": True}
                break
            if marker or not transient(error) or attempt == 2:
                raise
            print(
                json.dumps(
                    {"retryingChunk": phase, "ordinal": ordinal, "attempt": attempt + 1}
                ),
                flush=True,
            )
            time.sleep(2**attempt)
    print(
        json.dumps(
            {
                **expected,
                "bytes": path.stat().st_size,
                "seconds": round(time.monotonic() - start, 3),
                "meta": meta,
            }
        ),
        flush=True,
    )
    path.unlink()


def verify_tables(expected):
    """Fetch every stored column in bounded pages and reproduce the source digests."""
    verified = {}
    for table, columns in TABLES.items():
        count = expected[table]["count"]
        bounds = query(
            f"SELECT MIN(rowid) AS first, MAX(rowid) AS last, COUNT(*) AS n FROM {table}"
        )[0]
        if bounds != {"first": 1, "last": count, "n": count}:
            raise ValueError(f"{table} destination bounds differ from the source")

        def read_page(first):
            last = min(first + page_size - 1, count)
            sql = f"SELECT {','.join(columns)} FROM {table} WHERE rowid BETWEEN {first} AND {last} ORDER BY rowid"
            (result,) = cf("raw", DATABASE, "--sql", sql)
            data = result["results"]
            if (
                not result["success"]
                or data["columns"] != list(columns)
                or len(data["rows"]) != last - first + 1
            ):
                raise RuntimeError(f"Invalid remote {table} readback at {first}")
            return data["rows"]

        page_size = 5000 if table == "cc_records" else 12_000
        starts = range(1, count + 1, page_size)
        digest = sha256()
        chars = rows = 0
        text_col = columns.index("text") if "text" in columns else None
        with ThreadPoolExecutor(max_workers=3) as pool:
            for i in range(0, len(starts), 3):
                for page in pool.map(read_page, starts[i : i + 3]):
                    for row in page:
                        rows += 1
                        if text_col is not None:
                            chars += len(row[text_col])
                        LOCAL["_fingerprint_row"](digest, row)
        result = {"count": rows, "textCharacters": chars, "sha256": digest.hexdigest()}
        if result != expected[table]:
            raise ValueError(f"{table} hosted contents differ from the verified source")
        verified[table] = {**result, "readPages": len(starts)}
        print(json.dumps({"verifiedTable": table, **verified[table]}), flush=True)
    return verified


def verify_vocabulary(source):
    """Compare every term and its FTS document/occurrence frequencies in bounded pages."""
    source.execute(
        "CREATE VIRTUAL TABLE temp.cc_seed_local_vocab USING fts5vocab(main,cc_fts,'row')"
    )
    query(
        "CREATE VIRTUAL TABLE IF NOT EXISTS cc_seed_vocab USING fts5vocab(cc_fts,'row')"
    )
    cursor = source.execute(
        "SELECT term,doc,cnt FROM cc_seed_local_vocab ORDER BY term"
    )
    after, page_size = "", 2000
    terms = documents = occurrences = pages = 0
    digest = sha256()
    while True:
        expected = [tuple(row) for row in cursor.fetchmany(page_size)]
        sql = f"SELECT term,doc,cnt FROM cc_seed_vocab WHERE term>{literal(after)} ORDER BY term LIMIT {page_size}"
        (result,) = cf("raw", DATABASE, "--sql", sql)
        actual = [tuple(row) for row in result["results"]["rows"]]
        pages += 1
        if not result["success"] or actual != expected:
            raise ValueError(
                f"Destination FTS frequencies differ at vocabulary offset {terms}"
            )
        if not actual:
            break
        for row in actual:
            LOCAL["_fingerprint_row"](digest, row)
            terms += 1
            documents += row[1]
            occurrences += row[2]
        after = actual[-1][0]
    return {
        "terms": terms,
        "termDocuments": documents,
        "occurrences": occurrences,
        "sha256": digest.hexdigest(),
        "readPages": pages,
    }


def verify_index(source, expected):
    count = expected["cc_passages"]["count"]
    # docsize has one unique integer primary key per indexed document. These
    # three indexed queries cover exactly the passage rowids, including both ends.
    ids = query(
        "SELECT (SELECT MIN(id) FROM cc_fts_docsize) AS first, "
        "(SELECT MAX(id) FROM cc_fts_docsize) AS last, (SELECT COUNT(*) FROM cc_fts_docsize) AS n"
    )[0]
    if ids != {"first": 1, "last": count, "n": count}:
        raise ValueError(
            "FTS indexed document rowids differ from the contiguous passage rowids"
        )
    vocab = verify_vocabulary(source)
    probes = []
    for lang, term in [
        ("en", "Honourable"),
        ("fr", "comité"),
        ("en", "college"),
        ("fr", "collège"),
    ]:
        where = f" FROM cc_fts WHERE cc_fts MATCH {literal(term)} AND session={literal(SESSION)} AND language={literal(lang)}"
        count_sql = "SELECT COUNT(*) AS n" + where
        local = source.execute(count_sql).fetchone()[0]
        actual = query(count_sql)[0]["n"]
        if actual != local or actual == 0:
            raise ValueError(f"Hosted FTS lookup mismatch in {lang} for {term}")
        digest, matched = sha256(), 0
        for offset in sorted({0, local // 2, max(0, local - 12)}):
            select = "SELECT language,document_id,position" + where
            native = " ORDER BY language,document_id,position"
            limit = f" LIMIT 12 OFFSET {offset}"
            expected_hits = [
                dict(row) for row in source.execute(select + native + limit)
            ]
            # This seed inserts passage rowids in primary-key order.
            remote_hits = query(select + " ORDER BY rowid" + limit)
            if remote_hits != expected_hits:
                raise ValueError(
                    f"Hosted FTS points at different passage keys for {lang}/{term}"
                )
            for row in remote_hits:
                LOCAL["_fingerprint_row"](
                    digest, (row["language"], row["document_id"], row["position"])
                )
            matched += len(remote_hits)
        probes.append(
            {
                "language": lang,
                "term": term,
                "matches": actual,
                "orderedPassageKeysCompared": matched,
                "sampleSha256": digest.hexdigest(),
            }
        )
    return {"documentRowids": ids, "allVocabularyTerms": vocab, "matches": probes}


def verify_and_publish(source, base):
    verified = verify_tables(base)
    search = verify_index(source, base)
    cutoff = base["cutoff"]
    old = query("SELECT session,cutoff FROM cc_snapshot")
    if old and old != [{"session": SESSION, "cutoff": cutoff}]:
        raise ValueError("Destination cutoff differs from this seed")
    query(
        f"INSERT INTO cc_snapshot SELECT {literal(SESSION)}, {literal(cutoff)} WHERE NOT EXISTS(SELECT 1 FROM cc_snapshot)"
    )
    published = query("SELECT session,cutoff FROM cc_snapshot")
    if published != [{"session": SESSION, "cutoff": cutoff}]:
        raise ValueError("Could not verify published staging snapshot cutoff")
    print(
        json.dumps(
            {
                "verifiedTables": verified,
                "verifiedFts": search,
                "publishedSnapshot": published,
                "database": identify(),
            }
        ),
        flush=True,
    )


def run(args):
    target = identify()
    print(
        json.dumps(
            {
                "target": target["name"],
                "id": target["uuid"],
                "databaseBytes": target["file_size"],
            }
        ),
        flush=True,
    )
    base = json.loads(BASE.read_bytes())["servingTables"]
    base_id = sha256(json.dumps(base, sort_keys=True).encode()).hexdigest()
    with (
        closing(LOCAL["connect"](args.source, readonly=True)) as source,
        tempfile.TemporaryDirectory(prefix="committee-stage-seed-") as directory,
    ):
        # One consistent SQLite snapshot covers source verification and export.
        source.execute("BEGIN")
        if LOCAL["table_stats"](source, SESSION) != base:
            raise ValueError("Source differs from verified staging base")
        initialize(base_id)
        if args.verify_and_publish_cutoff:
            verify_and_publish(source, base)
            return
        prior = {
            (r["phase"], r["ordinal"]): r for r in query("SELECT * FROM cc_seed_chunks")
        }
        tmp = Path(directory)
        config = tmp / "wrangler.json"
        config.write_text(
            json.dumps(
                {
                    "name": "committee-seed-local-config",
                    "compatibility_date": "2026-10-22",
                    "account_id": ACCOUNT,
                    "d1_databases": [
                        {
                            "binding": "SEED",
                            "database_name": NAME,
                            "database_id": DATABASE,
                        }
                    ],
                }
            )
        )
        for table in TABLES:
            rows = LOCAL["_rows"](source, table, SESSION)
            for i, (content, count) in enumerate(shards(statements(rows, table))):
                write_chunk(tmp, config, table, i, content, count, prior)
                if args.probe:
                    return
        bounds = query(
            "SELECT MIN(rowid) AS first, MAX(rowid) AS last, COUNT(*) AS n FROM cc_passages"
        )[0]
        if bounds != {
            "first": 1,
            "last": base["cc_passages"]["count"],
            "n": base["cc_passages"]["count"],
        }:
            raise ValueError(
                "Destination passages must have complete contiguous rowids before building the index"
            )
        for i, (content, count) in enumerate(index_shards(bounds["last"])):
            write_chunk(tmp, config, "fts", i, content, count, prior)
        verify_and_publish(source, base)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--verify-and-publish-cutoff",
        action="store_true",
        help="Verify all staged data and set the cutoff after verification",
    )
    mode.add_argument(
        "--probe", action="store_true", help="Import only the first real chunk"
    )
    run(parser.parse_args())
