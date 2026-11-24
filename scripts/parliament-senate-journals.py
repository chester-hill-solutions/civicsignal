#!/usr/bin/env python3
"""Download bilingual Senate Journals and searchable proceedings for one session."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.parliament_intake import archive_inventory

BASE = "https://sencanada.ca"
INDEX_PATH = {
    "en": "/en/in-the-chamber/journals/{session}",
    "fr": "/fr/dans-la-chambre/journaux/{session}",
}
LANGUAGES = ("en", "fr")
MAX_WORKERS = 4
FR_MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
             "août", "septembre", "octobre", "novembre", "décembre")


def parse_session(value):
    if not re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", value or ""):
        raise ValueError("session must use positive parliament-session form such as 45-1")
    return value


def index_url(language, session):
    return BASE + INDEX_PATH[language].format(session=session)


def fetch_url(url):
    request = Request(url, headers={"Accept": "text/html", "User-Agent": "CivicSignal parliamentary catalogue/1.0"})
    last_error = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=60) as response:
                if response.status != 200:
                    raise ValueError(f"Senate request returned HTTP {response.status}: {url}")
                data = response.read()
            if not data.strip():
                raise ValueError(f"Senate returned an empty HTML document: {url}")
            return data
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt == 2:
                break
            time.sleep(0.5 * (attempt + 1))
    raise ValueError(f"Senate request failed after 3 attempts: {url}: {last_error}")


class IndexParser(HTMLParser):
    def __init__(self, language, session):
        super().__init__(convert_charrefs=True)
        self.language = language
        self.session = session
        self.rows = {}
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            attrs = dict(attrs)
            self.anchor = {"href": attrs.get("href", ""), "text": []}

    def handle_data(self, data):
        if self.anchor is not None:
            self.anchor["text"].append(data)

    def handle_endtag(self, tag):
        if tag != "a" or self.anchor is None:
            return
        href = self.anchor["href"].replace("\\", "/")
        text = clean("".join(self.anchor["text"]))
        self.anchor = None
        path = urlsplit(urljoin(BASE, href)).path
        match = re.search(r"/(\d{3})jr_(20\d{2}-\d{2}-\d{2})-([ef])$", path, re.I)
        if not match:
            return
        issue, date, suffix = match.groups()
        expected = "e" if self.language == "en" else "f"
        if suffix.lower() != expected:
            return
        parsed_url = urlsplit(urljoin(BASE, href))
        session_path = self.session.replace("-", "")
        expected_path = re.compile(
            rf"/{self.language}/content/sen/chamber/{re.escape(session_path)}/journals/{int(issue):03d}jr_{date}-{expected}$",
            re.I,
        )
        if parsed_url.scheme != "https" or parsed_url.hostname not in ("sencanada.ca", "www.sencanada.ca"):
            raise ValueError(f"{self.language} Senate Journals index links to non-official host or scheme: {parsed_url.geturl()}")
        if not expected_path.fullmatch(parsed_url.path):
            raise ValueError(f"{self.language} Senate Journals index has a wrong-session or malformed issue URL: {parsed_url.geturl()}")
        issue_number = int(issue)
        url = parsed_url.geturl()
        key = str(issue_number)
        if key in self.rows and self.rows[key]["url"] != url:
            raise ValueError(f"{self.language} Journals index repeats issue {key}")
        self.rows[key] = {"key": key, "language": self.language, "date": date,
                          "url": url, "issue": issue_number, "indexUrl": index_url(self.language, self.session)}


def parse_index(data, language, session):
    if language not in LANGUAGES:
        raise ValueError(f"unsupported language: {language}")
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="strict")
    if "</html" not in data.lower() or not re.search(r"calendar|calendrier", data, re.I):
        raise ValueError(f"{language} Senate Journals index appears truncated or malformed")
    parser = IndexParser(language, session)
    parser.feed(data)
    parser.close()
    if not parser.rows:
        raise ValueError(f"{language} official Senate Journals index contains no issues for {session}")
    return parser.rows


def clean(value):
    return re.sub(r"\s+", " ", value).strip()


class JournalParser(HTMLParser):
    """Read title and searchable heading/paragraph blocks from the journal body."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.in_document = False
        self.document_depth = 0
        self.title = []
        self.active_tag = None
        self.block = None
        self.heading = ""
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "br" and self.block is not None:
            self.block["text"].append(" ")
        if tag == "span" and self.block is not None and "spanmemberslist" in attrs.get("class", "").casefold():
            self.block["text"].append(" ")
        if tag == "title":
            self.in_title = True
        if tag == "div" and attrs.get("id") == "content-viewer-document":
            self.in_document = True
            self.document_depth = 1
        elif self.in_document and tag == "div":
            self.document_depth += 1
        if self.in_document and tag in ("h2", "h3", "h4"):
            self._start_block(tag)
        elif self.in_document and tag == "p":
            self._start_block(tag)
        elif self.block is not None and tag == "a":
            href = attrs.get("href", "")
            self.block["anchor"] = {"href": href, "text": []}

    def _start_block(self, tag):
        self._finish_block()
        self.block = {"tag": tag, "text": [], "links": [], "anchor": None}

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        if self.block is not None:
            self.block["text"].append(data)
            if self.block["anchor"] is not None:
                self.block["anchor"]["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.block is not None and self.block["anchor"] is not None:
            anchor = self.block["anchor"]
            self.block["links"].append({"label": clean("".join(anchor["text"])), "href": anchor["href"]})
            self.block["anchor"] = None
        if self.block is not None and tag == self.block["tag"]:
            self._finish_block()
        if tag == "div" and self.in_document:
            self.document_depth -= 1
            if self.document_depth <= 0:
                self._finish_block()
                self.in_document = False

    def _finish_block(self):
        if self.block is None:
            return
        text = clean("".join(self.block["text"]))
        tag = self.block["tag"]
        if text and tag in ("h2", "h3", "h4"):
            self.heading = text
            self.blocks.append({"heading": True, "text": text, "links": []})
        elif text and tag == "p":
            self.blocks.append({"heading": False, "text": text, "links": self.block["links"]})
        self.block = None


def is_boilerplate(text):
    value = text.casefold()
    return value.startswith((
        "the members convened were", "the honourable senators", "the first list records",
        "an asterisk in the second list", "members present", "les membres présents étaient",
        "les honorables sénateurs", "la première liste indique", "un astérisque dans la deuxième liste",
    ))


def parse_issue(data, row):
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="strict")
    if "</html" not in data.lower() or "content-viewer-document" not in data:
        raise ValueError(f"Senate Journal issue {row['key']} ({row['language']}) appears truncated")
    parser = JournalParser()
    parser.feed(data)
    parser.close()
    date = row["date"]
    title = clean("".join(parser.title))
    if not title:
        raise ValueError(f"Senate Journal issue {row['key']} ({row['language']}) has no document title")
    parsed = datetime.strptime(date, "%Y-%m-%d")
    if row["language"] == "en":
        expected_date = f"{parsed.strftime('%B')} {parsed.day}, {parsed.year}"
        issue_match = re.search(r"\bIssue\s+(\d+)\b", title, re.I)
        language_marker = "journals"
    else:
        french_day = "1er" if parsed.day == 1 else str(parsed.day)
        expected_date = f"{french_day} {FR_MONTHS[parsed.month - 1]} {parsed.year}"
        issue_match = re.search(r"\b(?:No\.?|N°|fascicule)\s*(\d+)\b", title, re.I)
        language_marker = "journaux"
    if language_marker not in title.casefold():
        raise ValueError(f"Senate Journal issue {row['key']} title does not match {row['language']} edition: {title!r}")
    if not issue_match or str(int(issue_match.group(1))) != row["key"]:
        raise ValueError(f"Senate Journal document title does not identify issue {row['key']}: {title!r}")
    if expected_date.casefold() not in title.casefold():
        raise ValueError(f"Senate Journal issue {row['key']} title date does not match index date {date}: {title!r}")
    path_match = re.search(r"/(\d{3})jr_(20\d{2}-\d{2}-\d{2})-([ef])$", urlsplit(row["url"]).path, re.I)
    expected_suffix = "e" if row["language"] == "en" else "f"
    if (not path_match or int(path_match.group(1)) != int(row["key"])
            or path_match.group(2) != date or path_match.group(3).lower() != expected_suffix):
        raise ValueError(f"Senate Journal issue URL does not match index identity/date/language: {row['url']}")
    passages = []
    for block in parser.blocks:
        text = block["text"]
        if block["heading"]:
            passages.append({"text": text, "url": row["url"], "links": []})
            continue
        if is_boilerplate(text):
            continue
        links = [{"label": link["label"], "url": urljoin(row["url"], link["href"])}
                 for link in block["links"] if link["href"] and link["label"]]
        chunks = []
        remaining = text
        while len(remaining) > 4000:
            cut = remaining.rfind(" ", 0, 4000)
            if cut < 2000:
                cut = 4000
            chunks.append(remaining[:cut])
            remaining = remaining[cut:].lstrip()
        chunks.append(remaining)
        for chunk_index, chunk in enumerate(chunks):
            chunk_links = [link for link in links if link["label"] and link["label"] in chunk]
            if chunk_index == 0 and not chunk_links:
                chunk_links = links
            passages.append({"text": chunk, "url": row["url"], "links": chunk_links})
    if not passages:
        raise ValueError(f"Senate Journal issue {row['key']} ({row['language']}) yielded no searchable proceedings")
    decision_markers = ("question being put", "adopted", "passed", "defeated", "negatived", "division", "bill c-", "bill s-")
    identifying = next((p["text"] for p in passages if any(marker in p["text"].casefold() for marker in decision_markers)), passages[0]["text"])
    summary = identifying[:360] + ("…" if len(identifying) > 360 else "")
    return {"key": row["key"], "language": row["language"], "title": title, "summary": summary,
            "date": date, "url": row["url"],
            "details": {"kind": "senate-journal", "status": "published", "passages": passages}}


def unavailable(row, language, session):
    missing_url = index_url(language, session)
    date = row["date"]
    title = (f"Senate Journals, Issue {row['key']} ({date}) — EN unavailable" if language == "en"
             else f"Journaux du Sénat, fascicule {row['key']} ({date}) — FR unavailable")
    summary = (f"The EN issue is not linked by the EN session index; the listed edition is available in French."
               if language == "en" else
               f"Le fascicule FR n’est pas indiqué dans l’index de session FR; l’édition anglaise est disponible.")
    return {"key": row["key"], "language": language,
            "title": title, "summary": summary,
            "date": date, "url": missing_url,
            "details": {"kind": "senate-journal", "status": "unavailable",
                        "passages": []}}


def collect(session, fetch=fetch_url):
    session = parse_session(session)
    indexes = {language: parse_index(fetch(index_url(language, session)), language, session) for language in LANGUAGES}
    issue_keys = sorted(set(indexes["en"]) | set(indexes["fr"]), key=int)
    if issue_keys and [int(key) for key in issue_keys] != list(range(1, int(issue_keys[-1]) + 1)):
        expected = set(map(str, range(1, int(issue_keys[-1]) + 1)))
        raise ValueError(f"both official Senate Journals indexes omit issue(s) {sorted(expected-set(issue_keys), key=int)}")
    for key in set(indexes["en"]) & set(indexes["fr"]):
        if indexes["en"][key]["date"] != indexes["fr"][key]["date"]:
            raise ValueError(f"bilingual Senate Journal issue {key} has different dates")
    for language in LANGUAGES:
        missing = set(issue_keys) - set(indexes[language])
        if missing:
            for key in missing:
                if key not in indexes["en"] and key not in indexes["fr"]:
                    raise ValueError(f"Senate Journal issue {key} has no listed language edition")
    work = [(language, indexes[language][key]) for key in issue_keys for language in LANGUAGES if key in indexes[language]]
    fetched = {}
    failures = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        jobs = {pool.submit(fetch, row["url"]): (language, row) for language, row in work}
        for future in as_completed(jobs):
            language, row = jobs[future]
            try:
                fetched[(language, row["key"])] = parse_issue(future.result(), row)
            except Exception as exc:
                failures.append(f"{language} issue {row['key']} {row['url']}: {exc}")
    if failures:
        raise ValueError("failed to acquire/parse Senate Journals issues:\n" + "\n".join(sorted(failures)))
    records = []
    for key in issue_keys:
        date = next(indexes[language][key]["date"] for language in LANGUAGES if key in indexes[language])
        for language in LANGUAGES:
            if key in indexes[language]:
                records.append(fetched[(language, key)])
            else:
                other = "fr" if language == "en" else "en"
                records.append(unavailable(indexes[other][key], language, session))
    return {"session": session, "collection": "senate-journals",
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "records": records}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", default="45-1", help="parliament-session, for example 45-1")
    parser.add_argument("--output", required=True, help="output JSON path")
    args = parser.parse_args(argv)
    try:
        payload = archive_inventory(args.output, args.session, collect, fetch_url)
    except Exception as exc:
        parser.error(str(exc))
    counts = {language: sum(row["language"] == language for row in payload["records"]) for language in LANGUAGES}
    unavailable_count = sum(row["details"]["status"] == "unavailable" for row in payload["records"])
    print(f"Wrote {len(payload['records'])} records for {payload['session']} to {args.output} ({counts}, unavailable={unavailable_count})")


if __name__ == "__main__":
    main()
