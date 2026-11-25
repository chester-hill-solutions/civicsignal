#!/usr/bin/env python3
"""Extract ECCC HTML/PDF passages and atomically build the local search DB."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.committee_files import read_object

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "preview/departmental-publications/migrations/0002_dp_passages.sql"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
OMIT = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside"}


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)


class TreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag.lower(), dict(attrs))
        self.stack[-1].children.append(node)
        if tag.lower() not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag.lower(), dict(attrs)))

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if data.strip():
            self.stack[-1].children.append(data)


def node_text(node):
    if isinstance(node, str):
        return node
    if node.tag in OMIT:
        return ""
    return " ".join(filter(None, (node_text(c) for c in node.children)))


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


def walk(node):
    if isinstance(node, str):
        return
    yield node
    if node.tag not in OMIT:
        for child in node.children:
            yield from walk(child)


def choose_content(root):
    candidates = [n for n in walk(root) if n.tag in {"main", "article"}]
    if candidates:
        return max(candidates, key=lambda n: len(node_text(n)))
    candidates = [n for n in walk(root) if "mwsg-generic-base-html" in n.attrs.get("class", "")]
    if candidates:
        return max(candidates, key=lambda n: len(node_text(n)))
    return root


def html_passages(data, url):
    parser = TreeParser()
    parser.feed(data.decode("utf-8", errors="replace"))
    parser.close()
    content = choose_content(parser.root)
    passages, section, section_url, ordinal, table_no = [], "", url, 0, 0
    def add(kind, text, citation, **extra):
        nonlocal ordinal
        text = clean(text)
        if not text:
            return
        ordinal += 1
        passages.append({"ordinal": ordinal, "kind": kind, "section": section or None,
                         "citation_url": citation, "text": text,
                         "attribution": None, **extra})
    # Walk source order while carrying the latest heading and processing tables as units.
    def visit(node):
        nonlocal section, section_url, table_no
        if isinstance(node, str) or node.tag in OMIT:
            return
        if re.fullmatch(r"h[1-6]", node.tag):
            heading = clean(node_text(node))
            if heading:
                section = heading
                section_url = url + ("#" + quote(node.attrs["id"]) if node.attrs.get("id") else "")
                add("heading", heading, section_url)
            return
        if node.tag == "table":
            table_no += 1
            caption = next((clean(node_text(c)) for c in walk(node) if c.tag == "caption" and clean(node_text(c))), None)
            table_id = node.attrs.get("id")
            citation = url + "#" + quote(table_id) if table_id else section_url
            rows = [n for n in walk(node) if n.tag == "tr"]
            headers = []
            row_counter = 0
            for tr in rows:
                cells = [c for c in tr.children if not isinstance(c, str) and c.tag in {"th", "td"}]
                if not cells:
                    continue
                values = [clean(node_text(c)) for c in cells]
                if all(c.tag == "th" for c in cells):
                    headers = values
                    continue
                row_counter += 1
                french = any(re.search(r"\b(recommandation|échéancier|évaluation|tableau)\b", v, re.I) for v in (headers + values))
                prefix = [("Tableau " if french else "Table ") + str(table_no)]
                if caption:
                    prefix.append(caption)
                if headers:
                    prefix.append(("Colonnes : " if french else "Columns: ") + " | ".join(headers))
                prefix.append(("Ligne : " if french else "Row: ") + " | ".join(values))
                row_text = ". ".join(prefix)
                # A table passage preserves the complete row and column labels. Each row is independently citable.
                add("table-row", row_text, citation, table_number=table_no,
                    table_caption=caption, row_number=row_counter,
                    column_number=None, attribution=None)
                for ci, value in enumerate(values, 1):
                    if value:
                        column_label = headers[ci-1] if ci <= len(headers) else ""
                        celltext = " | ".join(part for part in (caption, values[0] if ci > 1 else "", column_label, value) if part)
                        add("table-cell", celltext, citation, table_number=table_no,
                            table_caption=caption, row_number=row_counter,
                            column_number=ci,
                            attribution=column_label or None)
            return
        if node.tag in {"p", "li", "blockquote"}:
            text = clean(node_text(node))
            if text:
                frag = node.attrs.get("id")
                add("paragraph" if node.tag != "li" else "list-item", text,
                    url + "#" + quote(frag) if frag else section_url)
            return
        for child in node.children:
            visit(child)
    visit(content)
    return passages


def pdf_passages(data, url):
    if not shutil.which("pdftotext"):
        raise RuntimeError("pdftotext is required to extract PDF pages")
    with tempfile.TemporaryDirectory(prefix="eccc-pdf-") as tmp:
        pdf = Path(tmp) / "source.pdf"
        pdf.write_bytes(data)
        proc = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), "-"],
                              check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode:
            raise RuntimeError("pdftotext failed: " + proc.stderr.decode("utf-8", "replace")[:300])
    pages = proc.stdout.decode("utf-8", errors="replace").split("\f")
    out, ordinal = [], 0
    for page_no, raw in enumerate(pages, 1):
        lines = [clean(line) for line in raw.splitlines()]
        blocks, current = [], []
        for line in lines:
            if line:
                current.append(line)
            elif current:
                blocks.append(" ".join(current)); current = []
        if current:
            blocks.append(" ".join(current))
        for block in blocks:
            if not block:
                continue
            ordinal += 1
            out.append({"ordinal": ordinal, "kind": "pdf-page-text", "section": None,
                        "page": page_no, "citation_url": url + "#page=" + str(page_no),
                        "text": block, "attribution": None})
    return out


def extract(data, media, url):
    media = (media or "").lower()
    if "html" in media or data.lstrip()[:20].lower().startswith((b"<!doctype html", b"<html")):
        return html_passages(data, url)
    if "pdf" in media or data.startswith(b"%PDF-"):
        return pdf_passages(data, url)
    raise ValueError("unsupported media type: " + (media or "unknown"))


def passage_id(document_id, content_hash, ordinal):
    return "dp-p-" + hashlib.sha256(f"{document_id}\0{content_hash}\0{ordinal}".encode()).hexdigest()[:24]


def build(catalogue, output, root):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.with_name(output.name + ".build.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return build_generation(catalogue, output, root)


def build_generation(catalogue, output, root):
    catalogue, output, root = Path(catalogue), Path(output), Path(root)
    if catalogue.resolve() == output.resolve():
        raise ValueError("catalogue and serving output must be different files")
    if not catalogue.is_file():
        raise FileNotFoundError("catalogue database does not exist: " + str(catalogue))
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="." + output.name + ".", suffix=".tmp", dir=output.parent)
    os.close(fd)
    temp_path = Path(temp_name)
    counts, gaps = {"documents_seen": 0, "documents_extracted": 0, "passages": 0}, []
    try:
        src_uri = "file:" + quote(str(catalogue.resolve())) + "?mode=ro"
        src = sqlite3.connect(src_uri, uri=True)
        src.execute("PRAGMA query_only=ON")
        dst = sqlite3.connect(temp_path)
        src.backup(dst)
        # The entire private file is discarded after an interrupted build.
        # Avoid a second on-disk journal and external sort while constructing it.
        dst.execute("PRAGMA journal_mode=OFF")
        dst.execute("PRAGMA temp_store=MEMORY")
        dst.executescript(MIGRATION.read_text())
        cutoff_row = dst.execute("SELECT cutoff FROM dp_inventory WHERE singleton=1").fetchone()
        if not cutoff_row:
            raise ValueError("catalogue has no inventory cutoff; refusing empty serving build")
        cutoff = cutoff_row[0]
        if output.is_file():
            prior = sqlite3.connect(output.resolve().as_uri() + "?mode=ro", uri=True)
            try:
                published = prior.execute("SELECT catalogue_cutoff FROM dp_extraction_runs WHERE singleton=1").fetchone()
                if published and published[0] > cutoff:
                    raise ValueError("Source catalogue is older than the published extraction")
            finally:
                prior.close()
        dst.execute("DELETE FROM dp_passages")
        rows = dst.execute("SELECT id,work_id,language,url,sha256,content_sha256,media,status FROM dp_documents ORDER BY id").fetchall()
        for doc_id, work_id, lang, url, source_hash, content_hash, media, status in rows:
            counts["documents_seen"] += 1
            if status != "stored" or not source_hash:
                if status == "stored":
                    raise ValueError(f"Stored document {doc_id} lacks its source digest")
                continue
            # Missing or corrupted content-addressed originals are catalogue integrity
            # failures. Abort the candidate and leave the currently served generation alone.
            data = read_object(root, source_hash)
            try:
                passages = extract(data, media, url)
            except ValueError as exc:
                if not str(exc).startswith("unsupported media type:"):
                    raise
                gaps.append({"document_id": doc_id, "url": url, "reason": str(exc)[:300]})
                continue
            if not passages:
                gaps.append({"document_id": doc_id, "url": url, "reason": "no searchable text extracted"})
                continue
            counts["documents_extracted"] += 1
            for p in passages:
                pid = passage_id(doc_id, content_hash or source_hash, p["ordinal"])
                fields = ("passage_id", "document_id", "work_id", "language", "ordinal", "kind", "section", "page", "table_number", "table_caption", "row_number", "column_number", "attribution", "citation_url", "text", "content_sha256", "source_sha256")
                val = (pid, doc_id, work_id, lang, p["ordinal"], p["kind"], p.get("section"), p.get("page"), p.get("table_number"), p.get("table_caption"), p.get("row_number"), p.get("column_number"), p.get("attribution"), p["citation_url"], p["text"], content_hash or source_hash, source_hash)
                dst.execute("INSERT INTO dp_passages(" + ",".join(fields) + ") VALUES(" + ",".join("?" for _ in fields) + ")", val)
                counts["passages"] += 1
        if counts["documents_seen"] == 0 or counts["documents_extracted"] == 0:
            raise ValueError("candidate contains no extracted searchable documents")
        dst.execute("INSERT INTO dp_passages_fts(dp_passages_fts) VALUES('rebuild')")
        built_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        dst.execute("INSERT OR REPLACE INTO dp_extraction_runs VALUES(1,?,?,?,?,?,?)", (built_at, cutoff, counts["documents_seen"], counts["documents_extracted"], counts["passages"], json.dumps(gaps, ensure_ascii=False)))
        dst.commit()
        dst.execute("PRAGMA journal_mode=DELETE")
        if dst.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Candidate serving database failed SQLite verification")
        dst.close(); src.close()
        os.replace(temp_path, output)
    except Exception:
        try:
            dst.close()
        except (NameError, sqlite3.Error):
            pass
        try:
            src.close()
        except (NameError, sqlite3.Error):
            pass
        try: temp_path.unlink()
        except FileNotFoundError: pass
        raise
    return {**counts, "gaps": gaps, "output": str(output)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default="data/corpus/eccc")
    p.add_argument("--catalogue", default="data/corpus/eccc/catalogue.sqlite")
    p.add_argument("--output", default="data/corpus/eccc/serving.sqlite")
    args = p.parse_args()
    print(json.dumps(build(args.catalogue, args.output, args.root), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
