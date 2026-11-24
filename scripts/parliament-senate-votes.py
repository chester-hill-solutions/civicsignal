#!/usr/bin/env python3
"""Download the bilingual Senate standing-vote catalogue for one session."""

import argparse
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.parliament_intake import archive_inventory, save_atomic

BASE = "https://sencanada.ca"
INDEX_PATH = {
    "en": "/en/in-the-chamber/votes/",
    "fr": "/fr/dans-la-chambre/votes/",
}
DETAIL_PATH = {
    "en": "/en/in-the-chamber/votes/details/{id}/{session}",
    "fr": "/fr/dans-la-chambre/votes/details/{id}/{session}",
}
LANGUAGES = ("en", "fr")
TALLY_LABELS = {
    "en": ("Yeas", "Nays", "Abstentions"),
    "fr": ("Pour", "Contre", "Abstention"),
}
RESULT_PAIRS = {
    "Adopted": "Adopté",
    "Defeated": "Rejeté",
}


def parse_session(value):
    if not re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", value or ""):
        raise ValueError("session must use positive parliament-session form such as 45-1")
    return value


def index_url(language, session):
    path = INDEX_PATH[language].rstrip("/") + "/" + session
    return BASE + path


def fetch_url(url):
    request = Request(url, headers={"Accept": "text/html", "User-Agent": "CivicSignal parliamentary catalogue/1.0"})
    with urlopen(request, timeout=45) as response:
        if response.status != 200:
            raise ValueError(f"Senate request returned HTTP {response.status}: {url}")
        data = response.read()
    if not data.strip():
        raise ValueError(f"Senate returned an empty HTML document: {url}")
    return data


class VoteTableParser(HTMLParser):
    """Extract rows and cell links from the publisher's votes-table."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.table_depth = 0
        self.in_votes_table = False
        self.row = None
        self.cell = None
        self.anchor = None
        self.rows = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            marker = (attrs.get("id", "") + " " + attrs.get("class", "")).lower()
            if "votes-table" in marker:
                self.in_votes_table = True
                self.table_depth = 1
            elif self.in_votes_table:
                self.table_depth += 1
        elif self.in_votes_table and tag == "tr":
            self.row = []
        elif self.row is not None and tag in ("td", "th"):
            self.cell = {"text": [], "links": []}
            self.row.append(self.cell)
        elif self.cell is not None and tag == "a":
            self.anchor = {"href": attrs.get("href", ""), "text": []}
            self.cell["links"].append(self.anchor)

    def handle_endtag(self, tag):
        if tag == "a":
            self.anchor = None
        elif tag in ("td", "th"):
            self.cell = None
        elif tag == "tr" and self.row is not None:
            if self.row:
                self.rows.append(self.row)
            self.row = None
        elif tag == "table" and self.in_votes_table:
            self.table_depth -= 1
            if self.table_depth <= 0:
                self.in_votes_table = False

    def handle_data(self, data):
        if self.cell is not None:
            self.cell["text"].append(data)
        if self.anchor is not None:
            self.anchor["text"].append(data)


def _text(parts):
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def parse_inventory(data, language, session):
    if language not in LANGUAGES:
        raise ValueError(f"unsupported language: {language}")
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="strict")
    if not re.search(r"</table\s*>", data, re.I) or not re.search(r"</html\s*>", data, re.I):
        raise ValueError(f"{language} Senate votes HTML appears truncated")
    parser = VoteTableParser()
    try:
        parser.feed(data)
        parser.close()
    except (UnicodeError, ValueError) as exc:
        raise ValueError(f"invalid {language} Senate votes HTML: {exc}") from exc
    records = {}
    for row in parser.rows:
        cells = [{"text": _text(cell["text"]), "links": cell["links"]} for cell in row]
        combined = " | ".join(cell["text"] for cell in cells)
        detail_links = []
        for cell in row:
            detail_links.extend((link, cell) for link in cell["links"]
                                if re.search(r"/votes/details/", link["href"], re.I))
        if not detail_links:
            headers = [cell["text"].casefold() for cell in cells]
            if len(headers) >= 2 and headers[0] == "date" and headers[1] in ("title", "titre"):
                continue
            raise ValueError(f"{language} Senate inventory row has no vote detail link: {combined[:120]!r}")
        if len(detail_links) != 1:
            raise ValueError(f"{language} Senate inventory row has {len(detail_links)} vote detail links")
        link, title_cell = detail_links[0]
        href = link["href"]
        match = re.fullmatch(
            rf"(?:https://sencanada\.ca)?{re.escape(DETAIL_PATH[language].split('/details')[0])}/details/([1-9][0-9]*)/{re.escape(session)}/?",
            href,
            re.I,
        )
        if not match:
            raise ValueError(f"{language} Senate row has an invalid or wrong-session detail URL: {href!r}")
        vote_id = int(match.group(1))
        if vote_id in records:
            raise ValueError(f"{language} Senate inventory has duplicate vote ID {vote_id}")
        title = _text(link["text"])
        date_matches = re.findall(r"(?<!\d)(20\d{2}-[01]\d-[0-3]\d)(?!\d)", combined)
        if len(date_matches) != 1:
            raise ValueError(f"{language} Senate vote {vote_id} has missing or ambiguous date")
        date = date_matches[0]
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"{language} Senate vote {vote_id} has invalid date {date!r}") from exc
        if not title:
            raise ValueError(f"{language} Senate vote {vote_id} has an empty title")
        tally_pattern = re.compile(
            rf"{TALLY_LABELS[language][0]}\s*:\s*([0-9]+).*?"
            rf"{TALLY_LABELS[language][1]}\s*:\s*([0-9]+).*?"
            rf"{TALLY_LABELS[language][2]}\s*:\s*([0-9]+).*?"
            rf"Total\s*:\s*([0-9]+)",
            re.I,
        )
        tally = tally_pattern.search(combined)
        if not tally:
            raise ValueError(f"{language} Senate vote {vote_id} has incomplete or malformed aggregate tallies")
        yeas, nays, abstentions, total = (int(part) for part in tally.groups())
        if yeas + nays + abstentions != total:
            raise ValueError(f"{language} Senate vote {vote_id} tally components do not sum to total")
        outcomes = [outcome for outcome in ("Adopted", "Defeated", "Adopté", "Rejeté")
                    if re.search(rf"(?<!\w){outcome}(?!\w)", combined, re.I)]
        if len(outcomes) != 1:
            raise ValueError(f"{language} Senate vote {vote_id} has missing or ambiguous official outcome")
        result = outcomes[0]
        expected_language = {"en": ("Adopted", "Defeated"), "fr": ("Adopté", "Rejeté")}[language]
        if result not in expected_language:
            raise ValueError(f"{language} Senate vote {vote_id} has unexpected localized outcome {result!r}")
        summary = f"{result} ({TALLY_LABELS[language][0]}: {yeas}, {TALLY_LABELS[language][1]}: {nays}, {TALLY_LABELS[language][2]}: {abstentions})"
        records[vote_id] = {
            "key": str(vote_id),
            "language": language,
            "title": title,
            "summary": summary,
            "date": date,
            "url": BASE + DETAIL_PATH[language].format(id=vote_id, session=session),
            "details": {"kind": "senate-vote", "result": result,
                        "yeas": yeas, "nays": nays, "abstentions": abstentions},
        }
    if not records:
        raise ValueError(f"{language} official Senate votes index contains no {session} standing votes")
    return records


def combine_editions(english, french):
    if not english or not french:
        raise ValueError("both English and French Senate editions must be nonempty")
    en_ids, fr_ids = set(english), set(french)
    if en_ids != fr_ids:
        raise ValueError(f"bilingual Senate vote mismatch: English-only {sorted(en_ids-fr_ids)}, French-only {sorted(fr_ids-en_ids)}")
    for vote_id in sorted(en_ids):
        en, fr = english[vote_id], french[vote_id]
        if en["date"] != fr["date"]:
            raise ValueError(f"bilingual Senate vote {vote_id} has different dates")
        en_details, fr_details = en["details"], fr["details"]
        if any(en_details[field] != fr_details[field] for field in ("yeas", "nays", "abstentions")):
            raise ValueError(f"bilingual Senate vote {vote_id} has different aggregate tallies")
        if RESULT_PAIRS.get(en_details["result"]) != fr_details["result"]:
            raise ValueError(f"bilingual Senate vote {vote_id} has different outcomes")
    return [record for vote_id in sorted(en_ids) for record in (english[vote_id], french[vote_id])]


def collect(session, fetch=fetch_url):
    session = parse_session(session)
    editions = {}
    for language in LANGUAGES:
        editions[language] = parse_inventory(fetch(index_url(language, session)), language, session)
    records = combine_editions(editions["en"], editions["fr"])
    return {"session": session, "collection": "senate-votes",
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "records": records}


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
    print(f"Wrote {len(payload['records'])} records for {payload['session']} to {args.output} ({counts})")


if __name__ == "__main__":
    main()
