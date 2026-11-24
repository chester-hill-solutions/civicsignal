"""Extract non-testimony committee publications and substantive inline attachments."""
from __future__ import annotations

from html.parser import HTMLParser
import re
from urllib.parse import parse_qsl, parse_qs, quote, urljoin, urlsplit, urldefrag


MAX_PUBLICATION_BYTES = 32 * 1024 * 1024
OFFICIAL_HOSTS = {"ourcommons.ca", "noscommunes.ca", "sencanada.ca", "parl.ca", "canada.ca",
                  "gc.ca", "publications.gc.ca"}
FILE_EXTENSIONS = (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf", ".txt")
PART_WORDS = re.compile(r"\b(?:exhibit|appendix|appendices|annex|annexe|pi[eè]ce|chapter|chapitre|attachment|annexe)\b", re.I)
BLOCKS = {"p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}
HEADING_LEVEL = {f"h{i}": i for i in range(1, 7)}
PUBLICATION_DIVS = {"tv-text-identifier", "MeetingNumber", "Header", "HeaderAmended", "AmendedSection",
                    "StudyActivity", "Property", "OrganizationName", "WitnessListItem", "SignatureFixedText",
                    "Signature", "report-title", "CommitteeName", "SessionDescription"}


def _clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


class _PublicationParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, dict, bool]] = []
        self.roots: list[int] = []
        self.root_kind: str | None = None
        self.hidden = 0
        self.blocks: list[dict] = []
        self.current: dict | None = None
        self.headings: dict[int, str] = {}
        self.ordinal = 0
        self.heading_text: list[str] = []
        self.active_link: dict | None = None
        self.awaiting_senate_report_body = False

    @property
    def in_scope(self) -> bool:
        return bool(self.roots)

    def _start_root(self, tag: str, attrs: dict) -> bool:
        classes = set((attrs.get("class") or "").split())
        if self.roots:
            return False
        if tag == "h3" and "right-heading" in classes and any(
                ancestor == "main" and ancestor_attrs.get("id") == "sc-main-content"
                for ancestor, ancestor_attrs, _ in self.stack):
            self.awaiting_senate_report_body = True
            return False
        if tag == "div" and self.awaiting_senate_report_body:
            self.awaiting_senate_report_body = False
            self.root_kind = "senate-report"
            return True
        if "publication-container-content" in classes or attrs.get("id") == "docContent":
            self.root_kind = "house"
            return True
        if attrs.get("id") == "content-viewer-document":
            self.root_kind = "senate-document"
            return True
        if "notice-of-meeting-details" in classes:
            self.root_kind = "senate-notice"
            return True
        return False

    def _begin_block(self, tag: str, attrs: dict) -> None:
        if self.current is not None:
            return
        self.ordinal += 1
        self.current = {"tag": tag, "depth": len(self.stack), "attrs": attrs, "text": [], "links": [],
                        "ordinal": self.ordinal}

    def _flush(self) -> None:
        if self.current is None:
            return
        block = self.current
        self.current = None
        text = _clean("".join(block["text"]))
        if not text:
            return
        tag = block["tag"]
        level = HEADING_LEVEL.get(tag)
        classes = set((block["attrs"].get("class") or "").split())
        if not level and "report-title" in classes:
            level = 1
        if not level and tag == "p" and any(c.casefold() == "center" for c in classes) and re.search(
                r"\b(?:minutes of proceedings|evidence|report|rapport|proc[eè]s-verbal|t[eé]moignages)\b", text, re.I):
            level = 2
        if level:
            self.headings = {n: value for n, value in self.headings.items() if n < level}
            self.headings[level] = text
            self.heading_text.append(text)
            location = ("section:" + " / ".join(self.headings[n] for n in sorted(self.headings)))
        else:
            anchor = block["attrs"].get("id") or block["attrs"].get("name")
            path = " / ".join(self.headings[n] for n in sorted(self.headings))
            location = f"anchor:{anchor}" if anchor else (f"section:{path},block:{block['ordinal']}" if path
                                                            else f"block:{block['ordinal']}")
        block["text"] = text
        block["location"] = location
        block["heading_path"] = " / ".join(self.headings[n] for n in sorted(self.headings))
        self.blocks.append(block)

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = {key: value for key, value in attrs_list if value is not None}
        is_root = self._start_root(tag, attrs)
        self.stack.append((tag, attrs, is_root))
        if is_root:
            self.roots.append(len(self.stack))
        if not self.in_scope:
            return
        if tag in {"script", "style", "noscript", "svg", "template", "nav"}:
            self.hidden += 1
        if self.hidden:
            return
        classes = set((attrs.get("class") or "").split())
        is_publication_div = tag == "div" and bool(classes & PUBLICATION_DIVS)
        if tag in BLOCKS or is_publication_div:
            self._begin_block(tag, attrs)
        if self.current is not None and tag == "a" and attrs.get("href"):
            self.active_link = {"href": attrs["href"], "title": attrs.get("title"), "text": []}

    def handle_endtag(self, tag: str) -> None:
        if not self.stack:
            return
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i][0] == tag), None)
        if index is None:
            return
        removed = self.stack[index:]
        if self.current is not None and self.current["tag"] == tag and self.current["depth"] == index + 1:
            self._flush()
        elif self.current is not None and self.current["tag"] == "tr" and tag in {"td", "th"}:
            self.current["text"].append(" ")
        for old_tag, attrs, is_root in reversed(removed):
            classes = set((attrs.get("class") or "").split())
            if old_tag in {"script", "style", "noscript", "svg", "template", "nav"} and self.hidden:
                self.hidden -= 1
            if is_root and self.roots:
                self.roots.pop()
                if not self.roots:
                    self.root_kind = None
            if old_tag == "a" and self.active_link is not None and self.current is not None:
                self.active_link["text"] = _clean("".join(self.active_link["text"]))
                self.current["links"].append(self.active_link)
                self.active_link = None
        del self.stack[index:]

    def handle_data(self, data: str) -> None:
        if not self.in_scope or self.hidden:
            return
        if self.current is not None:
            self.current["text"].append(data)
            if self.active_link is not None:
                self.active_link["text"].append(data)

    def close(self) -> None:
        super().close()
        self._flush()


_META_DATE_LABEL = re.compile(r"(?:^|[-_ ])(?:meeting|study|report|response|publication|presentation|presented|received)?[-_ ]*(?:date|time|datetime)$", re.I)
_METADATA_CLASSES = {"Property", "OrganizationName", "WitnessListItem", "accordion-bar", "Amended",
                     "Cancelled", "Canceled", "Header", "HeaderAmended", "AmendedSection", "MeetingNumber",
                     "notice-of-meeting-date", "notice-of-meeting-time", "notice-of-meeting-wrapper",
                     "notice-of-meeting-details", "MeetingDate", "MeetingTime", "Status"}


class _PublicationMetadataParser(HTMLParser):
    """Collect only source-labelled metadata nodes and explicitly linked players."""
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.stack: list[dict] = []
        self.nodes: list[dict] = []
        self.dates: list[dict] = []
        self.player_urls: list[dict] = []

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = {key: value for key, value in attrs_list if value is not None}
        classes = set((attrs.get("class") or "").split())
        if tag.lower() == "meta":
            label = attrs.get("name") or attrs.get("property") or ""
            value = _clean(attrs.get("content"))
            if value and _META_DATE_LABEL.search(label):
                self.dates.append({"label": label, "value": value, "location": f"meta:{label}"})
            return
        frame = {"tag": tag, "attrs": attrs, "text": [], "capture": None,
                 "ancestors": [(item["tag"], item["attrs"]) for item in self.stack], "anchor_ids": [],
                 "icon_clock": False}
        if attrs.get("id"):
            for parent in self.stack:
                if parent["capture"] is not None:
                    parent["anchor_ids"].append(attrs["id"])
        for class_name in _METADATA_CLASSES:
            if class_name in classes:
                frame["capture"] = f"class:{class_name}"
                break
        if tag.lower() in ("h1", "h2"):
            frame["capture"] = f"heading:{tag.lower()}"
        if tag.lower() in ("a", "iframe", "video", "source", "audio"):
            frame["capture"] = "player-element" if tag.lower() != "a" else "link-element"
        if tag.lower() == "i" and any("icon-clock" in c for c in classes):
            parent = next((item for item in reversed(self.stack) if item["tag"] == "div"), None)
            if parent:
                parent["icon_clock"] = True
                if parent["capture"] is None:
                    parent["capture"] = "class:icon-clock"
        if tag.lower() == "source":
            resolved = _official_player_url(attrs.get("src"), self.base_url)
            if resolved:
                self.player_urls.append({"url": resolved, "label": _clean(attrs.get("title")) or "player source"})
            return
        self.stack.append(frame)

    def handle_data(self, data: str) -> None:
        for frame in self.stack:
            if frame["capture"] is not None:
                frame["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i]["tag"] == tag), None)
        if index is None:
            return
        removed = self.stack[index:]
        for frame in reversed(removed):
            capture = frame["capture"]
            if capture is None:
                continue
            attrs = frame["attrs"]
            text = _clean("".join(frame["text"]))
            if capture == "link-element":
                href = attrs.get("href")
                resolved = _official_player_url(href, self.base_url) if href else None
                if resolved:
                    self.player_urls.append({"url": resolved, "label": text or _clean(attrs.get("title")) or "player link"})
            elif capture == "player-element":
                source = attrs.get("src") or attrs.get("data")
                resolved = _official_player_url(source, self.base_url) if source else None
                if resolved:
                    self.player_urls.append({"url": resolved, "label": _clean(attrs.get("title")) or "player element"})
            else:
                ancestors = frame["ancestors"]
                location = attrs.get("id") or attrs.get("name") or (frame["anchor_ids"][0] if frame["anchor_ids"] else capture)
                self.nodes.append({"label": capture, "text": text, "location": str(location),
                                   "attrs": attrs, "ancestors": ancestors, "icon_clock": frame["icon_clock"]})
                if frame["icon_clock"] and text:
                    self.dates.append({"label": "icon-clock", "value": text, "location": str(location)})
        del self.stack[index:]

    def close(self) -> None:
        super().close()
        while self.stack:
            self.handle_endtag(self.stack[-1]["tag"])


def _official_player_url(raw: str | None, base: str) -> str | None:
    if not raw:
        return None
    resolved = urljoin(base, raw)
    parts = urlsplit(resolved)
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme.lower() != "https" or not host.endswith(".parl.gc.ca") or parts.username or parts.password:
        return None
    if "parlvu" not in host and "parl-vu" not in host:
        return None
    if not any(token in parts.path.lower() for token in ("/harmony/", "/powerbrowser", "/player")):
        return None
    if not any(key.lower() in {"fk", "globalstreamid", "eventid", "meetingid"}
               for key, _ in parse_qsl(parts.query)):
        return None
    return resolved


def _document(body: bytes, url: str) -> _PublicationParser:
    if not isinstance(body, bytes):
        raise TypeError("body must be bytes")
    if len(body) > MAX_PUBLICATION_BYTES:
        raise ValueError("committee publication HTML exceeds the byte limit")
    parser = _PublicationParser()
    parser.feed(body.decode("utf-8-sig", "replace"))
    parser.close()
    return parser


_MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December|janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)"
_DATE_VALUE = rf"(?:\d{{4}}-\d{{2}}-\d{{2}}|(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche),?\s+)?{_MONTH}\s+\d{{1,2}},?\s+\d{{4}}|\d{{1,2}}(?:er|e|\.)?\s+{_MONTH}\s+\d{{4}})"


def _date_from_text(text: str) -> list[dict]:
    patterns = [
        (rf"(?P<label>presented to the (?:House of Commons|House|Senate))\s+on\s+(?P<date>{_DATE_VALUE})",
         "Presented to the"),
        (rf"(?P<label>(?:government )?response|r[eé]ponse(?: du gouvernement)?)\s+(?:was\s+)?(?:received|tabled|presented|submitted|re[cç]ue|d[eé]pos[eé]e|pr[eé]sent[eé]e)\s+(?:on|le)\s+(?P<date>{_DATE_VALUE})",
         "Response date"),
        (rf"(?P<label>study|[eé]tude)\s+(?:began|started|opened|commenced|a commenc[eé])\s+(?:on|le)\s+(?P<date>{_DATE_VALUE})",
         "Study date"),
        (rf"(?P<label>(?:date of (?:the )?(?:report|response|presentation)|date du (?:rapport|de la r[eé]ponse)))\s*[:\-]\s*(?P<date>{_DATE_VALUE})",
         "Publication date"),
    ]
    found = []
    for pattern, canonical in patterns:
        for match in re.finditer(pattern, text, re.I):
            label = _clean(match.group("label"))
            if label.lower().startswith("presented"):
                label = "Presented to " + label[len("presented to "):]
            elif "response" in label.lower() or "réponse" in label.lower():
                label = "Response date"
            elif "study" in label.lower() or "étude" in label.lower():
                label = "Study date"
            else:
                label = canonical
            found.append({"label": label, "value": _clean(match.group("date")), "location": "publication-text"})
    return found


def _accordion_key(node: dict, kind: str) -> str | None:
    marker = f"accordion-{kind}-item-"
    for _tag, attrs in node.get("ancestors", []):
        identifier = attrs.get("id") or ""
        if marker in identifier:
            return identifier.split(marker, 1)[1]
    return None


def _is_witness_section(label: str | None) -> bool:
    return bool(label and re.fullmatch(r"\s*(?:witnesses|t[eé]moins|witness list)\s*", label, re.I))


def publication_metadata(body: bytes, url: str, language: str) -> dict:
    """Capture explicitly published meeting/publication metadata without filling gaps.

    Dates retain source labels and verbatim values. Witness affiliations are only
    represented when the publisher groups witnesses under an explicit organization.
    Playback offsets are not inferred or emitted.
    """
    if language not in ("en", "fr"):
        raise ValueError("language must be en or fr")
    publication = _document(body, url)
    metadata_parser = _PublicationMetadataParser(url)
    metadata_parser.feed(body.decode("utf-8-sig", "replace"))
    metadata_parser.close()

    dates = list(metadata_parser.dates)
    for node in metadata_parser.nodes:
        if node["label"] in {"class:notice-of-meeting-date", "class:notice-of-meeting-time",
                              "class:MeetingDate", "class:MeetingTime"} and node["text"]:
            dates.append({"label": node["label"].removeprefix("class:"), "value": _clean(node["text"]),
                          "location": node["location"]})
    for block in publication.blocks:
        dates.extend(_date_from_text(block["text"]))
    unique_dates = []
    seen_dates = set()
    for item in dates:
        key = (item["label"], item["value"], item["location"])
        if key not in seen_dates:
            seen_dates.add(key)
            unique_dates.append(item)

    statuses: list[dict] = []
    seen_statuses = set()

    def add_status(label: str, value: str, location: str) -> None:
        key = (label, value)
        if key not in seen_statuses:
            seen_statuses.add(key)
            statuses.append({"label": label, "value": value, "location": location})

    for node in metadata_parser.nodes:
        text = _clean(node["text"])
        classes = node["label"].removeprefix("class:")
        if classes in {"Amended", "Cancelled", "Canceled"} or re.search(r"\b(?:amended|cancelled|canceled)\b", text, re.I) and (
                classes.startswith("heading:") or classes in {"Header", "HeaderAmended", "AmendedSection", "Status"}):
            if re.search(r"\b(?:cancelled|canceled)\b", text, re.I) or classes in {"Cancelled", "Canceled"}:
                add_status("Cancelled" if "cancelled" in text.lower() or classes == "Cancelled" else "Canceled", "cancelled", node["location"])
            else:
                add_status("Amended", "amended", node["location"])
        if classes in {"Header", "HeaderAmended", "AmendedSection", "Status", "notice-of-meeting-details"}:
            if re.search(r"\bin camera\b|\bclosed meeting\b", text, re.I):
                add_status("In Camera" if re.search(r"\bin camera\b", text, re.I) else "Closed meeting", "in-camera", node["location"])
            if re.search(r"\bpublic meeting\b|\bopen to (?:the )?public\b", text, re.I):
                add_status("Public meeting", "public", node["location"])
            elif re.fullmatch(r"\s*public\s*", text, re.I):
                add_status("Public", "public", node["location"])

    accordion_labels = {}
    for node in metadata_parser.nodes:
        if node["label"] == "class:accordion-bar":
            key = _accordion_key(node, "heading")
            if key:
                accordion_labels[key] = _clean(node["text"])

    witnesses = []
    organizations = []
    current_section: str | None = None
    current_organization: str | None = None
    for node in metadata_parser.nodes:
        label = node["label"]
        text = _clean(node["text"])
        if label == "class:Property":
            current_section = text
            current_organization = None
        elif label == "class:OrganizationName":
            section_key = _accordion_key(node, "collapse")
            section = accordion_labels.get(section_key, current_section) if section_key else current_section
            current_section = section
            if _is_witness_section(section):
                current_organization = text or None
                if current_organization and current_organization not in organizations:
                    organizations.append(current_organization)
        elif label == "class:WitnessListItem":
            section_key = _accordion_key(node, "collapse")
            section = accordion_labels.get(section_key, current_section) if section_key else current_section
            if _is_witness_section(section):
                name = re.sub(r"^[\s\u00a0\u2022\u00b7]+", "", text).strip()
                if name:
                    witness = {"name": name, "organization": current_organization,
                               "location": node["location"]}
                    if witness not in witnesses:
                        witnesses.append(witness)

    result = {}
    if unique_dates:
        result["dates"] = unique_dates
    if witnesses:
        result["witnesses"] = witnesses
    if organizations:
        result["organizations"] = organizations
    if statuses:
        result["status"] = statuses
    if metadata_parser.player_urls:
        players = []
        seen_players = set()
        for item in metadata_parser.player_urls:
            key = item["url"]
            if key not in seen_players:
                seen_players.add(key)
                players.append(item)
        result["playerUrls"] = players
    return result


def _is_testimony(parser: _PublicationParser, url: str) -> bool:
    path = urlsplit(url).path.lower()
    if re.search(r"/(?:evidence|testimony|temoignages)(?:/|$)", path):
        return True
    opening = " ".join(parser.heading_text[:3]).casefold()
    return bool(re.search(r"\b(?:evidence|testimony|témoignages|temoignages)\b", opening))


def extract_publication(body: bytes, url: str, language: str) -> list[dict]:
    """Extract clean minutes, notices, reports and responses from publisher content roots.

    Oral testimony pages are deliberately left to the proceedings adapter. Each
    block gets a heading path, source anchor, or deterministic block ordinal.
    """
    if language not in ("en", "fr"):
        raise ValueError("language must be en or fr")
    parser = _document(body, url)
    if _is_testimony(parser, url):
        return []
    return [{"text": block["text"], "location": block["location"], "speaker": None, "affiliation": None}
            for block in parser.blocks]


def _official_url(href: str, base: str) -> str | None:
    candidate = urljoin(base, href.strip())
    parts = urlsplit(candidate)
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme.lower() not in {"https", "http"} or not host or parts.username or parts.password:
        return None
    if not any(host == domain or host.endswith("." + domain) for domain in OFFICIAL_HOSTS):
        return None
    if parts.scheme.lower() == "http":
        candidate = parts._replace(scheme="https").geturl()
    return candidate


def _collections_pdf_target(url: str) -> str | None:
    """Recognize only the official archive wrapper for one collections PDF."""
    gateway = urlsplit(url)
    if (gateway.scheme.lower() != "https" or gateway.hostname != "publications.gc.ca" or
            gateway.path.lower() != "/site/archivee-archived.html" or gateway.username or gateway.password):
        return None
    targets = parse_qs(gateway.query, keep_blank_values=True).get("url", [])
    if len(targets) != 1:
        return None
    target = urlsplit(targets[0])
    if not (target.scheme.lower() == "https" and target.hostname == "publications.gc.ca" and
            not target.username and not target.password and target.path.lower().startswith("/collections/") and
            target.path.lower().endswith(".pdf")):
        return None
    return targets[0]


def _part_kind(link: dict, base: str, context: str) -> tuple[str, str, str] | None:
    href = link["href"].strip()
    url = _official_url(href, base)
    if not url:
        return None
    path = urlsplit(url).path.lower()
    if "/documentviewer/" in path:
        return None
    label = _clean(link.get("text"))
    title_attr = _clean(link.get("title"))
    filename = path.rsplit("/", 1)[-1]
    marker = " ".join((label, title_attr, filename, context))
    lower = marker.casefold()
    descriptor = " ".join((label, title_attr, filename)).casefold()
    collections_target = _collections_pdf_target(url)
    collections_pdf = collections_target is not None
    if collections_target:
        url = collections_target
        path = urlsplit(url).path.lower()
        filename = path.rsplit("/", 1)[-1]
        marker = " ".join((label, title_attr, filename, context))
        lower = marker.casefold()
        descriptor = " ".join((label, title_attr, filename)).casefold()
    substantive = (path.endswith(FILE_EXTENSIONS) or
                   bool(re.search(r"\.(?:pdf|docx?|xlsx?)(?:$|\?)", href, re.I)) or collections_pdf)
    attachment_context = bool(PART_WORDS.search(context))
    report_context = bool(re.search(r"\b(?:report|rapport|response|réponse)\b", context, re.I))
    explicit = (bool(PART_WORDS.search(descriptor)) or
                bool(re.search(r"\b(?:report|rapport|response|réponse)\b", descriptor)) or
                (attachment_context or report_context) and
                bool(re.search(r"\b(?:pdf|download|file|document|pi[eè]ce)\b", descriptor)))
    if re.search(r"\b(?:previous|prior|earlier|précédent|precedent)\b", descriptor):
        return None
    if not substantive or not explicit and not collections_pdf:
        return None
    if re.search(r"\b(?:exhibit|piece|pi[eè]ce)\b", lower):
        kind = "exhibit"
    elif re.search(r"\b(?:appendix|appendices|annex|annexe)\b", lower):
        kind = "appendix"
    elif re.search(r"\b(?:chapter|chapitre)\b", lower):
        kind = "chapter"
    elif re.search(r"\b(?:report|rapport)\b", lower) and path.endswith(".pdf"):
        kind = "report_pdf"
    else:
        kind = "document"
    title = label or title_attr or filename
    if title.lower() in {"pdf", "download", "download pdf", "télécharger", "telecharger"}:
        title = title_attr or filename
    return url, kind, title


def publication_parts(body: bytes, url: str) -> list[dict]:
    """Find official substantive files linked from the publication body only.

    Site navigation, previous/next publication links, study references and the
    page's own surrounding chrome are outside the selected body and ignored.
    """
    parser = _document(body, url)
    if _is_testimony(parser, url):
        return []
    parts: dict[str, dict] = {}
    for block in parser.blocks:
        anchor = block["attrs"].get("id") or block["attrs"].get("name")
        heading = block["text"]
        if anchor and re.search(r"\b(?:recommendations?|observations?|opinion|dissenting opinion|chapter|chapitre|appendix|annex(?:e)?)\b", heading, re.I):
            slug = quote(anchor, safe="")
            target = url.split("#", 1)[0] + "#" + slug
            low = heading.casefold()
            kind = ("recommendations" if re.search(r"recommendations?|recommandations?", low) else
                    "opinion" if "opinion" in low else
                    "chapter" if re.search(r"chapter|chapitre", low) else "appendix")
            parts.setdefault(target, {"url": target, "kind": kind, "title": heading})
        context = " ".join((block.get("heading_path") or "", block["text"]))
        for link in block["links"]:
            candidate = _part_kind(link, url, context)
            if not candidate:
                continue
            part_url, kind, title = candidate
            key = urldefrag(part_url)[0]
            parts.setdefault(key, {"url": part_url, "kind": kind, "title": title})
    return [parts[key] for key in sorted(parts)]
