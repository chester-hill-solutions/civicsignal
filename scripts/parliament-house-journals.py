#!/usr/bin/env python3
"""Acquire both language editions of every published House Journal in a session."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.parliament_intake import archive_inventory

BASE = "https://www.ourcommons.ca"
CALENDAR = "/documentviewer/en/SessionPublicationCalendarsWidget"
LANGUAGES = ("en", "fr")
JOURNAL_PATHS = {
    "en": "/DocumentViewer/en/{session}/house/sitting-{sitting}/journals",
    "fr": "/DocumentViewer/fr/{session}/chambre/seance-{sitting}/journaux",
}
VOTE_DETAIL_PATHS = {
    "en": "/Members/en/votes/{parliament}/{session}/{vote}",
    "fr": "/deputes/fr/votes/{parliament}/{session}/{vote}",
}
MAX_PAGE_BYTES = 4 * 1024 * 1024
SITTING = re.compile(r"[1-9][0-9]*(?:[A-Z])?")
FRENCH_MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4,
    "mai": 5, "juin": 6, "juillet": 7, "août": 8, "aout": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
}


def parse_session(value):
    if not re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", value or ""):
        raise ValueError("session must use positive parliament-session form such as 45-1")
    return value


def calendar_url(session):
    parliament, sitting_session = parse_session(session).split("-")
    return BASE + CALENDAR + "?" + f"organization=HOC&publicationTypeId=37&parliament={parliament}&session={sitting_session}"


def fetch_url(url):
    """Fetch an official source with bounded retries; expose 404 as a publisher gap."""
    last_error = None
    for attempt in range(4):
        try:
            request = Request(url, headers={"Accept": "text/html", "User-Agent": "CivicSignal House Journals intake/1.0"})
            with urlopen(request, timeout=45) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status} from {url}")
                data = response.read(MAX_PAGE_BYTES + 1)
                if len(data) > MAX_PAGE_BYTES:
                    raise ValueError(f"House publication exceeded {MAX_PAGE_BYTES} bytes: {url}")
                if not data.strip():
                    raise ValueError(f"House returned an empty publication: {url}")
                return data
        except HTTPError as exc:
            if exc.code == 404:
                raise PublisherGap(f"official edition returned HTTP 404: {url}") from exc
            last_error = exc
        except (OSError, URLError, RuntimeError) as exc:
            last_error = exc
        if attempt < 3:
            time.sleep(attempt + 1)
    raise RuntimeError(f"Official House fetch failed after retries: {url}: {last_error}")


class PublisherGap(Exception):
    """The publisher has no edition at an otherwise inventoried sitting URL."""


def _clean(value):
    return re.sub(r"\s+", " ", value).strip()


def _official_host(host):
    host = host.lower().rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in
               ("ourcommons.ca", "noscommunes.ca", "parl.ca", "sencanada.ca", "canada.ca", "gazette.gc.ca"))


class CalendarParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sittings = {}
        self.in_table = False
        self.cell = None
        self.link = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            marker = (attrs.get("id", "") + " " + attrs.get("class", "")).lower()
            if "publications-calendar" in marker:
                self.in_table = True
        elif self.in_table and tag == "td":
            self.cell = {"class": attrs.get("class", ""), "links": []}
        elif self.cell is not None and tag == "a":
            self.link = {"href": attrs.get("href", ""), "label": attrs.get("aria-label", ""), "text": []}
            self.cell["links"].append(self.link)

    def handle_endtag(self, tag):
        if tag == "a":
            self.link = None
        elif tag == "td" and self.cell is not None:
            if "chamber-meeting" in self.cell["class"].split() or any(
                    re.search(r"/(?:journals|journaux)/?$", link["href"], re.I) for link in self.cell["links"]):
                for link in self.cell["links"]:
                    match = re.search(r"/(?:sitting|seance)-([1-9][0-9]*[A-Z]?)/(?:hansard|journals|order-notice)/?$", link["href"], re.I)
                    if not match:
                        continue
                    sitting = match.group(1).upper()
                    if not SITTING.fullmatch(sitting):
                        raise ValueError(f"Invalid sitting identity in official calendar: {sitting!r}")
                    date_match = re.search(r"\b((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})\b", link["label"])
                    if not date_match:
                        raise ValueError(f"Missing date in official House calendar label: {link['label']!r}")
                    sitting_date = datetime.strptime(date_match.group(1), "%B %d, %Y").date().isoformat()
                    previous = self.sittings.get(sitting)
                    if previous and previous != sitting_date:
                        raise ValueError(f"Official calendar has conflicting dates for sitting {sitting}")
                    self.sittings[sitting] = sitting_date
            self.cell = None
        elif tag == "table" and self.in_table:
            self.in_table = False

    def handle_data(self, data):
        if self.link is not None:
            self.link["text"].append(data)


def parse_calendar(data, session, through=None):
    session = parse_session(session)
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="strict")
    if not re.search(r"</table\s*>", data, re.I):
        raise ValueError("House calendar HTML appears truncated")
    parser = CalendarParser()
    parser.feed(data)
    parser.close()
    if not parser.sittings:
        raise ValueError(f"Official House calendar contains no sitting entries for {session}")
    cutoff = through or date.today()
    rows = [(sitting, day) for sitting, day in parser.sittings.items() if date.fromisoformat(day) <= cutoff]
    rows.sort(key=lambda row: (date.fromisoformat(row[1]), _sitting_sort(row[0])))
    if not rows:
        raise ValueError(f"Official House calendar contains no completed sittings for {session}")
    return [{"sitting": sitting, "date": day} for sitting, day in rows]


def _sitting_sort(value):
    match = re.fullmatch(r"([0-9]+)([A-Z]?)", value)
    return int(match.group(1)), match.group(2)


class JournalParser(HTMLParser):
    """Read substantive Journal paragraphs and their official source links."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lang = None
        self.title_parts = []
        self.in_title = False
        self.page_text = []
        self.in_main = False
        self.main_depth = 0
        self.doc_anchor = None
        self.table_doc = None
        self.in_item = False
        self.item_table_depth = 0
        self.paragraph = None
        self.anchor = None
        self.passages = []
        self.divisions = []
        self.division = None
        self.division_field = None
        self.division_cell_stack = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.lang = attrs.get("lang", "").split("-", 1)[0].lower()
        if tag == "title":
            self.in_title = True
        if tag == "a" and re.fullmatch(r"DOC--[A-Za-z0-9-]+", attrs.get("name", "")):
            self.doc_anchor = attrs["name"]
        if tag == "section" and "page-content" in attrs.get("class", "").split():
            self.in_main = True
            self.main_depth = 1
        elif self.in_main and tag == "section":
            self.main_depth += 1
        if tag == "table" and self.in_main:
            table_id = attrs.get("id", "").strip()
            classes = attrs.get("class", "").replace("\n", " ").split()
            if "Item" in classes or table_id.startswith("TABLE"):
                self.table_doc = self.doc_anchor
                self.in_item = True
                self.item_table_depth = 1
            elif self.in_item:
                self.item_table_depth += 1
        if self.in_item and tag == "p" and "Para" in attrs.get("class", "").split():
            self.paragraph = {"text": [], "links": [], "anchor": self.table_doc}
        if self.paragraph is not None and tag == "a":
            self.anchor = {"href": attrs.get("href", ""), "text": []}
        if self.in_item and tag == "td":
            classes = attrs.get("class", "").split()
            marker = next((name for name in ("DivisionNumber", "DivisionHeader") if name in classes), "")
            self.division_cell_stack.append(marker)
            if marker == "DivisionNumber":
                self.division = {"number": [], "header": [], "anchor": self.table_doc}
                self.division_field = "number"
            elif marker == "DivisionHeader" and self.division is not None:
                self.division_field = "header"

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "a":
            self.anchor = None
        if tag == "p" and self.paragraph is not None:
            text = _clean("".join(self.paragraph["text"]))
            if len(text) >= 12:
                links = []
                # Link spans are tracked in handle_data via the active anchor.
                for href, label in self.paragraph.get("links", []):
                    absolute = urljoin(BASE, href)
                    if urlparse(absolute).scheme in ("http", "https") and urlparse(absolute).hostname and \
                            _official_host(urlparse(absolute).hostname):
                        links.append({"label": label or absolute, "url": absolute})
                self.passages.append({"text": text, "anchor": self.paragraph["anchor"], "links": links})
            self.paragraph = None
        if tag == "td" and self.division_cell_stack:
            marker = self.division_cell_stack.pop()
            if marker == "DivisionNumber":
                self.division_field = None
            elif marker == "DivisionHeader" and self.division is not None:
                self.divisions.append(self.division)
                self.division = None
                self.division_field = None
        if tag == "table" and self.in_item:
            self.item_table_depth -= 1
            if self.item_table_depth <= 0:
                self.in_item = False
                self.table_doc = None
        if tag == "section" and self.in_main:
            self.main_depth -= 1
            if self.main_depth <= 0:
                self.in_main = False

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data)
        if self.paragraph is not None:
            self.paragraph["text"].append(data)
            if self.anchor is not None:
                self.anchor["text"].append(data)
        if self.anchor is not None and self.paragraph is not None:
            # Preserve link association while source markup is streaming.
            href = self.anchor["href"]
            if not self.paragraph["links"] or self.paragraph["links"][-1][0] != href:
                self.paragraph["links"].append([href, ""])
            self.paragraph["links"][-1][1] += data
        if self.division is not None and self.division_field is not None:
            self.division[self.division_field].append(data)


def parse_journal(data, language, sitting, session, expected_date=None):
    if language not in LANGUAGES:
        raise ValueError(f"unsupported language: {language}")
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="strict")
    if not re.search(r"</html\s*>", data, re.I):
        raise ValueError(f"{language} House Journal HTML appears truncated for sitting {sitting}")
    parser = JournalParser()
    parser.feed(data)
    parser.close()
    title = _clean("".join(parser.title_parts))
    if parser.lang != language or not re.search(r"\bJournals\b|\bJournaux\b", title, re.I):
        raise ValueError(f"{language} sitting {sitting} returned a non-Journal or wrong-language page")
    name = "Journals" if language == "en" else "Journaux"
    issue = re.search(rf"\b{name}\s+no\.?\s*([1-9][0-9]*[A-Z]?)\b", title, re.I)
    session_match = re.search(r"\(([1-9][0-9]*-[1-9][0-9]*)\)", title)
    if not issue or issue.group(1).upper() != sitting.upper() or not session_match or session_match.group(1) != session:
        raise ValueError(f"{language} Journal title does not identify sitting {sitting} in session {session}: {title!r}")
    date_match = re.search(r"-\s*(.+?)\s*\(" + re.escape(session) + r"\)", title)
    try:
        if not date_match:
            raise ValueError("date missing")
        date_label = date_match.group(1).strip()
        if language == "en":
            actual_date = datetime.strptime(date_label, "%B %d, %Y").date().isoformat()
        else:
            french_date = re.fullmatch(r"(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})", date_label, re.I)
            if not french_date or french_date.group(2).casefold() not in FRENCH_MONTHS:
                raise ValueError("invalid French date")
            actual_date = date(int(french_date.group(3)), FRENCH_MONTHS[french_date.group(2).casefold()], int(french_date.group(1))).isoformat()
    except ValueError as exc:
        raise ValueError(f"{language} sitting {sitting} Journal title has an invalid or missing date: {title!r}") from exc
    if expected_date and actual_date != expected_date:
        raise ValueError(f"{language} sitting {sitting} Journal date {actual_date} conflicts with calendar date {expected_date}")
    if not parser.passages:
        raise ValueError(f"{language} sitting {sitting} Journal contains no proceedings paragraphs")
    expected = JOURNAL_PATHS[language].format(session=session, sitting=sitting)
    citation = BASE + expected
    passages = []
    for item in parser.passages:
        url = citation + ("#" + item["anchor"] if item["anchor"] else "")
        passages.append({"text": item["text"], "url": url, "links": item["links"]})
    parliament, session_number = session.split("-")
    seen_divisions = set()
    for item in parser.divisions:
        label = _clean("".join(item["number"]))
        header = _clean("".join(item["header"]))
        # Early procedural votes can have an empty DivisionNumber cell. They
        # are not numbered recorded divisions and have no detail ID to cite.
        if not label:
            continue
        division_match = re.search(r"Division\s+No\.?\s*([1-9][0-9]*)", label, re.I)
        vote_match = re.search(r"Vote\s+n\s*o\s*\.?\s*([1-9][0-9]*)", label, re.I)
        if not division_match or not vote_match:
            raise ValueError(f"{language} sitting {sitting} has a malformed recorded division label: {label!r}")
        division_number, vote_number = int(division_match.group(1)), int(vote_match.group(1))
        if division_number in seen_divisions:
            raise ValueError(f"{language} sitting {sitting} repeats Division No. {division_number}")
        seen_divisions.add(division_number)
        if not header:
            raise ValueError(f"{language} sitting {sitting} Division No. {division_number} has no official tally heading")
        detail_url = BASE + VOTE_DETAIL_PATHS[language].format(
            parliament=parliament, session=session_number, vote=vote_number)
        source_url = citation + ("#" + item["anchor"] if item["anchor"] else "")
        vote_label = "Vote No." if language == "en" else "Vote no"
        passages.append({
            "text": f"Division No. {division_number}; {vote_label} {vote_number}. {header}",
            "url": source_url,
            "links": [{"label": f"Recorded vote {vote_number}", "url": detail_url}],
        })
    # Short identifying description comes from the publisher's document title.
    summary = re.sub(r"\s+-\s+House of Commons of Canada\s*$", "", title, flags=re.I)
    return {"title": title, "summary": summary, "url": citation, "passages": passages}


def collect(session, fetch=fetch_url, through=None, workers=4):
    session = parse_session(session)
    calendar_bytes = fetch(calendar_url(session))
    sittings = parse_calendar(calendar_bytes, session, through)
    jobs = [(row, language) for row in sittings for language in LANGUAGES]
    urls = {(row["sitting"], language): BASE + JOURNAL_PATHS[language].format(session=session, sitting=row["sitting"])
            for row, language in jobs}

    def load(job):
        row, language = job
        key = row["sitting"], language
        try:
            return key, fetch(urls[key]), None
        except PublisherGap as exc:
            return key, None, str(exc)

    with ThreadPoolExecutor(max_workers=max(1, min(workers, 6))) as pool:
        loaded = dict((key, (body, gap)) for key, body, gap in pool.map(load, jobs))

    records = []
    for row in sittings:
        for language in LANGUAGES:
            key = row["sitting"], language
            body, gap = loaded[key]
            url = urls[key]
            if gap:
                records.append({"key": str(row["sitting"]), "language": language,
                    "title": (f"Journals No. {row['sitting']} (unavailable)" if language == "en" else
                              f"Journaux no {row['sitting']} (indisponibles)"),
                    "summary": ("No English Journal edition was published at the official sitting URL as of this inventory." if language == "en" else
                                "Aucune édition française du Journal n’était publiée à l’URL officielle de la séance au moment de cet inventaire."),
                    "date": row["date"], "url": url,
                    "details": {"kind": "house-journal", "status": "unavailable", "passages": []}})
                continue
            parsed = parse_journal(body, language, row["sitting"], session, row["date"])
            records.append({"key": str(row["sitting"]), "language": language,
                "title": parsed["title"], "summary": parsed["summary"], "date": row["date"], "url": parsed["url"],
                "details": {"kind": "house-journal", "status": "published", "passages": parsed["passages"]}})
    if not records:
        raise ValueError(f"House Journals inventory is empty for {session}")
    return {"session": session, "collection": "house-journals",
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
    counts = {language: {status: sum(row["language"] == language and row["details"]["status"] == status
                                     for row in payload["records"])
                         for status in ("published", "unavailable")} for language in LANGUAGES}
    print(f"Wrote {len(payload['records'])} records for {payload['session']} to {args.output} ({counts})")


if __name__ == "__main__":
    main()
