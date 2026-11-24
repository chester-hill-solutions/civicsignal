"""Map publisher index occurrences to edition-scoped records and cited relationships."""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from urllib.parse import parse_qs, unquote, urlsplit

SUBMISSIONS = {"submission", "brief", "exhibit", "correspondence", "attachment"}
STRUCTURAL = {"committee", "meeting", "study", "index-gap"}
DOCUMENT_KINDS = {
    "notice",
    "minutes",
    "evidence",
    "report",
    "government-response",
    "order-of-reference",
    "publication",
    "opinion",
    "recommendation",
} | SUBMISSIONS


def short_hash(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def study_key(value):
    normalized = str(value).lower()
    return (
        normalized
        if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,45}", normalized)
        else short_hash(str(value))
    )


def classify(item):
    url = item["url"].lower()
    kind = item["kind"]
    label = (item.get("title") or "").casefold()
    if re.search(r"/content/sen/committee/451/nffn/nffn-(?:me|s[abc])-\d+-[ef]$", url):
        return "study"
    if label in {
        "interim transcript",
        "transcription provisoire",
        "transcripts",
        "témoignages",
    }:
        return "evidence"
    if label in {"minutes", "procès-verbal"}:
        return "minutes"
    if kind == "submission":
        name = unquote(urlsplit(url).path.rsplit("/", 1)[-1])
        if re.search(r"/brief/br[0-9]+/", url) or re.search(
            r"[_-](?:brief|mémoire|memoire)[_-]", name
        ):
            return "brief"
        if re.search(r"[_-](?:letter|lettre|correspondence|correspondance)[_-]", name):
            return "correspondence"
        if re.search(r"[_-](?:exhibit|pièce|piece)[_-]", name):
            return "exhibit"
    if kind in SUBMISSIONS or kind == "study":
        return kind
    if re.search(
        r"(reponse|response)-8512-|government-response|reponse-du-gouvernement", url
    ):
        return "government-response"
    if re.search(r"/(?:report|rapport)(?:-|/)\d+", url):
        return "report"
    if re.search(r"/evidence|/temoignages|/\d+ev-\d+", url):
        return "evidence"
    if re.search(r"/minutes|/proces-verbal|/\d+mn-\d+", url):
        return "minutes"
    if re.search(
        r"/notice(?:ofmeeting)?[/-]|/notice$|/avis(?:deconvocation|-convocation)", url
    ):
        return "notice"
    if "orderofreferenceid=" in url:
        return "study"
    if kind in DOCUMENT_KINDS | {"meeting"}:
        return kind
    if "/content/sen/committee/" in url and kind == "studies":
        return "order-of-reference"
    return "publication"


def publisher_key(kind, url, item):
    """Prefer the publication identifier. Keep distinct files independent of translation guesses."""
    path = urlsplit(url).path.lower().rstrip("/")
    query = {k.lower(): v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    if kind in {"study", "order-of-reference"} and "/content/sen/committee/" in path:
        if order := re.search(
            r"/([a-z]+-(?:sm-)?(?:c|s|ss|me|s[abc])-\d+)-[ef]$", path
        ):
            return order[1]
    if kind == "study":
        source_id = item.get("studyId") or query.get("studyactivityid")
        if not source_id:
            match = re.search(r"orderofreferenceid=(\d+)", url, re.I)
            source_id = match[1] if match else None
        if source_id:
            return study_key(source_id)
    match = re.search(r"/(?:meeting|reunion)-(\d+)", path)
    if match and kind in {"meeting", "minutes", "evidence", "notice"}:
        return match[1]
    if kind in {"notice", "meeting"}:
        match = re.search(r"/(?:noticeofmeeting|avisdeconvocation)/(\d+)", path)
        if match:
            return match[1]
    if kind in {"report", "government-response"}:
        match = (
            re.search(r"/(?:response|reponse)-([\d-]+)", path)
            if kind == "government-response"
            else re.search(r"/(?:report|rapport)[/-](\d+)", path)
        )
        if match:
            return match[1]
    match = re.search(r"/(\d+(?:ev|mn)-\d+[a-z]*)-[ef]$", path)
    if not match and kind == "evidence":
        match = re.search(r"/(\d+)-[ef]$", path)
    if match:
        return match[1]
    return short_hash(url)


def resource_id(committee, kind, url, item):
    if kind in SUBMISSIONS:
        kind = "submission"
    return f"{committee}-{kind}-{publisher_key(kind, url, item)}"


class Inventory:
    def __init__(self, catalogue):
        self.session = catalogue["session"]
        self.cutoff = catalogue["observedAt"]
        self.source_observations = catalogue.get("sourceObservations", {})
        self.records = {}
        self.links = set()
        self.wanted = {}
        self.directory = {}
        self.by_url = defaultdict(set)
        self.deferred = []
        self.index_gaps = []
        for c in catalogue["committees"]:
            lang = c["language"]
            joint = (
                c.get("jointPublicationDirectory")
                or urlsplit(c["url"]).hostname == "www.parl.ca"
            )
            chamber = "joint" if joint else c["chamber"]
            cid = f"{chamber}-{c['code'].lower()}"
            self.directory[c["chamber"], lang, c["code"].upper()] = cid
            official = c.get("jointPublicationDirectory", c["url"])
            row = self.put(cid, lang, "committee", cid, c["name"], official)
            observed = (
                self.source_observations.get(c["chamber"], {}).get("observedAt")
                or self.cutoff
            )
            row["metadata"].setdefault("directoryCutoffs", {})[c["chamber"]] = observed
            directories = row["metadata"].setdefault("directories", [])
            if c["directory"] not in directories:
                directories.append(c["directory"])
            if c.get("parentCode"):
                self.deferred.append(
                    (
                        lang,
                        cid,
                        f"{chamber}-{c['parentCode'].lower()}",
                        "subcommittee-of",
                    )
                )
        for key, page in catalogue["indexes"].items():
            self.page(key, page)
        # A Senate brief can cite an order absent from the Studies and Bills index.
        for key, page in catalogue["indexes"].items():
            if not key.startswith("senate/") or not key.endswith("/briefs"):
                continue
            lang, cid = self.context(key, page)
            for item in page.get("links", []):
                url = item.get("studyUrl")
                if not url or not item.get("study"):
                    continue
                if any(
                    self.records[lang, rid]["kind"] == "study"
                    for rid in self.by_url.get((lang, url), ())
                ):
                    continue
                self.page(
                    key,
                    {
                        "url": page["url"],
                        "links": [
                            {
                                "kind": "study",
                                "url": url,
                                "title": item["study"],
                                "studyId": item.get("studyId"),
                                "orderOfReferenceId": item.get("orderOfReferenceId"),
                            }
                        ],
                    },
                )
        for key, page in catalogue["indexes"].items():
            coverage = page.get("coverage")
            if not coverage:
                continue
            lang, cid = self.context(key, page)
            if key.startswith("senate/") and "/notice/" in key:
                mid = resource_id(cid, "meeting", page["url"], {})
                if meeting := self.records.get((lang, mid)):
                    meeting["metadata"]["noticeCoverage"] = coverage
            elif key.startswith("https://") and "studyactivityid=" in key.lower():
                sid = resource_id(cid, "study", key, {})
                if study := self.records.get((lang, sid)):
                    study["metadata"]["submissionIndex"] = coverage
                    if coverage.get("studyTitle"):
                        study["title"] = coverage["studyTitle"]
        for lang, child, parent, relation in self.deferred:
            parents = (
                self.by_url.get((lang, parent), ())
                if parent.startswith("http")
                else [parent]
            )
            for pid in parents:
                expected = {
                    "study-publication": "study",
                    "study-meeting": "study",
                    "meeting-publication": "meeting",
                    "government-response": "report",
                    "subcommittee-of": "committee",
                }.get(relation)
                parent_row = self.records.get((lang, pid))
                if (
                    parent_row
                    and (not expected or parent_row["kind"] == expected)
                    and pid != child
                ):
                    self.links.add((lang, pid, child, relation))

    def put(self, id, lang, kind, cid, title, url):
        row = self.records.setdefault(
            (lang, id),
            dict(
                session=self.session,
                id=id,
                language=lang,
                kind=kind,
                chamber=cid.split("-")[0],
                committee_id=cid,
                title=title or kind,
                url=url,
                status="indexed",
                metadata={},
                object_sha256=None,
            ),
        )
        self.by_url[(lang, url)].add(id)
        return row

    def add_publication_parts(self, parts):
        if parts["session"] != self.session or parts["cutoff"] != self.cutoff:
            raise ValueError(
                "Refresh linked publication parts for the selected catalogue snapshot"
            )
        for entry in parts.get("studySources", []):
            lang = entry["language"]
            study = self.records[lang, entry["studyId"]]
            study["object_sha256"] = entry["sourceHash"]
            study["metadata"].update(
                billUrls=entry["billUrls"], reportEvents=entry["reportEvents"]
            )
            self.page(
                entry["url"], {"links": entry["publications"], "url": entry["url"]}
            )
            for item in entry["publications"]:
                child = resource_id(
                    study["committee_id"], classify(item), item["url"], item
                )
                self.links.add((lang, study["id"], child, "study-publication"))
                if n := re.search(r"/(?:meeting|reunion)-(\d+)/", item["url"], re.I):
                    mid = study["committee_id"] + "-meeting-" + n[1]
                    if (lang, mid) in self.records:
                        self.links.add((lang, study["id"], mid, "study-meeting"))
        for entry in parts["parents"]:
            lang = entry["language"]
            parent = self.records[lang, entry["parentId"]]
            for part in entry["children"]:
                url = part["url"]
                kind = (part.get("kind") or "report-part").replace("_", "-")
                if url.startswith(part["sourcePage"] + "#"):
                    parent["metadata"].setdefault("sections", []).append(part)
                    continue
                # Keep published report relationships even when two committees link the same file.
                rid = parent["committee_id"] + "-part-" + short_hash(url)
                row = self.put(
                    rid, lang, kind, parent["committee_id"], part.get("title"), url
                )
                row["metadata"].update(
                    sourcePage=part["sourcePage"],
                    termsUrl=parent["metadata"]["termsUrl"],
                    delivery="metadata-only"
                    if kind in SUBMISSIONS
                    else parent["metadata"]["delivery"],
                )
                self.links.add((lang, parent["id"], rid, "has-part"))
                self.wanted[lang, rid] = url

        meeting_parents = defaultdict(set)
        for lang, parent, child, relation in self.links:
            if self.records.get((lang, parent), {}).get("kind") == "meeting":
                meeting_parents[lang, child].add(parent)
        for entry in parts.get("publicationFacts", []):
            lang, rid = entry["language"], entry["id"]
            doc = self.records[lang, rid]
            doc["metadata"]["publishedDetails"] = entry["facts"]
            if doc["kind"] in {"notice", "minutes"}:
                for mid in meeting_parents[lang, rid]:
                    meeting = self.records[lang, mid]
                    meeting["metadata"].setdefault("publications", []).append(
                        {
                            "id": rid,
                            "kind": doc["kind"],
                            "url": entry["url"],
                            "details": entry["facts"],
                        }
                    )

    def context(self, key, page):
        parts = key.split("/")
        if parts[0] in ("house", "senate") and len(parts) >= 4:
            return parts[1], self.directory.get((parts[0], parts[1], parts[2].upper()))
        if key.startswith("https://"):
            m = re.search(r"/(?:committees|comites)/(en|fr)/([^/?#]+)", key, re.I)
            if m:
                return m[1].lower(), self.directory.get(
                    ("house", m[1].lower(), m[2].upper())
                )
        return None, None

    def page(self, key, page):
        lang, cid = self.context(key, page)
        if not cid:
            raise ValueError("Unmapped index: " + key)
        if page.get("error"):
            url = page.get("url") or (
                key if key.startswith("https:") else self.records[lang, cid]["url"]
            )
            gap = self.put(
                cid + "-gap-" + short_hash(key),
                lang,
                "index-gap",
                cid,
                "Publication index",
                url,
            )
            gap.update(
                status="unavailable", metadata={"reason": page["error"], "index": key}
            )
            self.links.add((lang, cid, gap["id"], "index-gap"))
            self.index_gaps.append(key)
        for item in page.get("links", []):
            url = item["url"]
            kind = classify(item)
            rid = resource_id(cid, kind, url, item)
            row = self.put(rid, lang, kind, cid, item.get("title"), url)
            if kind == "study" and (
                name := item.get("studyTitle") or item.get("study")
            ):
                row["title"] = name
            self.links.add((lang, cid, rid, "publishes"))
            if kind == "study" and "/content/sen/committee/" in url.lower():
                order = resource_id(cid, "order-of-reference", url, item)
                document = self.put(
                    order, lang, "order-of-reference", cid, item.get("title"), url
                )
                document["metadata"].update(
                    termsUrl="https://sencanada.ca/en/intellectual-property/",
                    delivery="excerpt",
                )
                self.links.add((lang, rid, order, "study-publication"))
                self.wanted[lang, order] = url
            # The meeting number in a House DocumentViewer URL is scoped to its committee/session.
            match = re.search(r"/((?:meeting|reunion)-(\d+))/", url, re.I)
            meeting_url = item.get("meetingUrl")
            if kind in {"notice", "minutes", "evidence"} and (
                match or meeting_url or kind == "notice"
            ):
                parent_url = meeting_url or url
                mid = resource_id(cid, "meeting", parent_url, {})
                if match:
                    mid = f"{cid}-meeting-{match[2]}"
                meeting = self.put(
                    mid,
                    lang,
                    "meeting",
                    cid,
                    item.get("meetingTitle")
                    or item.get("meetingDate")
                    or ("Meeting " + match[2] if match else item.get("title")),
                    parent_url,
                )
                if item.get("meetingDate"):
                    meeting["metadata"]["date"] = item["meetingDate"]
                self.links.update(
                    [(lang, cid, mid, "holds"), (lang, mid, rid, "publication")]
                )
            meta = row["metadata"]
            if (item.get("title") or "").casefold() in {
                "interim transcript",
                "transcription provisoire",
            }:
                meta["publicationStatus"] = "interim"
            if kind in SUBMISSIONS and row["title"].lower() in {
                "pdf",
                "word docx",
                "word",
                "excel",
            }:
                meta["publisherLinkLabel"] = row["title"]
                row["title"] = unquote(urlsplit(url).path.rsplit("/", 1)[-1])
            if (
                item.get("study")
                and not item.get("studyUrl")
                and not item.get("studyUrls")
            ):
                # The Senate groups published materials by order-of-reference heading.
                # Preserve that explicit membership even when the table omits a detail link.
                name = item["study"]
                sid = f"{cid}-study-{study_key(item['studyId']) if item.get('studyId') else short_hash(name)}"
                source = (
                    item.get("sourceIndexUrl") or page.get("sourceUrl") or page["url"]
                )
                self.put(sid, lang, "study", cid, name, source)
                self.links.update(
                    [(lang, cid, sid, "studies"), (lang, sid, rid, "study-publication")]
                )
            for name in (
                "submitter",
                "organization",
                "study",
                "received",
                "fileLanguage",
                "published",
                "date",
                "meetingDate",
                "publicationStatus",
                "affiliation",
                "billUrl",
                "studyTitle",
                "studyId",
                "orderOfReferenceId",
                "orderOfReferenceCode",
                "reportId",
                "meetingNumber",
                "playerUrl",
                "reportDate",
                "responseDate",
            ):
                if item.get(name) is not None:
                    meta.setdefault(name, item[name])
            if item.get("submitter") or item.get("organization"):
                credit = {
                    k: item[k] for k in ("submitter", "organization") if item.get(k)
                }
                credits = meta.setdefault("credits", [])
                if credit not in credits:
                    credits.append(credit)
                authors = meta.setdefault("authors", [])
                for value in credit.values():
                    if (
                        value.casefold()
                        not in {"organization only", "organisation seulement"}
                        and value not in authors
                    ):
                        authors.append(value)
            terms = (
                "https://sencanada.ca/en/intellectual-property/"
                if cid.startswith("senate-")
                else "https://apps.ourcommons.ca/en/important-notices"
            )
            meta["delivery"] = (
                "excerpt"
                if kind
                in {"notice", "minutes", "evidence", "report", "order-of-reference"}
                else "metadata-only"
            )
            meta["termsUrl"] = terms
            for name, relation in [
                ("studyUrl", "study-publication"),
                ("reportUrl", "government-response"),
                ("meetingUrl", "meeting-publication"),
            ]:
                context = item.get(name)
                parents = [context] if isinstance(context, str) else list(context or [])
                parents += item.get(name + "s", []) or []
                for parent in parents:
                    self.deferred.append((lang, rid, parent, relation))
                    if (
                        name == "studyUrl"
                        and (match or meeting_url)
                        and kind in {"notice", "minutes", "evidence"}
                    ):
                        self.deferred.append((lang, mid, parent, "study-meeting"))
            if kind == "government-response":
                parent_url = url.rsplit("/", 1)[0] + "/"
                self.deferred.append(
                    (
                        lang,
                        rid,
                        resource_id(cid, "report", parent_url, {}),
                        "government-response",
                    )
                )
            if kind not in STRUCTURAL:
                if url != row["url"]:
                    aliases = meta.setdefault("alternateUrls", [])
                    if url not in aliases:
                        aliases.append(url)
                self.wanted[lang, rid] = row["url"]
