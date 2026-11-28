#!/usr/bin/env python3
"""Archive adjacent bilingual Senate Order Paper and Notice Paper issues."""

import argparse
from datetime import date, datetime, timezone
from functools import partial
import re
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from lib.html_tree import cls, tree
from lib.parliament_intake import archive_inventory

BASE = "https://sencanada.ca"
INDEX = {
    "en": "/en/in-the-chamber/order-papers-notice-papers/",
    "fr": "/fr/dans-la-chambre/feuilleton-et-feuilleton-des-preavis/",
}
MONTHS = {
    "en": "January February March April May June July August September October November December".split(),
    "fr": "janvier février mars avril mai juin juillet août septembre octobre novembre décembre".split(),
}
HEADINGS = {
    "en": {"notice paper": "notice", "motions": "motion", "inquiries": "inquiry", "written questions": "question"},
    "fr": {"feuilleton des préavis": "notice", "motions": "motion", "interpellations": "inquiry", "questions écrites": "question"},
}
ORDER_GROUPS = {
    "en": {"government business": "government", "other business": "other"},
    "fr": {"affaires du gouvernement": "government", "autres affaires": "other"},
}
ORDER_CATEGORIES = (
    ("bills-messages", "Bills – Messages from the House of Commons", "Projets de loi – Messages de la Chambre des communes"),
    ("bills-third-reading", "Bills – Third Reading", "Projets de loi – Troisième lecture"),
    ("bills-committee-reports", "Bills – Reports of Committees", "Projets de loi – Rapports de comités"),
    ("bills-second-reading", "Bills – Second Reading", "Projets de loi – Deuxième lecture"),
    ("senate-public-bills-third-reading", "Senate Public Bills – Third Reading", "Projets de loi d’intérêt public du Sénat – Troisième lecture"),
    ("commons-public-bills-third-reading", "Commons Public Bills – Third Reading", "Projets de loi d’intérêt public des Communes – Troisième lecture"),
    ("private-bills-third-reading", "Private Bills – Third Reading", "Projets de loi d’intérêt privé – Troisième lecture"),
    ("senate-public-bills-committee-reports", "Senate Public Bills – Reports of Committees", "Projets de loi d’intérêt public du Sénat – Rapports de comités"),
    ("commons-public-bills-committee-reports", "Commons Public Bills – Reports of Committees", "Projets de loi d’intérêt public des Communes – Rapports de comités"),
    ("private-bills-committee-reports", "Private Bills – Reports of Committees", "Projets de loi d’intérêt privé – Rapports de comités"),
    ("senate-public-bills-second-reading", "Senate Public Bills – Second Reading", "Projets de loi d’intérêt public du Sénat – Deuxième lecture"),
    ("commons-public-bills-second-reading", "Commons Public Bills – Second Reading", "Projets de loi d’intérêt public des Communes – Deuxième lecture"),
    ("private-bills-second-reading", "Private Bills – Second Reading", "Projets de loi d’intérêt privé – Deuxième lecture"),
    ("committee-reports-other", "Reports of Committees – Other", "Rapports de comités – Autres"),
    ("motions", "Motions", "Motions"),
    ("inquiries", "Inquiries", "Interpellations"),
    ("other", "Other", "Autres affaires"),
)
FUTURE_DATE = {
    "en": re.compile(r"For (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\w+) (\d{1,2}), (\d{4})", re.I),
    "fr": re.compile(r"Pour le (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) (\d{1,2})(?:er)? (\w+) (\d{4})", re.I),
}
BILL_NUMBER = {
    "en": re.compile(r"\bBill\s+([CS]-[1-9]\d*)\b", re.I),
    "fr": re.compile(r"\bprojet de loi\s+([CS]-[1-9]\d*)\b", re.I),
}
ISSUE_PATH = re.compile(r"/(?P<language>en|fr)/content/sen/chamber/(?P<session>\d+)/orderpaper/"
                        r"(?P<issue>\d{3,4})op_(?P<date>\d{4}-\d{2}-\d{2})-(?P<suffix>[ef])", re.I)


def index_url(session, language):
    return BASE + INDEX[language] + session


class SenateRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if official_url(newurl).rstrip("/") != official_url(req.full_url).rstrip("/"):
            raise ValueError(f"Unexpected redirect for Senate agenda URL {req.full_url}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_url(url):
    request = Request(url, headers={"User-Agent": "CivicSignal Senate agenda/1.0"})
    limit = (32 if url.lower().endswith(".pdf") else 8) * 1024 * 1024
    with build_opener(SenateRedirect).open(request, timeout=45) as response:
        if response.status != 200:
            raise ValueError(f"HTTP {response.status} from {url}")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError(f"Senate agenda response exceeds {limit} bytes at {url}")
        return body


def official_url(href):
    url = urlsplit(urljoin(BASE, href.replace("\\", "/")))
    if url.netloc.lower() not in ("sencanada.ca", "www.sencanada.ca") or url.scheme != "https":
        raise ValueError(f"Unexpected Senate publication link {url.geturl()}")
    return BASE + url.path


def document(body, language):
    markup = body.decode("utf-8-sig", errors="strict")
    if not re.search(r"</html>\s*$", markup, re.I):
        raise ValueError(f"Incomplete {language} Senate agenda document")
    root = tree(markup)
    html = root.find(lambda node: node.tag == "html")
    title = root.find(lambda node: node.tag == "title")
    if html is None or html.attrs.get("lang") != language or title is None:
        raise ValueError(f"Senate agenda document lacks {language} identity")
    return root, title.text()


def parse_index(body, session, language):
    root, title = document(body, language)
    if not title.endswith(f" - {session}"):
        raise ValueError(f"Wrong session in {language} Senate agenda index: {title}")
    rows = {}
    for node in root.findall(lambda node: node.tag == "a" and "href" in node.attrs):
        href = node.attrs["href"]
        match = ISSUE_PATH.fullmatch(urlsplit(urljoin(BASE, href.replace("\\", "/"))).path)
        if not match or match["language"].lower() != language:
            continue
        url = official_url(href)
        issue = int(match["issue"])
        if not issue or match["session"] != session.replace("-", "") or match["suffix"].lower() != language[0]:
            raise ValueError(f"Wrong session or language in {language} Senate agenda index: {url}")
        row = {"issue": issue, "date": date.fromisoformat(match["date"]).isoformat(), "url": url}
        if issue in rows and rows[issue] != row:
            raise ValueError(f"Conflicting links for {language} Senate agenda issue {issue}")
        rows[issue] = row
    if not rows:
        raise ValueError(f"No issues in {language} Senate agenda index for {session}")
    return rows


def validate_issue_title(title, issue, language):
    sitting = date.fromisoformat(issue["date"])
    month = MONTHS[language][sitting.month - 1]
    if language == "en":
        expected = f"Order Paper and Notice Paper, Issue {issue['issue']} ({month} {sitting.day}, {sitting.year})"
        valid = title == expected
    else:
        number = re.escape(str(issue["issue"]))
        expected = rf"Feuilleton et Feuilleton des préavis N(?:o\.|°) {number} \(Le {sitting.day}(?:er)? {month} {sitting.year}\)"
        valid = re.fullmatch(expected, title, re.I) is not None
    if not valid:
        raise ValueError(f"Wrong title for {language} Senate agenda issue {issue['issue']}: {title}")


def order_number(marker, url):
    match = re.fullmatch(r"N(?:o\.?|°)\s*([1-9]\d*)\.?", marker.text(), re.I)
    if match is None:
        raise ValueError(f"Invalid Senate agenda identifier at {url}: {marker.text()}")
    return int(match[1])


def future_date(label, language, issue):
    match = FUTURE_DATE[language].fullmatch(label)
    error = f"Invalid future sitting date in Senate agenda issue {issue['issue']}: {label}"
    if match is None:
        raise ValueError(error)
    weekday, first, second, year = match.groups()
    month, day = (first, second) if language == "en" else (second, first)
    try:
        month_number = [name.casefold() for name in MONTHS[language]].index(month.casefold()) + 1
        sitting = date(int(year), month_number, int(day))
    except ValueError as exc:
        raise ValueError(error) from exc
    weekdays = ("monday tuesday wednesday thursday friday saturday sunday" if language == "en"
                else "lundi mardi mercredi jeudi vendredi samedi dimanche").split()
    if sitting.weekday() != weekdays.index(weekday.casefold()) or sitting.isoformat() <= issue["date"]:
        raise ValueError(error)
    return sitting.isoformat()


def parse_orders(content, language, issue):
    url = issue["url"] + "#orders"
    column = 1 if language == "en" else 2
    labels = {entry[column].casefold(): entry[0] for entry in ORDER_CATEGORIES}
    groups = []
    categories = {}
    orders = {}
    in_orders = False
    group = heading = category = current = future = None
    for node in content.walk():
        if node.tag == "a" and node.attrs.get("id") == "orders":
            in_orders = True
        if node.tag == "a" and node.attrs.get("id") == "notice":
            break
        if not in_orders or node.tag not in ("h2", "h3", "p"):
            continue
        label = node.text()
        if node.tag in ("h2", "h3") and future is not None and current is None:
            raise ValueError(f"Future sitting has no Senate order at {url}")
        if node.tag == "h2":
            group = ORDER_GROUPS[language].get(label.casefold())
            if group is None or group in groups:
                raise ValueError(f"Unexpected Senate order business group at {url}: {label}")
            groups.append(group)
            heading = category = current = future = None
        elif node.tag == "h3":
            heading = label
            category = labels.get(label.casefold())
            category_key = f"{group}:{category}"
            if group is None or category is None or category_key in categories:
                raise ValueError(f"Unexpected Senate order category at {url}: {label}")
            categories[category_key] = None
            current = future = None
        elif label:
            marker = node.find(lambda child: cls(child, "OrderNumber"))
            future_marker = node.find(lambda child: cls(child, "OrderFutureDate"))
            if category is None:
                if marker is not None or future_marker is not None:
                    raise ValueError(f"Senate order has no business category at {url}")
                continue
            if future_marker is not None:
                if marker is not None or (future is not None and current is None):
                    raise ValueError(f"Conflicting future sitting markers in Senate orders at {url}")
                future_label = future_marker.text()
                future = future_label, future_date(future_label, language, issue)
                current = None
            elif marker is not None:
                number = order_number(marker, url)
                # Publisher item numbers are scoped to a group and category in each issue.
                key = f"orders:{category_key}:{number}"
                if key in orders or categories[category_key] == "empty":
                    raise ValueError(f"Conflicting Senate order item {key} at {url}")
                current = {"key": key, "business": group, "category": category, "heading": heading,
                           "number": number, "status": "listed", "url": url, "paragraphs": []}
                days = node.find(lambda child: cls(child, "OrderDays"))
                if days is not None:
                    current["orderDaysLabel"] = days.text()
                if future is not None:
                    current["futureSittingLabel"], current["futureSittingDate"] = future
                categories[category_key] = "listed"
                orders[key] = current
            elif label.casefold() in ("nil", "aucun", "aucune"):
                if categories[category_key] is not None or future is not None:
                    raise ValueError(f"Conflicting empty Senate order category at {url}: {heading}")
                categories[category_key] = "empty"
            elif current is not None:
                current["paragraphs"].append(label)
            else:
                raise ValueError(f"Unexpected unnumbered Senate order item at {url}: {label}")
    if (groups != ["government", "other"] or (future is not None and current is None)
            or any(not status for status in categories.values())
            or any(not any(key.startswith(group + ":") for key in categories) for group in groups)
            or any(not order["paragraphs"] for order in orders.values())):
        raise ValueError(f"Incomplete Senate order categories or item text at {url}")
    for order in orders.values():
        if "bills-" in order["category"]:
            order["billNumbers"] = sorted({number.upper() for number in BILL_NUMBER[language].findall(" ".join(order["paragraphs"]))})
    return categories, list(orders.values())


def parse_items(content, language, url):
    section = None
    section_names = []
    headings = set()
    kind = None
    items = {}
    current = None
    for node in content.walk():
        if node.tag == "a" and node.attrs.get("id") in ("orders", "notice", "questions"):
            section = node.attrs["id"]
            section_names.append(section)
            kind = current = None
        if section not in ("notice", "questions"):
            continue
        if node.tag in ("h1", "h2", "h3"):
            kind = HEADINGS[language].get(node.text().casefold())
            headings.add((section, kind))
            current = None
        if node.tag != "p" or kind not in ("motion", "inquiry", "question"):
            continue
        marker = node.find(lambda child: cls(child, "OrderNumber"))
        if marker is not None:
            number = order_number(marker, url)
            key = f"{kind}:{number}"
            if key in items:
                raise ValueError(f"Duplicate Senate agenda identifier {key} at {url}")
            days = node.find(lambda child: cls(child, "OrderDays"))
            current = {"key": key, "kind": kind, "number": number, "section": section,
                       "status": "noticed" if section == "notice" else "listed",
                       "url": f"{url}#{section}", "paragraphs": []}
            if days is not None:
                current["orderDaysLabel"] = days.text()
            items[key] = current
        elif current is not None and node.text():
            current["paragraphs"].append(node.text())
    expected_headings = {("notice", "notice"), ("notice", "motion"), ("notice", "inquiry"), ("questions", "question")}
    if (section_names != ["orders", "notice", "questions"] or not expected_headings <= headings
            or any(not item["paragraphs"] for item in items.values())):
        raise ValueError(f"Incomplete Senate agenda sections or item text at {url}")
    return items


def parse_issue(body, session, issue, language):
    root, title = document(body, language)
    validate_issue_title(title, issue, language)
    content = root.find(lambda node: node.attrs.get("id") == "content-viewer-document")
    if content is None:
        raise ValueError(f"Missing Senate agenda document at {issue['url']}")
    expected_pdf = f"/content/sen/chamber/{session.replace('-', '')}/orderpaper/pdf/{issue['issue']:03d}op_{issue['date']}.pdf"
    pdf_urls = {official_url(node.attrs["href"]) for node in root.findall(
        lambda node: node.tag == "a" and "/orderpaper/pdf/" in node.attrs.get("href", "").lower())}
    if len(pdf_urls) != 1 or next(iter(pdf_urls)).lower() != BASE + expected_pdf:
        raise ValueError(f"Incorrect bilingual Senate agenda PDF at {issue['url']}")
    items = parse_items(content, language, issue["url"])
    categories, orders = parse_orders(content, language, issue)
    return {**issue, "key": str(issue["issue"]), "language": language, "title": title,
            "indexUrl": index_url(session, language), "pdfUrl": next(iter(pdf_urls)), "items": list(items.values()),
            "orderCategories": categories, "orders": orders}


def order_identity(edition):
    return {order["key"]: (order.get("billNumbers"), order.get("futureSittingDate")) for order in edition["orders"]}


def collect(session, fetch, *, requested_issues=()):
    if not re.fullmatch(r"[1-9]\d*-[1-9]\d*", session):
        raise ValueError("Use the parliament-session form, for example 45-1")
    indexes = {language: parse_index(fetch(index_url(session, language)), session, language) for language in INDEX}
    if {key: issue["date"] for key, issue in indexes["en"].items()} != {
        key: issue["date"] for key, issue in indexes["fr"].items()
    }:
        raise ValueError("Senate agenda indexes disagree on issue identities or dates")
    selected = sorted(set(requested_issues)) if requested_issues else sorted(indexes["en"])[-2:]
    if any(number not in indexes["en"] for number in selected):
        raise ValueError("A requested Senate agenda issue is absent from the official indexes")
    records = []
    changes = []
    previous = None
    for number in selected:
        editions = []
        for language, index in indexes.items():
            issue = index[number]
            editions.append(parse_issue(fetch(issue["url"]), session, issue, language))
        keys = [{item["key"] for item in row["items"]} for row in editions]
        if keys[0] != keys[1]:
            raise ValueError(f"Senate agenda issue {number} has mismatched bilingual item identifiers")
        english, french = editions
        if english["orderCategories"] != french["orderCategories"] or order_identity(english) != order_identity(french):
            raise ValueError(f"Senate agenda issue {number} has mismatched bilingual Orders of the Day")
        pdf_url = editions[0]["pdfUrl"]
        if pdf_url != editions[1]["pdfUrl"]:
            raise ValueError(f"Senate agenda issue {number} has mismatched bilingual PDF links")
        pdf = fetch(pdf_url)
        if not pdf.startswith(b"%PDF-") or not pdf.rstrip().endswith(b"%%EOF"):
            raise ValueError(f"Incomplete Senate agenda PDF at {pdf_url}")
        notices = {item["key"] for item in editions[0]["items"] if item["section"] == "notice"}
        if previous is not None and previous[0] + 1 == number:
            changes.append({"previousIssue": previous[0], "issue": number,
                            "added": sorted(notices - previous[1]), "removed": sorted(previous[1] - notices)})
        previous = number, notices
        records.extend(editions)
    numbers = sorted(indexes["en"])
    unlisted = sorted(set(range(1, numbers[-1] + 1)) - indexes["en"].keys())
    return {"collection": "senate-agenda", "session": session,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "discoveredIssues": len(numbers), "unlistedIssueNumbers": unlisted,
            "records": records, "noticeChanges": changes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", default="45-1")
    parser.add_argument("--issue", action="append", type=int, help="an indexed issue number, repeatable")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        result = archive_inventory(args.output, args.session,
                                   partial(collect, requested_issues=args.issue or ()), fetch_url)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(f"Wrote {len(result['records'])} Senate agenda language editions to {args.output}")


if __name__ == "__main__":
    main()
