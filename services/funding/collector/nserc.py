"""Parse the NSERC College and Community Innovation catalogue in both languages."""

import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse



BASE = "https://nserc-crsng.canada.ca"
INDEXES = {
    # NSERC's current CCI taxonomy facet. Retired calls require its separate
    # field_archived=1 view and are intentionally outside forward intake.
    "en": BASE + "/en/funding/funding-opportunity?field_program_type_unique%5B891%5D=891",
    "fr": BASE + "/fr/financement/possibilite-de-financement?field_program_type_unique%5B891%5D=891",
}
FIELDS = {
    "overview": ("overview", "description", "aperçu", "description"),
    "eligibility": ("eligibility", "eligible", "admissib", "who?", "qui?", "who can apply", "qui peut présenter une demande", "personnes admissibles"),
    "partners": ("partner", "partnership", "partenaire", "partenariat"),
    "amount": ("how much", "amount", "funding", "financement", "value and duration", "valeur et durée"),
    "deadline": ("deadline", "application deadline", "date limite", "échéance"),
    "status": ("status", "competition status", "état", "statut"),
    "other": ("how long", "duration", "durée", "pendant combien de temps"),
}
STATUS = {
    "open": ("open", "ouvert", "ouverte"),
    "closed": ("closed", "fermé", "fermée", "clôturé", "clôturée"),
    "upcoming": ("upcoming", "à venir", "bientôt"),
    "ongoing": ("ongoing", "continuous", "any time", "en tout temps", "continu"),
    "invitation-only": ("invitation only", "by invitation", "sur invitation", "invitation seulement"),
}
ALLOWED_HOSTS = {"nserc-crsng.canada.ca", "www.nserc-crsng.canada.ca"}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def text_tree(node) -> str:
    if isinstance(node, str):
        return node
    return clean(" ".join(text_tree(x) for x in node[1]))


class Tree(HTMLParser):
    """Small DOM-like tree sufficient for publisher Drupal markup."""
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = ["document", [], {}]
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = [tag, [], dict(attrs)]
        self.stack[-1][1].append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1][1].append([tag, [], dict(attrs)])

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1][1].append(data)


def walk(node):
    if isinstance(node, str):
        return
    yield node
    for child in node[1]:
        yield from walk(child)


def attrs(node):
    return node[2]


def get_text(node):
    return text_tree(node)


def absolute(base, href):
    u = urlparse(urljoin(base, href))
    if u.scheme != "https" or u.hostname not in ALLOWED_HOSTS:
        return None
    return urlunparse(("https", u.netloc, u.path, "", u.query, ""))


def slug_from_url(url):
    slug = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-") or "untitled"


def classify_status(status_text):
    value = (status_text or "").casefold()
    for status, terms in STATUS.items():
        if any(term in value for term in terms):
            return status
    return "unknown"


def language_links(tree, page_url):
    """Return explicit language-switch links found in the publisher page."""
    links = {}
    for n in walk(tree):
        a = attrs(n)
        href = a.get("href")
        if not href:
            continue
        lang = (a.get("hreflang") or a.get("lang") or "").split("-")[0].lower()
        classes = a.get("class", "").lower()
        if lang in ("en", "fr"):
            target = absolute(page_url, href)
            if target:
                links[lang] = target
        elif "language-link" in classes or "language-switch" in classes:
            target = absolute(page_url, href)
            if target:
                path = urlparse(target).path
                candidate = "fr" if path.startswith("/fr/") else "en" if path.startswith("/en/") else None
                if candidate:
                    links[candidate] = target
        for attribute in ("lang-href",):
            if a.get(attribute):
                target = absolute(page_url, a[attribute])
                if target:
                    path = urlparse(target).path
                    candidate = "fr" if path.startswith("/fr/") else "en" if path.startswith("/en/") else None
                    if candidate:
                        links[candidate] = target
    return links


def extract_cards(html, page_url, language):
    tree = Tree(); tree.feed(html.decode("utf-8", "replace"))
    result = []
    seen = set()
    for n in walk(tree.root):
        if n[0] not in ("article", "div", "li"):
            continue
        classes = attrs(n).get("class", "").lower()
        if not any(x in classes for x in ("views-row", "search-result", "funding-opportunity", "node--type-funding")):
            continue
        anchors = [x for x in walk(n) if x[0] in ("a", "gcds-link") and attrs(x).get("href")]
        candidate = None
        for a in anchors:
            href = absolute(page_url, attrs(a)["href"])
            if href and ("/funding-opportunity/" in href or "/possibilite-de-financement/" in href):
                candidate = (get_text(a), href); break
        if candidate and candidate[1] in seen:
            continue
        if not candidate:
            raise ValueError(f"malformed {language} funding result card has no NSERC detail link: {page_url}")
        title, url = candidate
        if not title:
            raise ValueError(f"malformed {language} funding result card has no title: {url}")
        seen.add(url)
        txt = get_text(n)
        # Status is a short standalone field in each result card.
        status_text = None
        for item in walk(n):
            cls = attrs(item).get("class", "").lower()
            label = get_text(item)
            if ("status" in cls or "fo-status" in cls) and label and len(label) < 50:
                status_text = label; break
        if status_text is None:
            status_text = next((s for s in ("Open", "Closed", "Upcoming", "Ongoing", "Ouvert", "Fermé", "À venir", "Continu") if re.search(rf"\b{re.escape(s)}\b", txt, re.I)), None)
        result.append({"title": title, "url": url, "language": language, "statusText": status_text, "index": page_url})
    return result


def reported_total(html, page_url, language):
    tree = Tree(); tree.feed(html.decode("utf-8", "replace"))
    text = get_text(tree.root)
    patterns = (
        (r"\bDisplaying\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)\s+results?\b",)
        if language == "en" else
        (r"\bAffichage des éléments\s+[\d\s]+\s+[àa]\s+[\d\s]+\s+de\s+([\d\s]+)\s+résultats?\b",)
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return int(re.sub(r"\D", "", match.group(1)))
    if re.search(r"no results(?: found)?|aucun r(?:é|e)sultat", text, re.I):
        return 0
    raise ValueError(f"could not parse publisher-reported {language} result total: {page_url}")


def next_page(html, page_url):
    tree = Tree(); tree.feed(html.decode("utf-8", "replace"))
    for n in walk(tree.root):
        if n[0] != "a" or not attrs(n).get("href"):
            continue
        cls = attrs(n).get("rel", "") + " " + attrs(n).get("class", "")
        label = get_text(n).casefold()
        if "next" in cls.casefold() or label in {"next", "suivant", "suivante", "›", "»"}:
            return absolute(page_url, attrs(n)["href"])
    return None


def classify_heading(heading):
    h = heading.casefold()
    if h.strip(" ?!:") in {"combien", "how much"}:
        return "amount"
    for field, terms in FIELDS.items():
        if any(term in h for term in terms):
            return field
    return "other"


def heading_level(node):
    if node[0] in ("h2", "h3", "h4"):
        return node[0]
    if node[0] == "gcds-heading":
        return attrs(node).get("tag", "").lower()
    return ""


def detail_sections(html, page_url):
    tree = Tree(); tree.feed(html.decode("utf-8", "replace"))
    sections = []
    title = None
    for n in walk(tree.root):
        if (n[0] == "h1" or (n[0] == "gcds-heading" and attrs(n).get("tag", "").lower() == "h1")) and get_text(n):
            title = get_text(n); break
    links = language_links(tree.root, page_url)
    # Header overview table on current NSERC opportunity pages.
    for n in walk(tree.root):
        if n[0] == "table":
            table_text = get_text(n).casefold()
            if "average yearly amount requested" in table_text or "montant annuel moyen demandé" in table_text:
                continue  # Review-band thresholds, not award amounts.
            for row in (x for x in walk(n) if x[0] == "tr"):
                cells = [get_text(x) for x in row[1] if not isinstance(x, str) and x[0] in ("th", "td")]
                if len(cells) >= 2 and cells[0] and cells[1]:
                    sections.append({"field": classify_heading(cells[0]), "heading": cells[0], "text": cells[1], "url": page_url})
    # Drupal's current funding-opportunity template presents the key terms as
    # labelled field blocks, not a table. Preserve each field as its own item.
    for n in walk(tree.root):
        if n[0] != "div" or "field" not in attrs(n).get("class", "").split():
            continue
        label = next((get_text(x) for x in walk(n) if "field__label" in attrs(x).get("class", "").split()), "")
        value = next((get_text(x) for x in walk(n) if "field__item" in attrs(x).get("class", "").split()), "")
        if label and value and label != value:
            sections.append({"field": classify_heading(label), "heading": label, "text": value, "url": page_url})
    # Main content headings are captured with their following content until next heading.
    nodes = list(walk(tree.root))
    for i, n in enumerate(nodes):
        level = heading_level(n)
        if level not in ("h2", "h3", "h4"):
            continue
        heading = get_text(n)
        if not heading or heading.casefold() in {"on this page", "sur cette page", "back to top", "haut de page"}:
            continue
        snippets = []
        for later in nodes[i + 1:]:
            if heading_level(later) in ("h2", "h3", "h4"):
                break
            if later[0] in ("p", "li", "td", "dd"):
                t = get_text(later)
                if t:
                    snippets.append(t)
        if snippets:
            sections.append({"field": classify_heading(heading), "heading": heading, "text": clean(" ".join(snippets)), "url": page_url})
    # Current detail pages use a compact overview block whose status is not
    # always repeated on the search result page.
    for n in walk(tree.root):
        cls = attrs(n).get("class", "").split()
        if any(x == "status" or x.startswith("status-") for x in cls):
            text = get_text(n)
            if text and len(text) < 40:
                sections.append({"field": "status", "heading": "Status" if page_url.startswith(BASE + "/en/") else "Statut", "text": text, "url": page_url})
                break
    return title, links, sections


def requested_pages(indexes):
    """Yield publisher URLs and consume their bytes from the local or hosted transport."""
    all_cards = {"en": [], "fr": []}
    # Each language is enumerated independently; don't construct one edition from the other.
    for lang, start in indexes.items():
        url = start; seen_pages = set(); seen_records = set(); total = None
        while url:
            if url in seen_pages:
                raise ValueError(f"pagination cycle in {lang} index at {url}")
            seen_pages.add(url)
            data = yield url
            page_total = reported_total(data, url, lang)
            if total is not None and total != page_total:
                raise ValueError(f"publisher-reported {lang} result total changed across pages: {total} != {page_total}")
            total = page_total
            cards = extract_cards(data, url, lang)
            for card in cards:
                if card["url"] not in seen_records:
                    seen_records.add(card["url"]); all_cards[lang].append(card)
            url = next_page(data, url)
        if len(all_cards[lang]) != total:
            raise ValueError(f"parsed {len(all_cards[lang])} {lang} records but NSERC reports {total}")

    cards_by_lang = {lang: {c["url"]: c for c in cards} for lang, cards in all_cards.items()}
    detail_data = {}
    for lang in ("en", "fr"):
        for card in all_cards[lang]:
            html = yield card["url"]
            title, translations, sections = detail_sections(html, card["url"])
            if not title:
                raise ValueError(f"could not parse detail page title: {card['url']}")
            detail_data[(lang, card["url"])] = (title, translations, sections)

    # Only a publisher-supplied link can establish that two indexed editions are translations.
    pairs = {}
    for lang in ("en", "fr"):
        for card in all_cards[lang]:
            other = "fr" if lang == "en" else "en"
            peer = detail_data[(lang, card["url"])][1].get(other)
            if not peer:
                continue
            if peer in cards_by_lang[other]:
                pairs[card["url"]] = peer
                pairs[peer] = card["url"]
    records = []
    gaps = []
    for lang in ("en", "fr"):
        for card in all_cards[lang]:
            title, translations, sections = detail_data[(lang, card["url"])]
            peer = pairs.get(card["url"])
            if peer:
                english_url = card["url"] if lang == "en" else peer
                slug = slug_from_url(english_url)
            else:
                linked_english_url = translations.get("en") if lang == "fr" else card["url"]
                slug = slug_from_url(linked_english_url or card["url"])
                missing_language = "fr" if lang == "en" else "en"
                missing_url = translations.get(missing_language)
                gaps.append({"language": missing_language, "id": "nserc-" + slug, "url": missing_url or card["url"], "reason": ("NSERC detail page links to this edition’s counterpart, but that counterpart is absent from the independently collected index; the published edition is retained." if missing_url else "NSERC detail page did not expose a matching translation link; the published edition is retained independently.")})
            status_text = card["statusText"]
            if not status_text:
                status_text = next((s["text"] for s in sections if s["field"] == "status"), None)
            sections = [s for s in sections if s["field"] != "status"]
            availability = "published" if sections else "metadata-only"
            if not sections:
                gaps.append({"language": lang, "id": "nserc-" + slug, "url": card["url"],
                             "reason": "Publisher detail has no recognized program terms."})
            if status_text:
                sections.append({"field": "status", "heading": "Status" if lang == "en" else "Statut", "text": status_text, "url": card["index"] if card["statusText"] else card["url"]})
            records.append({"id": "nserc-" + slug, "language": lang, "title": title, "url": card["url"], "status": classify_status(status_text), "statusText": status_text, "sections": sections, "availability": availability})
    # Deduplicate gap reports, preserving each publisher-linked gap.
    unique_gaps = []
    seen = set()
    for gap in gaps:
        key = (gap["language"], gap["url"], gap["reason"])
        if key not in seen:
            seen.add(key); unique_gaps.append(gap)
    return {"indexes": indexes, "records": records, "gaps": unique_gaps}
