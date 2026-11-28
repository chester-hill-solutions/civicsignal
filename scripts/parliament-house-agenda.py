#!/usr/bin/env python3
"""Archive an official House Order and Notice Paper and the current projected business."""

import argparse
from datetime import date, datetime, timezone
from functools import partial
from http.client import IncompleteRead
from html.parser import HTMLParser
from pathlib import Path
import re
from socket import EAI_AGAIN, gaierror
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.html_tree import cls, tree
from lib.parliament_intake import archive_inventory

BASE = "https://www.ourcommons.ca"
FRENCH_BASE = "https://www.noscommunes.ca"
LANGUAGES = ("en", "fr")
PAPER_PATHS = {"en": "en/{session}/house/sitting-{sitting}/order-notice",
               "fr": "fr/{session}/chambre/seance-{sitting}/feuilleton-avis"}
LATEST_PATHS = {"en": "en/house/latest/order-notice", "fr": "fr/chambre/dernier/feuilleton-avis"}
PROJECTED_PATHS = {"en": BASE + "/DocumentViewer/en/{session}/house/projected-business",
                   "fr": FRENCH_BASE + "/documentviewer/fr/{session}/chambre/ordre-travaux"}
SECTIONS = {"en": {"Order Paper": "listed", "Notice Paper": "noticed"},
            "fr": {"Feuilleton": "listed", "Feuilleton des avis": "noticed"}}
PAPER_TITLES = {"en": "Order Paper & Notice Paper", "fr": "Feuilleton et Feuilleton des avis"}
PROJECTED_TITLES = {"en": "Projected Order of Business", "fr": "Ordre projeté des travaux"}
SESSION = re.compile(r"[1-9][0-9]*-[1-9][0-9]*")
SITTING = re.compile(r"[1-9][0-9]*[A-Z]?")
BILL_ITEM = re.compile(r"^([CS]-[1-9][0-9]*)\s*[—–]\s*\S")
QUESTION_PATHS = {"en": "written-questions", "fr": "questions-ecrites"}
QUESTION_NUMBER = re.compile(r"Q-[1-9][0-9]*")
PARAGRAPH_ANCHOR = re.compile(r"DOC--[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
MONTHS = {
    "en": "january february march april may june july august september october november december".split(),
    "fr": "janvier février mars avril mai juin juillet août septembre octobre novembre décembre".split(),
}
MAX_PAGE_BYTES = 4 * 1024 * 1024
MAX_SECTIONS = 36
FETCH_ATTEMPTS = 3
TRANSIENT_TRANSPORT = (TimeoutError, ConnectionError, IncompleteRead)


def edition_url(session, sitting, language):
    return BASE + "/documentviewer/" + PAPER_PATHS[language].format(session=session, sitting=sitting)


class NoRedirect(HTTPRedirectHandler):
    """Keep requests on the exact, verified publisher routes."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_url(url):
    request = Request(url, headers={"Accept": "text/html", "User-Agent": "CivicSignal House agenda intake/1.0"})
    opener = build_opener(NoRedirect)
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        delay = 0.5 * attempt
        try:
            with opener.open(request, timeout=30) as response:
                if response.status != 200 or response.headers.get_content_type() != "text/html":
                    raise ValueError(f"Expected an official House HTML page: {url}")
                body = response.read(MAX_PAGE_BYTES + 1)
            if len(body) > MAX_PAGE_BYTES:
                raise ValueError(f"House agenda page exceeded {MAX_PAGE_BYTES} bytes: {url}")
            return body
        except HTTPError as exc:
            exc.close()
            if exc.code not in (408, 429) and not 500 <= exc.code <= 599:
                raise
            retry_after = exc.headers.get("Retry-After") if exc.headers is not None else None
            if retry_after:
                if not retry_after.isdecimal() or int(retry_after) > 10:
                    raise
                delay = max(delay, int(retry_after))
            last_error = exc
        except URLError as exc:
            reason = exc.reason
            if not (isinstance(reason, TRANSIENT_TRANSPORT)
                    or (isinstance(reason, gaierror) and reason.errno == EAI_AGAIN)):
                raise
            last_error = exc
        except TRANSIENT_TRANSPORT as exc:
            last_error = exc
        if attempt < FETCH_ATTEMPTS:
            time.sleep(delay)
    raise ValueError(f"Official House fetch failed after {FETCH_ATTEMPTS} attempts: {url}: {last_error}") from last_error


def clean(chunks):
    return " ".join("".join(chunks).split())


class AgendaHTML(HTMLParser):
    def __init__(self, projected=False):
        super().__init__(convert_charrefs=True)
        self.projected = projected
        self.metadata = {}
        self.toc = []
        self.view_links = []
        self.title = []
        self.body = []
        self.rows = []
        self.previous_link = ""
        self._title = False
        self._depth = 0
        self._link = None
        self._row = None
        self._cell = None
        self.closed_content = False
        self.closed_html = False

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        classes = (attrs.get("class") or "").split()
        if tag == "meta" and attrs.get("name"):
            self.metadata[attrs["name"].lower()] = attrs.get("content") or ""
        elif tag == "title":
            self._title = True
        elif tag == "div" and (self._depth or "publication-container-content" in classes):
            self._depth += 1
        elif tag == "a" and "user-guide" in classes and (attrs.get("href") or "").endswith("?col=2"):
            self.view_links.append(attrs["href"])
        elif tag == "a" and attrs.get("id") == "publication-selector-previous-day":
            self.previous_link = attrs.get("href") or ""
        elif self._depth and tag == "a" and ("DefaultTableOfContentsSectionLink" in classes
                                            or "DefaultTableOfContentsFile" in classes):
            self._link = ("DefaultTableOfContentsSectionLink" in classes, attrs.get("href") or "", [])
        elif self._depth and self.projected and tag == "tr":
            self._row = []
        elif self._row is not None and tag == "td":
            self._cell = []

    def handle_data(self, data):
        if self._title:
            self.title.append(data)
        if self._depth:
            self.body.append(data)
        if self._link is not None:
            self._link[2].append(data)
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag == "html":
            self.closed_html = True
        elif tag == "title":
            self._title = False
        elif tag == "div" and self._depth:
            self._depth -= 1
            self.closed_content = self._depth == 0
        elif tag == "a" and self._link is not None:
            header, href, words = self._link
            self.toc.append((header, href, clean(words)))
            self._link = None
        elif tag == "td" and self._row is not None and self._cell is not None:
            self._row.append(clean(self._cell))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if len(self._row) == 2:
                self.rows.append(self._row)
            self._row = None
            self._cell = None


def parse_document(body, session, language, url, *, sitting=None, projected=False):
    document = AgendaHTML(projected)
    document.feed(body.decode("utf-8-sig", errors="strict"))
    document.close()
    meta = document.metadata
    if not document.closed_html or not document.closed_content or not clean(document.body):
        raise ValueError(f"House agenda HTML is empty or incomplete: {url}")
    if not clean(document.title) or meta.get("language") != language:
        raise ValueError(f"House agenda language or title differs from requested edition: {url}")
    if f"{meta.get('parliament')}-{meta.get('session')}" != session:
        raise ValueError(f"House agenda session differs from requested session: {url}")
    title = (PROJECTED_TITLES if projected else PAPER_TITLES)[language]
    match = re.fullmatch(re.escape(title) + r" - (" + SITTING.pattern + r")", meta.get("documenttitle", ""))
    if not match or (sitting is not None and match[1] != sitting):
        raise ValueError(f"House agenda document type or sitting differs from the expected edition: {url}")
    source_date = date.fromisoformat(meta.get("meetingdate", ""))
    doc_id = meta.get("documentid", "")
    if not re.fullmatch(r"[1-9][0-9]*", doc_id):
        raise ValueError(f"House agenda document ID is missing: {url}")
    return document, (match[1], source_date.isoformat(), doc_id)


def section_page(url, href):
    resolved = urlsplit(urljoin(url, href))
    expected = urlsplit(url)
    if (resolved.scheme != "https" or resolved.netloc not in {"www.ourcommons.ca", "www.noscommunes.ca"}
            or resolved.query or resolved.fragment):
        raise ValueError(f"House agenda TOC section leaves the official edition: {href}")
    match = re.fullmatch(re.escape(expected.path) + r"/page-([1-9][0-9]*)", resolved.path, re.I)
    if not match:
        raise ValueError(f"House agenda TOC section leaves the official edition: {href}")
    return match[1]


def section_index(document, language, url):
    sections = []
    section_starts = []
    kind = None
    for header, href, title in document.toc:
        page = section_page(url, href)
        if not title:
            raise ValueError(f"House agenda TOC has an untitled section: {url}")
        if header:
            kind = SECTIONS[language].get(title)
            if not kind:
                raise ValueError(f"House agenda TOC has an unknown paper heading: {title}")
            section_starts.append((kind, page))
        elif not kind:
            raise ValueError(f"House agenda TOC has a section outside either paper: {url}")
        # The paper heading and its first subsection link to the same page.
        if sections and not header and sections[-1][:2] == (kind, page):
            sections[-1] = kind, page, title
        else:
            sections.append((kind, page, title))
    if ([kind for kind, _ in section_starts] != ["listed", "noticed"] or not sections
            or len(sections) > MAX_SECTIONS or len({page for _, page, _ in sections}) != len(sections)):
        raise ValueError(f"House agenda TOC does not identify two complete papers: {url}")
    return sections


def section_identity(sections):
    return [(kind, page) for kind, page, _ in sections]


def record(session, identity, language, kind, title, url, *, page=None, bill_items=None):
    sitting, meeting_date, doc_id = identity
    key = f"{session}:{sitting}:{kind}:{language}"
    if page is not None:
        key += f":{page}"
    details = {"kind": kind, "sitting": sitting, "publisherDocumentId": doc_id}
    if page is not None:
        details["page"] = page
    if bill_items is not None:
        details["billItems"] = bill_items
    return {"key": key, "language": language, "title": title, "date": meeting_date,
            "sourceUrl": url, "details": details}


def projected_items(document, language):
    items = []
    for english, french in document.rows:
        en_match = BILL_ITEM.match(english)
        fr_match = BILL_ITEM.match(french)
        if en_match and fr_match and en_match[1] == fr_match[1]:
            text = english if language == "en" else french
            item = {"billNumber": en_match[1], "text": text}
            if item not in items:
                items.append(item)
    return items


def printed_notice_date(text, language):
    if language == "en":
        pattern = re.fullmatch(r"(\w+) (\d{1,2}), (\d{4})", text)
    else:
        pattern = re.fullmatch(r"(\d{1,2})(?:er)? (\w+) (\d{4})", text)
    if not pattern:
        raise ValueError("Unexpected notice date format")
    first, second, year = pattern.groups()
    month, day = (first, second) if language == "en" else (second, first)
    return date(int(year), MONTHS[language].index(month.lower()) + 1, int(day)).isoformat()


def question_notices(body, language, url, sitting_date):
    content = tree(body.decode("utf-8-sig")).find(lambda node: cls(node, "publication-container-content"))
    if content is None:
        raise ValueError(f"House Notice Paper is missing its publication content: {url}")
    in_questions = False
    seen_rubric = False
    anchor = ""
    notices = []
    for node in content.children:
        if node.tag == "a":
            anchor = node.attrs.get("name") or ""
            continue
        item_anchor, anchor = anchor, ""
        if node.tag != "table":
            continue
        rubric = node.find(lambda child: child.tag in ("h2", "h3") and cls(child, "NoticePaperRubricTitle"))
        if rubric is not None:
            in_questions = rubric.text() == "Questions"
            seen_rubric |= in_questions
        if not in_questions:
            continue
        for cell in node.findall(lambda child: child.tag == "td" and cls(child, "ItemPara")):
            bold = cell.find(lambda child: child.tag == "b")
            link = bold.find(lambda child: child.tag == "a") if bold is not None else None
            href = (link.attrs.get("href") or "") if link is not None else ""
            publisher_id = re.fullmatch(r"/" + QUESTION_PATHS[language] + r"/([1-9][0-9]*)", href)
            number = link.text() if link is not None else ""
            if not publisher_id or not QUESTION_NUMBER.fullmatch(number) or not PARAGRAPH_ANCHOR.fullmatch(item_anchor):
                raise ValueError(f"House written-question notice is missing a publisher ID or citation: {url}")
            try:
                notice_date = printed_notice_date(cell.text().split(" — ", 2)[1], language)
            except (IndexError, ValueError) as exc:
                raise ValueError(f"House written-question notice has an invalid printed date: {url}#{item_anchor}") from exc
            if notice_date > sitting_date:
                raise ValueError(f"House written-question notice date is after its sitting: {url}#{item_anchor}")
            notices.append({"publisherQuestionId": publisher_id[1], "questionNumber": number,
                            "noticeDate": notice_date, "sourceUrl": f"{url}#{item_anchor}",
                            "questionUrl": urljoin(url, href)})
    if not seen_rubric:
        raise ValueError(f"House Notice Paper is missing its Questions heading: {url}")
    if (len({item["publisherQuestionId"] for item in notices}) != len(notices)
            or len({item["questionNumber"] for item in notices}) != len(notices)):
        raise ValueError(f"House Notice Paper repeats a written-question identity: {url}")
    return notices


def check_question_parity(editions):
    def identity(item):
        return (item["publisherQuestionId"], item["questionNumber"], item["noticeDate"],
                urlsplit(item["sourceUrl"]).fragment)

    if {identity(item) for item in editions[0]} != {identity(item) for item in editions[1]}:
        raise ValueError("House written-question notices differ across languages")


def previous_sitting(toc, session):
    previous = []
    for language, (url, document, identity, _) in zip(LANGUAGES, toc, strict=True):
        if not document.previous_link or document.previous_link == "#":
            previous.append(None)
            continue
        target = urlsplit(urljoin(url, document.previous_link))
        path = urlsplit(edition_url(session, "SITTING", language)).path
        match = re.fullmatch(re.escape(path).replace("SITTING", f"({SITTING.pattern})"), target.path, re.I)
        if (target.scheme != "https" or target.netloc not in {"www.ourcommons.ca", "www.noscommunes.ca"}
                or target.query or target.fragment or not match or match[1].upper() == identity[0]):
            raise ValueError(f"House previous edition link is invalid: {url}")
        previous.append(match[1].upper())
    if previous[0] != previous[1]:
        raise ValueError("House previous edition links disagree across languages")
    return previous[0]


def load_toc(session, sitting, fetch):
    toc = []
    for language in LANGUAGES:
        url = edition_url(session, sitting, language)
        document, identity = parse_document(fetch(url), session, language, url, sitting=sitting)
        toc.append((url, document, identity, section_index(document, language, url)))
    if toc[0][2] != toc[1][2] or section_identity(toc[0][3]) != section_identity(toc[1][3]):
        raise ValueError("House agenda papers differ across languages")
    return toc


def load_section(session, language, section_url, identity, fetch):
    body = fetch(section_url)
    source, section_edition = parse_document(body, session, language, section_url, sitting=identity[0])
    if section_edition != identity or not any(
        urlsplit(urljoin(section_url, href)).path.casefold() == urlsplit(section_url).path.casefold()
        for href in source.view_links
    ) or source.toc:
        raise ValueError(f"House agenda section differs from its table of contents: {section_url}")
    return body


def compare_question_notices(session, fetch, toc, current):
    previous = previous_sitting(toc, session)
    if previous is None:
        return None
    prior = load_toc(session, previous, fetch)
    prior_date, current_date = prior[0][2][1], toc[0][2][1]
    if prior_date > current_date:
        raise ValueError("House previous edition date is later than the current edition")
    baseline = []
    for language, (url, _, identity, sections) in zip(LANGUAGES, prior, strict=True):
        page = next(page for kind, page, _ in sections if kind == "noticed")
        section_url = f"{url}/page-{page}"
        body = load_section(session, language, section_url, identity, fetch)
        baseline.append(question_notices(body, language, section_url, prior_date))
    check_question_parity(baseline)
    old_ids = {item["publisherQuestionId"] for item in baseline[0]}
    french_urls = {item["publisherQuestionId"]: item["sourceUrl"] for item in current[1]}
    newly_noticed = []
    for item in current[0]:
        publisher_id = item["publisherQuestionId"]
        if publisher_id not in old_ids:
            newly_noticed.append({"publisherQuestionId": publisher_id, "questionNumber": item["questionNumber"],
                                  "noticeDate": item["noticeDate"],
                                  "citations": {"en": item["sourceUrl"], "fr": french_urls[publisher_id]}})
    return {"previousSitting": previous, "previousSittingDate": prior_date, "sitting": toc[0][2][0],
            "sittingDate": current_date, "newlyNoticed": newly_noticed}


def collect(session, fetch, *, sitting):
    if not SESSION.fullmatch(session) or (sitting is not None and not SITTING.fullmatch(sitting)):
        raise ValueError("Provide a valid parliament-session and sitting number")
    latest = []
    if sitting is None:
        for language in LANGUAGES:
            url = BASE + "/documentviewer/" + LATEST_PATHS[language]
            _, identity = parse_document(fetch(url), session, language, url)
            latest.append(identity)
        if latest[0] != latest[1]:
            raise ValueError("House latest paper aliases disagree on the official edition")
        sitting = latest[0][0]

    toc = load_toc(session, sitting, fetch)
    if latest and toc[0][2] != latest[0]:
        raise ValueError("House latest alias and its fixed paper disagree on the official edition")

    records = []
    questions = []
    for language, (url, document, identity, sections) in zip(LANGUAGES, toc, strict=True):
        records.append(record(session, identity, language, "contents", clean(document.title), url))
        question_page = next(page for kind, page, _ in sections if kind == "noticed")
        for kind, page, title in sections:
            section_url = f"{url}/page-{page}"
            body = load_section(session, language, section_url, identity, fetch)
            row = record(session, identity, language, kind, title, section_url, page=page)
            if page == question_page:
                notices = question_notices(body, language, section_url, identity[1])
                row["details"]["writtenQuestionNotices"] = notices
                questions.append(notices)
            records.append(row)
    check_question_parity(questions)
    comparison = compare_question_notices(session, fetch, toc, questions)

    projected_editions = []
    for language in LANGUAGES:
        url = PROJECTED_PATHS[language].format(session=session)
        document, identity = parse_document(fetch(url), session, language, url, projected=True)
        if not document.rows:
            raise ValueError(f"House projected business has no bilingual layout: {url}")
        projected_editions.append(identity)
        records.append(record(session, identity, language, "projected", clean(document.title), url,
                              bill_items=projected_items(document, language)))
    if projected_editions[0] != projected_editions[1]:
        raise ValueError("House projected business differs across languages")

    packet = {"collection": "house-agenda", "session": session,
              "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
              "records": records}
    if comparison is not None:
        packet["writtenQuestionNoticeComparison"] = comparison
    return packet


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", default="45-1", help="parliament-session, for example 45-1")
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--sitting", help="House sitting number for the papers, for example 175")
    choice.add_argument("--latest", action="store_true", help="discover the latest papers from both official aliases")
    parser.add_argument("--output", required=True, help="output JSON path")
    args = parser.parse_args(argv)
    try:
        payload = archive_inventory(args.output, args.session, partial(collect, sitting=args.sitting), fetch_url)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(f"Wrote {len(payload['records'])} House agenda records for {payload['session']} to {args.output}")


if __name__ == "__main__":
    main()
