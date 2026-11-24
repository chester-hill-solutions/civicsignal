#!/usr/bin/env python3
"""Download the bilingual House of Commons recorded-vote catalogue."""

import argparse
from datetime import datetime, timezone
import re
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


from lib.parliament_intake import archive_inventory


BASE = "https://www.ourcommons.ca"
XML_URL = BASE + "/Members/{language}/Votes/XML"
DETAIL_URL = {
    "en": BASE + "/Members/en/votes/{parliament}/{session}/{division}",
    "fr": BASE + "/deputes/fr/votes/{parliament}/{session}/{division}",
}
LANGUAGES = ("en", "fr")
COUNT_FIELDS = (
    ("DecisionDivisionNumberOfYeas", {"en": "Yeas", "fr": "Pour"}),
    ("DecisionDivisionNumberOfNays", {"en": "Nays", "fr": "Contre"}),
    ("DecisionDivisionNumberOfPaired", {"en": "Paired", "fr": "Pairés"}),
)


def parse_session(value):
    match = re.fullmatch(r"([1-9][0-9]*)-([1-9][0-9]*)", value or "")
    if not match:
        raise ValueError("session must use positive parliament-session form such as 45-1")
    return int(match.group(1)), int(match.group(2))


def fetch_url(url):
    request = Request(url, headers={"User-Agent": "CivicSignal parliamentary catalogue/1.0"})
    with urlopen(request, timeout=45) as response:
        if response.status != 200:
            raise ValueError(f"House returned HTTP {response.status}: {url}")
        return response.read()


def listing_url(language):
    return BASE + f"/Members/{language}/votes"


def _text(node, name):
    element = node.find(name)
    return (element.text or "").strip() if element is not None else ""


def parse_edition(data, language, parliament, session):
    """Parse one official XML edition into a vote-number keyed mapping."""
    if language not in LANGUAGES:
        raise ValueError(f"unsupported language: {language}")
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, TypeError) as exc:
        raise ValueError(f"invalid {language} vote XML: {exc}") from exc
    votes = root.findall("Vote")
    if not votes:
        raise ValueError(f"{language} vote XML contains no vote records")

    records = {}
    for vote in votes:
        pnum = _text(vote, "ParliamentNumber")
        snum = _text(vote, "SessionNumber")
        if (pnum, snum) != (str(parliament), str(session)):
            continue
        raw_number = _text(vote, "DecisionDivisionNumber")
        if not re.fullmatch(r"[1-9][0-9]*", raw_number):
            raise ValueError(f"{language} vote has invalid division number: {raw_number!r}")
        number = int(raw_number)
        if number in records:
            raise ValueError(f"{language} edition has duplicate division {number}")
        title = _text(vote, "DecisionDivisionSubject")
        decision = _text(vote, "DecisionResultName")
        if not title or not decision:
            raise ValueError(f"{language} division {number} is missing its subject or official decision")

        count_parts = []
        tallies = []
        for field, label in COUNT_FIELDS:
            raw_count = _text(vote, field)
            if raw_count:
                if not re.fullmatch(r"[0-9]+", raw_count):
                    raise ValueError(f"{language} division {number} has invalid {label[language]} count: {raw_count!r}")
                count = int(raw_count)
                count_parts.append(f"{label[language]}: {count}")
                tallies.append(count)
            else:
                tallies.append(None)
        summary = decision + (" (" + ", ".join(count_parts) + ")" if count_parts else "")

        raw_date = _text(vote, "DecisionEventDateTime")
        date = None
        if raw_date:
            try:
                date = datetime.fromisoformat(raw_date.replace("Z", "+00:00")).date().isoformat()
            except ValueError as exc:
                raise ValueError(f"{language} division {number} has invalid decision date: {raw_date!r}") from exc

        records[number] = {
            "key": str(number),
            "language": language,
            "title": title,
            "summary": summary,
            "date": date,
            "url": DETAIL_URL[language].format(parliament=parliament, session=session, division=number),
            "details": {"kind": "house-vote", "result": decision, **dict(zip(("yeas", "nays", "paired"), tallies))},
        }
    if not records:
        raise ValueError(f"{language} XML has no records for session {parliament}-{session}")
    return records


def parse_listing(data, language, parliament, session):
    """Read the vote detail links in the House's complete session listing."""
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="replace")
    route = "members/en" if language == "en" else "deputes/fr"
    pattern = re.compile(
        rf"/{route}/votes/{parliament}/{session}/([1-9][0-9]*)(?:[/?#\"'\s]|$)",
        re.IGNORECASE,
    )
    numbers = {int(match.group(1)) for match in pattern.finditer(data)}
    if not numbers:
        raise ValueError(f"{language} official votes listing contains no {parliament}-{session} divisions")
    return numbers


def combine_editions(english, french):
    """Require complete, matching number bounds before combining editions."""
    if not english or not french:
        raise ValueError("both English and French editions must be nonempty")
    en_keys, fr_keys = set(english), set(french)
    if en_keys != fr_keys:
        raise ValueError(f"bilingual division mismatch: English-only {sorted(en_keys-fr_keys)}, French-only {sorted(fr_keys-en_keys)}")
    for number in en_keys:
        if english[number]["date"] != french[number]["date"]:
            raise ValueError(f"bilingual division {number} has different decision dates")
        if any(english[number]["details"][k] != french[number]["details"][k] for k in ("yeas", "nays", "paired")):
            raise ValueError(f"bilingual division {number} has different vote tallies")
    expected = set(range(1, max(en_keys) + 1))
    if en_keys != expected:
        missing = sorted(expected - en_keys)
        raise ValueError(f"division sequence is incomplete; missing {missing[:10]}")
    return [
        record
        for number in sorted(en_keys) for record in (english[number], french[number])
    ]


def collect(session, fetch=fetch_url):
    parliament, session_number = parse_session(session)
    editions = {
        language: parse_edition(fetch(XML_URL.format(language=language)), language, parliament, session_number)
        for language in LANGUAGES
    }
    for language in LANGUAGES:
        listed = parse_listing(fetch(listing_url(language)), language, parliament, session_number)
        xml_keys = set(editions[language])
        if listed != xml_keys:
            raise ValueError(
                f"{language} official listing/XML mismatch: listing-only {sorted(listed-xml_keys)}, "
                f"XML-only {sorted(xml_keys-listed)}"
            )
    records = combine_editions(editions["en"], editions["fr"])
    return {
        "session": session,
        "collection": "house-votes",
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "records": records,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", default="45-1", help="parliament-session, for example 45-1")
    parser.add_argument("--output", required=True, help="output JSON path")
    args = parser.parse_args(argv)
    try:
        payload = archive_inventory(args.output, args.session, collect, fetch_url)
    except Exception as exc:
        parser.error(str(exc))
    print(f"Wrote {len(payload['records'])} records for {payload['session']} to {args.output}")


if __name__ == "__main__":
    main()
