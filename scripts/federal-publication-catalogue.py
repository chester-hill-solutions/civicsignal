"""Build and query a local bibliography from the published base and bilingual weekly checklists."""
import argparse
from contextlib import closing
import fcntl
import hashlib
from importlib import import_module
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from zipfile import ZipFile

base_intake = import_module("federal-publications")
BASE = base_intake.DEFAULT_ROOT
CHECKLISTS = Path("data/corpus/federal-publication-checklists")
DATABASE = Path("data/corpus/federal-publication-catalogue/catalogue.sqlite")
SCHEMA = 2
NS = {"m": "http://www.loc.gov/mods/v3"}


def sha_file(path):
    with path.open("rb") as input_file:
        return hashlib.file_digest(input_file, "sha256").hexdigest()


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def inputs(base, checklists):
    base_dir, week_dir = (base / "current").resolve(strict=True), (checklists / "current").resolve(strict=True)
    base_receipt = json.loads((base_dir / "receipt.json").read_bytes())
    week = json.loads((week_dir / "receipt.json").read_bytes())
    if (set(base_receipt["resources"]) != set(base_intake.EXPECTED) or base_receipt["snapshotDate"] != week["baseSnapshotDate"]
            or week["status"] != "complete"):
        raise ValueError("Expected a complete bibliography and subsequent checklists with the same base date")
    sources = {}
    for category, entry in base_receipt["resources"].items():
        sources[category] = {"path": base_dir / "archives" / (category + ".zip"), "sha256": entry["sha256"],
                             "records": entry["recordCount"], "format": entry["format"], "url": entry["finalUrl"],
                             "snapshotDate": base_receipt["snapshotDate"]}
    sources["weekly-checklists"] = {"path": week_dir / "records.jsonl", "sha256": week["recordsSha256"],
                                    "records": week["aggregateRecordCount"], "format": "JSONL",
                                    "latestIssue": week["range"]["latestIssue"]}
    for source in sources.values():
        if sha_file(source["path"]) != source["sha256"]:
            raise ValueError(f"Published archive differs from its receipt: {source['path']}")
    return sources


def text_of(node):
    return " ".join("".join(node.itertext()).split())


def base_rows(category, source):
    with ZipFile(source["path"]) as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue
            filename = member.filename.lower()
            with archive.open(member) as stream:
                if filename.endswith(".xml"):
                    for identifier, title, record in base_intake.iter_mods_records(stream):
                        names = []
                        for corporate in record.findall("m:name[@type='corporate']", NS):
                            name = " ".join(text_of(n) for n in corporate.findall("m:namePart", NS))
                            if name:
                                names.append({"label": name, "roles": [text_of(r) for r in corporate.findall("m:role/m:roleTerm", NS)]})
                        metadata = {"corporateNames": names,
                                    "publishers": [text_of(n) for n in record.findall("m:originInfo/m:publisher", NS)],
                                    "datesIssued": [text_of(n) for n in record.findall("m:originInfo/m:dateIssued", NS)],
                                    "languages": [text_of(n) for n in record.findall("m:language/m:languageTerm", NS)],
                                    "links": [{"url": text_of(n), "label": n.get("displayLabel")}
                                              for n in record.findall("m:location/m:url", NS)]}
                        yield category, identifier, title, json_text(metadata)
                elif filename.endswith((".mrc", ".marc")):
                    for identifier, title, encoding in base_intake.iter_records(stream):
                        yield category, identifier, title, json_text({"titleEncoding": encoding})


def weekly_rows(source):
    with source["path"].open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            # Preserve the complete parsed MARC row in the query database:
            # corporate relators, imprint functions, and 856 links stay paired
            # with their exact catalogue record instead of becoming lookalikes
            # inferred from the cataloging agency code.
            yield "weekly-checklists", row["catalogueId"], row["title"], json_text(row)


def open_reader(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def build(db_path, base, checklists):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with db_path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sources = inputs(base, checklists)
        listed = {k: {f: v for f, v in s.items() if f != "path"} for k, s in sources.items()}
        identity = hashlib.sha256(json_text([SCHEMA, listed]).encode()).hexdigest()
        expected = {k: v["records"] for k, v in sources.items()}
        if db_path.exists():
            with closing(open_reader(db_path)) as db:
                prior = db.execute("SELECT identity FROM publication").fetchone()
                counts = dict(db.execute("SELECT source,COUNT(*) FROM records GROUP BY source"))
                if prior == (identity,) and counts == expected and db.execute("PRAGMA quick_check").fetchone() == ("ok",):
                    return {"identity": identity, "rows": sum(counts.values()), "sources": counts, "reused": True}
        fd, tempname = tempfile.mkstemp(prefix="catalogue-", suffix=".sqlite", dir=db_path.parent)
        os.close(fd)
        temporary = Path(tempname)
        try:
            with closing(sqlite3.connect(temporary)) as db:
                db.execute("CREATE TABLE records(source TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, metadata TEXT NOT NULL)")
                db.execute("CREATE TABLE publication(identity TEXT NOT NULL, sources TEXT NOT NULL)")
                for category, source in sources.items():
                    rows = weekly_rows(source) if category == "weekly-checklists" else base_rows(category, source)
                    db.executemany("INSERT INTO records VALUES (?,?,?,?)", rows)
                counts = dict(db.execute("SELECT source,COUNT(*) FROM records GROUP BY source"))
                if counts != expected:
                    raise ValueError(f"Bibliography counts differ from acquisition receipts: {counts}")
                db.execute("CREATE INDEX records_id ON records(id)")
                db.execute("INSERT INTO publication VALUES (?,?)", (identity, json_text(listed)))
                db.commit()
                if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise ValueError("Candidate bibliography database failed its integrity check")
            os.replace(temporary, db_path)
        finally:
            temporary.unlink(missing_ok=True)
    return {"identity": identity, "rows": sum(counts.values()), "sources": counts, "reused": False}


def lookup(path, identifier, title, limit):
    with closing(open_reader(path)) as db:
        db.create_function("casefold", 1, str.casefold, deterministic=True)
        if identifier:
            query, value = "id = ?", identifier
        else:
            query, value = "instr(casefold(title), ?) > 0", title.casefold()
        pub = db.execute("SELECT identity, sources FROM publication").fetchone()
        sources = json.loads(pub[1])
        items = [{"source": src, "catalogueId": item_id, "title": label, "metadata": json.loads(meta),
                  "archiveSha256": sources[src]["sha256"]}
                 for src, item_id, label, meta in db.execute(
                     "SELECT source,id,title,metadata FROM records WHERE " + query + " ORDER BY id,source,rowid LIMIT ?", (value, limit))]
    return {"identity": pub[0], "items": items}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DATABASE)
    sub = parser.add_subparsers(dest="command", required=True)
    refresh = sub.add_parser("build")
    refresh.add_argument("--base", type=Path, default=BASE)
    refresh.add_argument("--checklists", type=Path, default=CHECKLISTS)
    search = sub.add_parser("search")
    match = search.add_mutually_exclusive_group(required=True)
    match.add_argument("--id")
    match.add_argument("--title")
    search.add_argument("--limit", choices=range(1, 101), type=int, default=10)
    args = parser.parse_args()
    if args.command == "build":
        result = build(args.db, args.base, args.checklists)
    else:
        if not (args.id or args.title or "").strip():
            parser.error("Enter a catalogue ID or title text")
        result = lookup(args.db, args.id, args.title, args.limit)
    print(json_text(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, sqlite3.Error) as exc:
        sys.exit(f"Publication catalogue: {exc}")
