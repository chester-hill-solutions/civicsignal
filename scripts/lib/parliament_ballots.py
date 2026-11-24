"""Parsers and checks for official Commons and Senate roll-call pages."""
from html.parser import HTMLParser
from html import unescape
import re
import unicodedata
from urllib.parse import urljoin

HOUSE = "https://www.ourcommons.ca"
SENATE = "https://sencanada.ca"
HOUSE_DETAIL = {
    "en": HOUSE + "/Members/{language}/votes/{parliament}/{session}/{number}",
    "fr": HOUSE + "/deputes/{language}/votes/{parliament}/{session}/{number}",
}
SENATE_DETAIL = {
    "en": SENATE + "/en/in-the-chamber/votes/details/{number}/{session}",
    "fr": SENATE + "/fr/dans-la-chambre/votes/details/{number}/{session}",
}


def _clean(value):
    return re.sub(r"\s+", " ", value or "").strip()


class TableParser(HTMLParser):
    """Small table reader that preserves cell links and vote marker classes."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell, self.anchor = [], None, None, None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = {"parts": [], "links": [], "classes": [], "data_order": attrs.get("data-order")}
            self.row.append(self.cell)
        elif tag == "a" and self.cell is not None:
            self.anchor = {"href": attrs.get("href", ""), "parts": []}
            self.cell["links"].append(self.anchor)
        elif tag == "i" and self.cell is not None:
            self.cell["classes"].extend(attrs.get("class", "").split())

    def handle_endtag(self, tag):
        if tag == "a":
            self.anchor = None
        elif tag in ("td", "th"):
            self.cell = None
        elif tag == "tr" and self.row is not None:
            if self.row:
                for cell in self.row:
                    cell["text"] = _clean(" ".join(cell["parts"]))
                    for link in cell["links"]:
                        link["text"] = _clean(" ".join(link["parts"]))
                self.rows.append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell["parts"].append(data)
        if self.anchor is not None:
            self.anchor["parts"].append(data)


def _tables(source):
    return re.findall(r"<table\b[^>]*>.*?</table\s*>", source, re.I | re.S)


def _rows(table):
    parser = TableParser()
    parser.feed(table)
    parser.close()
    return parser.rows


def _detail_id(url, language, session, kind):
    if kind == "house":
        parliament, session_number = session.split("-", 1)
        route = "Members/en" if language == "en" else "deputes/fr"
        pattern = rf"https://www\.ourcommons\.ca/{route}/votes/{parliament}/{session_number}/([1-9][0-9]*)/?"
    else:
        pattern = rf"https://sencanada\.ca/{'en/in-the-chamber' if language == 'en' else 'fr/dans-la-chambre'}/votes/details/([1-9][0-9]*)/{re.escape(session)}/?"
    match = re.fullmatch(pattern, url, re.I)
    if not match:
        raise ValueError(f"invalid official {kind} detail URL for {language} {session}: {url!r}")
    return int(match.group(1))


def _house_section(source, section_id, stop_id):
    start = source.lower().find(f'id="{section_id}"')
    if start < 0:
        raise ValueError(f"House detail page is missing {section_id}")
    stop = source.lower().find(f'id="{stop_id}"', start + 1)
    return source[start:stop if stop >= 0 else len(source)]


def _house_roster(source, language):
    text = source.decode("utf-8-sig", "strict") if isinstance(source, bytes) else source
    if "mip-vote-votedetails-section" not in text:
        raise ValueError("House detail page lacks the vote details section")
    labels = {"en": ("Yea", "Nay", "Paired"), "fr": ("Pour", "Contre", "Pairés")}[language]
    main = _house_section(text, "btn-mp-view", "btn-province-view")
    tables = _tables(main)
    if len(tables) != 1:
        raise ValueError(f"House MP view contains {len(tables)} roster tables, expected one")
    roster = {}
    for row in _rows(tables[0]):
        if len(row) < 4 or len(row[0]["links"]) != 1:
            # Header rows are safely ignored; malformed data rows are not.
            if row and any(cell.get("links") for cell in row):
                raise ValueError("House roll-call member row has an unexpected shape")
            continue
        link = row[0]["links"][0]
        path = re.fullmatch(r"/(?:Members/en|deputes/(?:en|fr))/([1-9][0-9]*)/?", link["href"], re.I)
        if not path or not link["text"]:
            raise ValueError(f"House member row has an unverified profile link: {link['href']!r}")
        member_id = path.group(1)
        text_cell = row[0]["text"]
        constituency_match = re.search(r"\(([^()]*)\)\s*$", text_cell)
        constituency = constituency_match.group(1).strip() if constituency_match else None
        status_text = row[2]["text"].casefold()
        paired_text = row[3]["text"].casefold()
        is_paired = paired_text in (labels[2].casefold(), "paired", "pairés", "pairs")
        vote = None
        if status_text in (labels[0].casefold(), "yea", "pour"):
            vote = "yea"
        elif status_text in (labels[1].casefold(), "nay", "contre"):
            vote = "nay"
        elif not is_paired:
            raise ValueError(f"House member {member_id} has unknown vote position {row[2]['text']!r}")
        position = vote if vote is not None else "paired"
        if member_id in roster:
            raise ValueError(f"House roll-call has duplicate member {member_id}")
        roster[member_id] = {
            "name": link["text"], "position": position, "memberId": member_id,
            "affiliation": row[1]["text"] or None, "constituency": constituency,
            "province": None, "url": urljoin(HOUSE, link["href"]), "paired": is_paired,
        }
    if not roster:
        raise ValueError("House detail page has no member rows in the MP view")

    # The publisher repeats the same roster under its province view, which is
    # the official per-vote source for province attribution.
    province_view = _house_section(text, "btn-province-view", "btn-party-view")
    province = None
    province_roster = {}
    current_table = []
    class ProvinceParser(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.in_h3 = False
            self.h3 = []
            self.table_depth = 0
            self.row_parser = None
        def handle_starttag(self, tag, attrs):
            if tag == "h3":
                self.in_h3 = True
                self.h3 = []
            if tag == "table":
                self.table_depth += 1
                if self.table_depth == 1:
                    self.row_parser = TableParser()
            if self.row_parser:
                self.row_parser.handle_starttag(tag, attrs)
        def handle_endtag(self, tag):
            nonlocal province
            if self.row_parser:
                self.row_parser.handle_endtag(tag)
            if tag == "table":
                self.table_depth -= 1
                if self.table_depth == 0 and self.row_parser:
                    for r in self.row_parser.rows:
                        if len(r) >= 4 and r[0]["links"]:
                            m = re.fullmatch(r"/(?:Members/en|deputes/(?:en|fr))/([1-9][0-9]*)/?", r[0]["links"][0]["href"], re.I)
                            if m:
                                province_roster[m.group(1)] = province
                    self.row_parser = None
            if tag == "h3":
                province = _clean(" ".join(self.h3)) or province
                self.in_h3 = False
        def handle_data(self, data):
            if self.in_h3:
                self.h3.append(data)
            if self.row_parser:
                self.row_parser.handle_data(data)
    parser = ProvinceParser()
    parser.feed(province_view)
    parser.close()
    if set(province_roster) != set(roster):
        raise ValueError(f"House province view roster mismatch; missing {sorted(set(roster)-set(province_roster))[:5]}, extra {sorted(set(province_roster)-set(roster))[:5]}")
    for member_id, member in roster.items():
        member["province"] = province_roster[member_id]
    return roster


def _senate_roster(source, language):
    text = source.decode("utf-8-sig", "strict") if isinstance(source, bytes) else source
    marker = re.search(r'<table\b[^>]*id=["\']sc-vote-details-table["\'][^>]*>.*?</table\s*>', text, re.I | re.S)
    if not marker:
        raise ValueError("Senate detail page lacks sc-vote-details-table")
    labels = {"en": ("Yea", "Nay", "Abstention"), "fr": ("Pour", "Contre", "Abstention")}[language]
    roster = {}
    for row in _rows(marker.group(0)):
        if len(row) < 6 or len(row[0]["links"]) != 1:
            if row and any(cell.get("links") for cell in row):
                raise ValueError("Senate roll-call member row has an unexpected shape")
            continue
        link = row[0]["links"][0]
        path = re.fullmatch(r"/(?:en/in-the-chamber/votes/senator|fr/dans-la-chambre/votes/senateur)/([1-9][0-9]*)/[1-9][0-9]*-[1-9][0-9]*/?", link["href"], re.I)
        if not path or not link["text"]:
            raise ValueError(f"Senate member row has an unverified profile link: {link['href']!r}")
        statuses = []
        for cell in row[3:6]:
            statuses.append(bool(any(name in cell["classes"] for name in ("fa-times", "fa-check", "fa-xmark"))))
        if sum(statuses) != 1:
            # A blank row is an absent senator and is not part of the published vote.
            if not any(statuses):
                continue
            raise ValueError(f"Senate member {path.group(1)} has ambiguous vote markers")
        position = ("yea", "nay", "abstention")[statuses.index(True)]
        member_id = path.group(1)
        if member_id in roster:
            raise ValueError(f"Senate roll-call has duplicate senator {member_id}")
        roster[member_id] = {
            "name": link["text"], "position": position, "memberId": member_id,
            "affiliation": row[1]["text"] or None, "constituency": None,
            "province": row[2]["text"] or None, "url": urljoin(SENATE, link["href"]),
            "paired": False,
        }
    if not roster:
        raise ValueError("Senate detail page has no marked vote rows")
    return roster


def parse_roll(source, language, session, url, kind):
    number = _detail_id(url, language, session, kind)
    text = source.decode("utf-8-sig", "strict") if isinstance(source, bytes) else source
    html_tag = re.search(r"<html\b([^>]*)>", text, re.I)
    page_language = re.search(r"\b(?:xml:)?lang=[\"']([^\"']+)[\"']", html_tag.group(1), re.I) if html_tag else None
    if not page_language or page_language.group(1).split("-")[0].lower() != language:
        actual = page_language.group(1) if page_language else "missing"
        raise ValueError(f"official page language is {actual!r}, expected {language}")
    if kind == "house":
        headings = [unescape(re.sub(r"<[^>]+>", " ", value)) for value in re.findall(r"<h1\b[^>]*>(.*?)</h1\s*>", text, re.I | re.S)]
        expected = re.compile(rf"\bVote\s+No\.?\s*{number}\b", re.I) if language == "en" else re.compile(rf"\bVote\s+n\s*o\s*{number}\b", re.I)
        if not any(expected.search(_clean(heading)) for heading in headings):
            raise ValueError(f"House page heading does not identify division {number} in {language}")
    else:
        paths = ("/en/in-the-chamber/votes/details", "/fr/dans-la-chambre/votes/details")
        route_pattern = "|".join(re.escape(path) for path in paths)
        self_href = re.compile(rf"href=[\"'](?:{route_pattern})/{number}/{re.escape(session)}/?[\"']", re.I)
        if not self_href.search(text):
            raise ValueError(f"Senate page has no matching {language} self-link for vote {number}/{session}")
    roster = _house_roster(source, language) if kind == "house" else _senate_roster(source, language)
    return number, roster


def _fold(value):
    return "".join(c for c in unicodedata.normalize("NFKD", (value or "").casefold()) if not unicodedata.combining(c))


PROVINCES = {
    "alberta": "alberta", "alberta": "alberta", "british columbia": "british columbia", "colombie-britannique": "british columbia",
    "manitoba": "manitoba", "new brunswick": "new brunswick", "nouveau-brunswick": "new brunswick",
    "newfoundland and labrador": "newfoundland and labrador", "terre-neuve-et-labrador": "newfoundland and labrador",
    "northwest territories": "northwest territories", "territoires du nord-ouest": "northwest territories",
    "nova scotia": "nova scotia", "nouvelle-ecosse": "nova scotia", "nunavut": "nunavut", "ontario": "ontario",
    "prince edward island": "prince edward island", "ile-du-prince-edouard": "prince edward island",
    "quebec": "quebec", "saskatchewan": "saskatchewan", "yukon": "yukon",
}


def reconcile(english, french, expected, kind, number):
    if set(english) != set(french):
        raise ValueError(f"{kind} {number} bilingual roster mismatch: EN-only {sorted(set(english)-set(french))}, FR-only {sorted(set(french)-set(english))}")
    tally_fields = ("yeas", "nays", "paired") if kind == "house" else ("yeas", "nays", "abstentions")
    counts = {"yea": 0, "nay": 0, "paired": 0, "abstention": 0}
    for member_id, en in english.items():
        fr = french[member_id]
        if en["position"] != fr["position"]:
            raise ValueError(f"{kind} {number} member {member_id} has different EN/FR vote positions")
        if en.get("paired") != fr.get("paired"):
            raise ValueError(f"{kind} {number} member {member_id} has different EN/FR paired facts")
        if not (kind == "house" and en.get("paired") and en["position"] == "paired"):
            counts[en["position"]] += 1
        if kind == "house" and en.get("paired"):
            counts["paired"] += 1
        for field in ("affiliation", "province"):
            a, b = en[field], fr[field]
            if a and b and _fold(a) != _fold(b):
                if field == "province" and PROVINCES.get(_fold(b)) == PROVINCES.get(_fold(a)):
                    continue
                # Party names are publisher-localized. A stable abbreviation may
                # appear in both editions; otherwise the bilingual identity and
                # per-edition publisher values are retained without translation.
                if field == "affiliation":
                    aliases = {
                        "conservative": "conservative", "conservateur": "conservative",
                        "liberal": "liberal", "liberal party": "liberal", "liberal caucus": "liberal", "liberal group": "liberal", "liberal party of canada": "liberal", "liberaux": "liberal",
                        "bloc quebecois": "bloc quebecois", "bloc quebecois caucus": "bloc quebecois",
                        "new democratic party": "ndp", "ndp": "ndp", "nouveau parti democratique": "ndp", "npd": "ndp",
                        "green party": "green", "green": "green", "parti vert": "green", "vert": "green",
                        "independent senators group": "isg", "isg": "isg", "gsi": "isg", "groupe des senateurs independants": "isg",
                        "canadian senators group": "csg", "csg": "csg", "gsc": "csg", "groupe des senateurs canadiens": "csg",
                        "progressive senate group": "psg", "psg": "psg", "gps": "psg", "groupe progressiste du senat": "psg",
                        "non-affiliated": "non-affiliated", "non affiliated": "non-affiliated", "non affilie": "non-affiliated", "non affilie(e)": "non-affiliated",
                    }
                    if aliases.get(_fold(a)) != aliases.get(_fold(b)) and _fold(a) != _fold(b):
                        raise ValueError(f"{kind} {number} member {member_id} has irreconcilable EN/FR affiliation: {a!r} / {b!r}")
                    continue
                raise ValueError(f"{kind} {number} member {member_id} has irreconcilable EN/FR province: {a!r} / {b!r}")
    for key, position in zip(tally_fields, ("yea", "nay", "paired" if kind == "house" else "abstention")):
        if expected.get(key) is not None and expected[key] != counts[position]:
            raise ValueError(f"{kind} {number} {key} tally is {expected[key]} but roster contains {counts[position]}")
    return counts
