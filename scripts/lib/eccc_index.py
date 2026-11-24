"""Parse ECCC departmental-publication index pages."""

from __future__ import annotations

import hashlib
from html.parser import HTMLParser
import re
import unicodedata
from urllib.parse import unquote, urljoin, urlsplit

SERIES = ("eval", "audit")
LANGUAGES = ("en", "fr")
BASE_URL = "https://www.canada.ca"


class _Element:
    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []


class _TreeParser(HTMLParser):
    VOID_ELEMENTS = {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Element("document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        element = _Element(tag, attrs)
        self.stack[-1].children.append(element)
        if tag not in self.VOID_ELEMENTS:
            self.stack.append(element)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(_Element(tag, attrs))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def _text(node, exclude=None):
    if node is exclude:
        return ""
    if isinstance(node, str):
        return node
    return "".join(_text(child, exclude) for child in node.children)


def _normalized_text(value):
    return re.sub(r"\s+", " ", value).strip()


def _descendants(node, tag):
    for child in node.children:
        if isinstance(child, _Element):
            if child.tag == tag:
                yield child
            yield from _descendants(child, tag)


def _entry_pairs(node):
    children = node.children
    for index, child in enumerate(children):
        if not isinstance(child, _Element):
            continue
        if child.tag == "p":
            for following in children[index + 1 :]:
                if not isinstance(following, _Element):
                    continue
                if following.tag == "ul":
                    yield child, following
                break
        if child.tag != "p":
            yield from _entry_pairs(child)


def _lead_span(paragraph):
    for span in _descendants(paragraph, "span"):
        if "nowrap" not in span.attrs.get("class", "").split():
            continue
        match = re.fullmatch(
            r"\s*\(\s*(?:led\s+by|dirigé\s+par)\s+(.+?)\s*\)\s*",
            _normalized_text(_text(span)),
            re.IGNORECASE,
        )
        if match:
            return span, _normalized_text(match.group(1))
    return None, None


def _title_and_lead(paragraph):
    lead_span, lead = _lead_span(paragraph)
    if lead_span is not None:
        return _normalized_text(_text(paragraph, exclude=lead_span)), lead

    text = _normalized_text(_text(paragraph))
    match = re.search(
        r"\s*\(\s*(?:led\s+by|dirigé\s+par)\s+(.+?)\s*\)\s*$",
        text,
        re.IGNORECASE,
    )
    if match:
        return text[: match.start()].rstrip(), _normalized_text(match.group(1))
    return text, None


def _link_kind(label):
    normalized = _normalized_text(label).casefold()
    if normalized in {"summary", "sommaire"}:
        return "summary"
    if normalized in {"report", "rapport", "rapport final"}:
        return "report"
    if re.match(r"^evaluation summary(?:\b|$)", normalized):
        return "evaluation-summary"
    if re.match(r"^plan(?:\b|$)", normalized):
        return "plan"
    return "other"


def _links(list_node):
    result = []
    for anchor in _descendants(list_node, "a"):
        href = anchor.attrs.get("href")
        if not href:
            continue
        label = _normalized_text(_text(anchor))
        absolute = urljoin(BASE_URL, href.strip())
        path = urlsplit(absolute).path
        result.append(
            {
                "label": label,
                "kind": _link_kind(label),
                "href": absolute,
                "path": path,
                "pdf": path.lower().endswith(".pdf")
                or bool(re.search(r"\bpdf\b", label, re.IGNORECASE)),
            }
        )
    return result


def parse_index(html: str, series: str, language: str) -> list[dict]:
    """Return work entries in the order they appear on an ECCC index."""
    if series not in SERIES:
        raise ValueError(f"Unsupported ECCC series: {series}")
    if language not in LANGUAGES:
        raise ValueError(f"Unsupported ECCC language: {language}")

    parser = _TreeParser()
    parser.feed(html)
    parser.close()

    entries = []
    for details in _descendants(parser.root, "details"):
        summaries = list(_descendants(details, "summary"))
        fiscal_year = _normalized_text(_text(summaries[0])) if summaries else ""
        for paragraph, list_node in _entry_pairs(details):
            title, lead = _title_and_lead(paragraph)
            links = _links(list_node)
            if not title or not links:
                continue
            entries.append(
                {
                    "series": series,
                    "language": language,
                    "fiscal_year": fiscal_year,
                    "title": title,
                    "lead": lead,
                    "links": links,
                }
            )
    return entries


def work_id(series: str, entry: dict) -> str:
    """Build a stable work identifier from its preferred publisher link."""
    if series not in SERIES:
        raise ValueError(f"Unsupported ECCC series: {series}")

    preferred_kinds = ("report", "evaluation-summary", "summary")
    link = next(
        (
            item
            for kind in preferred_kinds
            for item in entry.get("links", [])
            if item.get("kind") == kind
        ),
        None,
    )
    if link is None:
        link = next(iter(entry.get("links", [])), None)
    if link is None:
        raise ValueError("Cannot build an ECCC work ID without a link")

    basename = unquote(urlsplit(link.get("href", "")).path.rsplit("/", 1)[-1])
    basename = re.sub(r"\.(?:html|pdf)$", "", basename, flags=re.IGNORECASE)
    slug = re.sub(r"[^a-z0-9]+", "-", basename.lower()).strip("-")
    slug = slug[:80].rstrip("-")
    if not slug:
        raise ValueError("Cannot build an ECCC work ID without a usable link slug")
    return f"eccc-{series}-{slug}"


def document_id(work_id: str, language: str, kind: str, href: str) -> str:
    """Identify a language/kind document while retaining same-kind URLs."""
    digest = hashlib.sha256(href.encode("utf-8")).hexdigest()[:8]
    return f"{work_id}.{language}.{kind}.{digest}"


def pair_key(entry: dict) -> str:
    """Normalize a title for finding possible bilingual index counterparts."""
    decomposed = unicodedata.normalize("NFKD", entry.get("title", "").lower())
    unaccented = "".join(
        character for character in decomposed if not unicodedata.combining(character)
    )
    unpunctuated = "".join(
        ""
        if unicodedata.category(character).startswith("P")
        else character
        for character in unaccented
    )
    return _normalized_text(unpunctuated)
