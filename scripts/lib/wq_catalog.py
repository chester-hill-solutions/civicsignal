#!/usr/bin/env python3
"""Read-only inventory and bilingual backfill of House of Commons written questions.

The scraper follows the House catalogue's rendered pagination and canonical
question detail routes. It uses only Python's standard library and writes each
checkpoint atomically so interrupted runs retain completed records.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from datetime import datetime, timezone

BASE = "https://www.ourcommons.ca"
EN_LIST = BASE + "/written-questions/questions"
FR_LIST = BASE + "/questions-ecrites/questions"
OUT = Path(__file__).resolve().parents[2] / "data/corpus/written-questions/catalogue.json"
UA = "CivicSignal public research inventory (read-only; contact civicsignal.ca)"


class Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []
        self.parent = None
        self.segments = []

    def text(self):
        raw = "".join(segment.text() if isinstance(segment, Node) else segment for segment in self.segments)
        return " ".join(raw.split())

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()

    def find(self, pred):
        return next((n for n in self.walk() if pred(n)), None)

    def findall(self, pred):
        return [n for n in self.walk() if pred(n)]


class TreeParser(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root, self.stack = Node("root"), []
        self.stack.append(self.root)

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs); n.parent = self.stack[-1]; n.parent.children.append(n); n.parent.segments.append(n)
        if tag not in self.VOID: self.stack.append(n)

    def handle_startendtag(self, tag, attrs): self.handle_starttag(tag, attrs); self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]; return

    def handle_data(self, data): self.stack[-1].segments.append(data)


def tree(markup):
    p = TreeParser(); p.feed(markup); return p.root


def cls(node, name): return name in node.attrs.get("class", "").split()


def clean_question_text(value, language=None):
    """Remove the publisher's appended expand/collapse buttons, preserving body text."""
    pattern = r"\s*(?:Show\s+more\s+Show\s+less|Voir\s+plus\s+Voir\s+moins|Afficher\s+plus\s+Afficher\s+moins)\s*$"
    cleaned, removed = re.subn(pattern, "", value or "", count=1, flags=re.I)
    return cleaned.strip(), bool(removed)


def get(url, *, retries=4):
    req = Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"})
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=35) as response:
                if response.status != 200: raise RuntimeError(f"HTTP {response.status}: {url}")
                return response.read().decode("utf-8", "replace")
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            if attempt + 1 == retries: raise RuntimeError(f"GET failed: {url}: {exc}") from exc
            time.sleep(0.5 * (2 ** attempt))


def save_atomic(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2); f.write("\n")
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def load_records(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return {(r.get("language"), r.get("number")): r for r in value.get("records", [])}
    except (OSError, ValueError, AttributeError):
        return {}


def listing_fingerprint(record):
    # Topic tags are list-rendered enrichment and occasionally differ in order or
    # translation from the detail view. Refresh them directly from the listing below.
    keys = ("sourceId", "status", "statusLabel", "askedBy", "dateAsked", "responseDue")
    return tuple(json.dumps(record.get(k), sort_keys=True, ensure_ascii=False) for k in keys)


def response_inventory_ok(record):
    responses = record.get("responses") or []
    keys = [(x.get("type"), x.get("id"), x.get("url")) for x in responses]
    return (record.get("responseInventoryChecked") and len(keys) == len(set(keys))
            and all(x.get("type") and not (x.get("url") or "").startswith("//")
                    and not ("hansard" in (x.get("url") or "").lower() and x.get("type") != "debates")
                    for x in responses))


def reusable_detail(current, previous, force=False):
    """Reuse response metadata only when the current source metadata still matches."""
    if force or not previous or previous.get("fetchError") or listing_fingerprint(previous) != listing_fingerprint(current):
        return None
    reused = dict(previous)
    if not response_inventory_ok(reused):
        if not reused.get("detailFetchedAt") or not reused.get("responses"):
            return None
        reused["responses"] = [{**x, "type": x.get("type") or "viewer", "responseId": x.get("responseId") or x.get("id")} for x in reused["responses"]]
        reused["responseInventoryChecked"] = True
        if not response_inventory_ok(reused): return None
    reused["text"] = current["text"]
    reused["topics"] = current.get("topics", reused.get("topics", []))
    reused["metadata"] = current.get("metadata", reused.get("metadata", {}))
    for response in reused.get("responses", []):
        paper = response.get("sessionalPaperNumber")
        if paper: response["sessionalPaperNumber"] = paper.strip().strip('"')
    return reused


def session_options(markup):
    root = tree(markup)
    out = {}
    for n in root.findall(lambda x: x.tag == "a" and x.attrs.get("data-input", "").lower() == "parlsession"):
        code = n.attrs.get("data-value", "")
        if code in ("", "all"): continue
        out[code] = n.attrs.get("data-label-html") or n.attrs.get("data-label") or n.text()
    return out


def pagination(markup):
    root = tree(markup)
    pages = []
    for n in root.findall(lambda x: x.tag == "a" and x.attrs.get("data-page", "").isdigit()):
        pages.append(int(n.attrs["data-page"]))
    return max(pages, default=1)


def listing_records(markup, language):
    root = tree(markup)
    out = []
    for box in root.findall(lambda x: x.tag == "div" and "question-search-result-container" in x.attrs.get("class", "").split()):
        source_id = re.search(r"question-search-result-(\d+)", box.attrs.get("id", ""))
        href = box.find(lambda x: x.tag == "a" and re.search(r"/q-(\d+)(?:$|[?#])", x.attrs.get("href", "")))
        if not source_id or not href: continue
        number = int(re.search(r"/q-(\d+)", href.attrs["href"]).group(1))
        link = BASE + href.attrs["href"] if href.attrs["href"].startswith("/") else href.attrs["href"]
        person = box.find(lambda x: x.tag == "a" and "/Members/" in x.attrs.get("href", ""))
        date_box = box.find(lambda x: x.attrs.get("id") == "attribute-date-asked")
        date = box.find(lambda x: cls(x, "label") and x.text().lower() in ("date asked", "date de la question"))
        asked = (date_box.find(lambda x: cls(x, "value")) if date_box else
                 date.parent.find(lambda x: cls(x, "value")) if date and date.parent else None)
        st = box.find(lambda x: cls(x, "status"))
        status_label_node = st.find(lambda x: cls(x, "label")) if st else None
        status_label = status_label_node.text() if status_label_node else None
        class_names = (st.attrs.get("class", "") + " " + (st.parent.attrs.get("class", "") if st and st.parent else "")).lower() if st else ""
        label_lower = (status_label or "").lower()
        if "awaitingresponse" in class_names or "awaiting" in label_lower or "en attente" in label_lower:
            status = "awaiting_response"
        elif any(x in class_names for x in ("answered", "responded")) or any(x in label_lower for x in ("answered", "responded", "répondu", "répondue", "réponse obtenue")):
            status = "answered"
        elif any(x in class_names for x in ("withdrawn", "retired")) or any(x in label_lower for x in ("withdrawn", "retiré", "retirée")):
            status = "withdrawn"
        else:
            status = "unknown"
        due = st.find(lambda x: cls(x, "value")) if st and status == "awaiting_response" else None
        tx = box.find(lambda x: cls(x, "question-text"))
        topics = [x.text() for x in box.findall(lambda x: x.tag == "a" and cls(x, "topic"))]
        purl = person.attrs.get("href") if person else None
        if purl and purl.startswith("//"): purl = "https:" + purl
        person_id = re.search(r"\((\d+)\)", purl or "")
        number_href = href.attrs.get("href", "")
        question_text, removed_controls = clean_question_text(tx.text() if tx else "", language)
        out.append({"number": number, "language": language, "url": link, "sourceId": int(source_id.group(1)),
                    "text": question_text, "status": status,
                    "askedBy": {"name": person.text() if person else None, "url": purl,
                                "personId": int(person_id.group(1)) if person_id else None},
                    "dateAsked": asked.text() if asked else None,
                    "responseDue": due.text() if due else None, "statusLabel": status_label, "topics": topics,
                    "responses": [], "metadata": {"listingPath": number_href, "uiLabelsRemoved": removed_controls}})
    return out


def detail(record):
    root = tree(get(record["url"]))
    profile = root.find(lambda n: n.attrs.get("id") == "written-question-profile")
    if not profile:
        record["fetchError"] = "question profile missing"; return record
    record["sourceId"] = int(profile.attrs.get("data-written-question-id", record["sourceId"]))
    tx = profile.find(lambda n: cls(n, "question-text"))
    question_text, removed_controls = clean_question_text(tx.text() if tx else record["text"], record.get("language"))
    record["text"] = question_text
    record.setdefault("metadata", {})["uiLabelsRemoved"] = removed_controls
    person = profile.find(lambda n: n.tag == "a" and "/Members/" in n.attrs.get("href", ""))
    if person:
        pu = person.attrs.get("href"); pu = "https:" + pu if pu.startswith("//") else pu
        pid = re.search(r"\((\d+)\)", pu)
        record["askedBy"] = {"name": person.text(), "url": pu, "personId": int(pid.group(1)) if pid else None}
    date_box = profile.find(lambda n: n.attrs.get("id") == "attribute-date-asked")
    if date_box:
        val = date_box.find(lambda n: cls(n, "value")); record["dateAsked"] = val.text() if val else record.get("dateAsked")
    status_box = profile.find(lambda n: n.attrs.get("id") == "attribute-status")
    if status_box:
        label = status_box.find(lambda n: cls(n, "label")); val = status_box.find(lambda n: cls(n, "value"))
        label_text = label.text().lower() if label else ""
        root_classes = " ".join(n.attrs.get("class", "") for n in profile.walk()).lower()
        if "awaitingresponse" in root_classes or "awaiting" in label_text or "en attente" in label_text:
            record["status"] = "awaiting_response"
        elif any(x in label_text for x in ("withdrawn", "retiré", "retirée")) or any(x in root_classes for x in ("withdrawn", "retired")):
            record["status"] = "withdrawn"
        elif any(x in label_text for x in ("answered", "responded", "répondu", "répondue", "réponse obtenue")) or "answered" in root_classes or "responded" in root_classes:
            record["status"] = "answered"
        else:
            record["status"] = "unknown"
        record["statusLabel"] = label.text() if label else None
        record["responseDue"] = val.text() if val and record["status"] == "awaiting_response" else None
    record["topics"] = [n.text() for n in profile.findall(lambda n: n.tag == "a" and cls(n, "topic"))]
    response_meta = profile.find(lambda n: n.attrs.get("id") == "attribute-response")
    institution = None
    if response_meta:
        value = response_meta.find(lambda n: cls(n, "value"))
        institution = value.text() if value else None
    responses = []
    tabs = root.findall(lambda n: n.tag == "button" and n.attrs.get("data-government-response-id"))
    for tab in tabs:
        rid = tab.attrs["data-government-response-id"]
        paper = html.unescape(tab.attrs.get("data-sessional-paper-number", "")).strip().strip('"')
        date = tab.find(lambda n: cls(n, "response-date"))
        responses.append({"id": rid, "type": "viewer", "responseId": rid,
                          "url": f"{record['url']}?response={rid}",
                          "date": date.text() if date else None,
                          "sessionalPaperNumber": paper or None,
                          "institution": institution if len(tabs) == 1 else None})
    response_section = root.find(lambda n: n.attrs.get("id") == "written-question-responses")
    if response_section:
        for link in response_section.findall(lambda n: n.tag == "a" and cls(n, "response")):
            paper_id = link.attrs.get("data-sessional-paper-id")
            event_id = link.attrs.get("data-event-id")
            if not (paper_id or event_id or link.attrs.get("href")): continue
            paper_node = link.find(lambda n: cls(n, "sessional-paper-number"))
            paper_number = paper_node.text().strip() if paper_node else None
            date_text = None
            for child in link.findall(lambda n: n.tag == "div"):
                value = child.text().strip()
                if re.search(r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\b.*\b\d{4}\b", value, re.I) or re.search(r"\d{1,2}\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+\d{4}", value, re.I):
                    date_text = value; break
            href = link.attrs.get("href", "")
            kind = "debates" if any(x in href.lower() for x in ("hansard", "debates", "debats")) else "sessional_paper"
            stable_id = paper_id or event_id
            responses.append({"id": stable_id, "type": kind,
                              "sessionalPaperId": paper_id, "eventId": event_id,
                              "sessionalPaperNumber": paper_number, "url": href or None,
                              "date": date_text, "institution": institution})
    # Deduplicate response anchors that can be repeated in the rendered shell.
    unique_responses, seen = [], set()
    for response in responses:
        if response.get("url", "").startswith("//"):
            response["url"] = "https:" + response["url"]
        key = (response.get("type"), response.get("id"), response.get("url"))
        if key not in seen: seen.add(key); unique_responses.append(response)
    record["responses"] = unique_responses
    record["respondingInstitution"] = institution
    record["responseInventoryChecked"] = True
    return record


def fetch_listing_page(base, params):
    url = base + ("?" + urlencode(params) if params else "")
    return get(url)


def scrape(output=OUT, max_pages=None, workers=4, checkpoint=40, recheck_details=False):
    first_en, first_fr = get(EN_LIST), get(FR_LIST)
    en_sessions, fr_sessions = session_options(first_en), session_options(first_fr)

    def reported_count(markup):
        bar = tree(markup).find(lambda n: cls(n, "search-results-bar"))
        m = re.search(r"(?:Results\s+\d+\s*[-–]\s*\d+\s+of|Résultats\s+\d+\s*[-–]\s*\d+\s+de)\s+(\d[\d,\s]*)", bar.text(), re.I) if bar else None
        return int(re.sub(r"\D", "", m.group(1))) if m else None

    sessions = []
    for code, en_label in en_sessions.items():
        first = first_en if code == "45-1" else fetch_listing_page(EN_LIST, {"parlsession": code})
        count = reported_count(first)
        sessions.append({"id": code, "label": html.unescape(re.sub("<[^>]+>", "", en_label)),
                         "labelEnHtml": en_label, "labelFrHtml": fr_sessions.get(code),
                         "questionCount": count, "pages": pagination(first),
                         "sourceUrl": EN_LIST + "?" + urlencode({"parlsession": code})})
    current = next((s for s in sessions if s["id"] == "45-1"), {})
    current_total = current.get("questionCount")
    overview = tree(get(BASE + "/written-questions/overview"))
    overview_counts = {}
    for anchor in overview.findall(lambda n: n.tag == "a" and cls(n, "overview-tile-anchor")):
        number = anchor.find(lambda n: cls(n, "number-value"))
        label = anchor.find(lambda n: cls(n, "bottom-section"))
        if number and label:
            overview_counts[label.text()] = int(number.text().replace(",", ""))
    if current_total is None:
        current_total = overview_counts.get("Questions submitted this session")
        current["questionCount"] = current_total
    page_count = current.get("pages") or pagination(first_en)
    pages_to_fetch = min(page_count, max_pages or page_count)
    partial_output = output.with_name(output.stem + ".partial" + output.suffix)
    complete_records, partial_records = load_records(output), load_records(partial_output)
    complete_time = output.stat().st_mtime_ns if output.exists() else -1
    partial_time = partial_output.stat().st_mtime_ns if partial_output.exists() else -1
    previous = dict(complete_records)
    # Merge a newer partial over the last complete snapshot, retaining any complete
    # detail records not yet copied into the partial checkpoint.
    if partial_time > complete_time:
        for key, partial_record in partial_records.items():
            old = complete_records.get(key)
            if old and not partial_record.get("detailFetchedAt"):
                merged = {**old, **partial_record}
                for field in ("responses", "respondingInstitution", "responseInventoryChecked", "detailFetchedAt"):
                    if field in old: merged[field] = old[field]
                previous[key] = merged
            else:
                previous[key] = partial_record
    en_records, fr_records = listing_records(first_en, "en"), listing_records(first_fr, "fr")
    initial = {"observedAt": datetime.now(timezone.utc).isoformat(), "source": EN_LIST,
               "method": {"type": "official-rendered-pages", "englishList": EN_LIST,
                          "frenchList": FR_LIST, "paginationParameter": "page",
                          "pageSize": 20, "detailRoutes": {"en": BASE + "/written-questions/45-1/q-{number}",
                                                               "fr": BASE + "/questions-ecrites/45-1/q-{number}"}},
               "overview": {"url": BASE + "/written-questions/overview", "counts": overview_counts},
               "sessions": sessions, "records": en_records + fr_records,
               "totals": {"officialReported": current_total, "pages": page_count, "pageSize": 20,
                          "enumeratedEn": len(en_records), "enumeratedFr": len(fr_records), "complete": False},
               "paginationCheck": {"page1ReportedLastPageEn": pagination(first_en),
                                   "page1ReportedLastPageFr": pagination(first_fr),
                                   "visitedPagesEn": [1], "visitedPagesFr": [1]}}
    save_atomic(partial_output, initial)
    print(f"checkpoint: {len(en_records)} EN + {len(fr_records)} FR records available at {partial_output}", flush=True)

    page_jobs = [(lang, i, base + "?" + urlencode({"page": i}))
                 for lang, base in (("en", EN_LIST), ("fr", FR_LIST))
                 for i in range(2, pages_to_fetch + 1)]
    def fetch_page(job):
        lang, page, url = job
        return lang, page, get(url)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, 6))) as pool:
        for lang, page, markup in pool.map(fetch_page, page_jobs):
            if lang == "en":
                en_records.extend(listing_records(markup, lang)); initial["paginationCheck"]["visitedPagesEn"].append(page)
            else:
                fr_records.extend(listing_records(markup, lang)); initial["paginationCheck"]["visitedPagesFr"].append(page)
            if len(initial["paginationCheck"]["visitedPagesEn"]) % checkpoint == 0 or page == pages_to_fetch:
                initial["records"] = en_records + fr_records
                initial["totals"].update({"enumeratedEn": len(en_records), "enumeratedFr": len(fr_records)})
                initial["observedAt"] = datetime.now(timezone.utc).isoformat(); save_atomic(partial_output, initial)

    def index(records):
        out, duplicates = {}, []
        for r in records:
            if r["number"] in out: duplicates.append(r["number"])
            out[r["number"]] = r
        return out, sorted(set(duplicates))
    en_by, dup_en = index(en_records); fr_by, dup_fr = index(fr_records)
    en_ids, fr_ids = set(en_by), set(fr_by)
    total_en, total_fr = reported_count(get(EN_LIST + "?" + urlencode({"page": page_count}))), reported_count(get(FR_LIST + "?" + urlencode({"page": page_count})))
    initial["paginationCheck"].update({"enListingReportedTotal": current_total,
        "frListingReportedTotal": reported_count(first_fr), "enLastPageReportedTotal": total_en,
        "frLastPageReportedTotal": total_fr, "missingFromEn": sorted(fr_ids - en_ids),
        "missingFromFr": sorted(en_ids - fr_ids), "duplicateNumbersEn": dup_en,
        "duplicateNumbersFr": dup_fr, "expectedFinalPageItemsEn": (current_total - (page_count - 1) * 20) if current_total else None,
        "expectedFinalPageItemsFr": (current_total - (page_count - 1) * 20) if current_total else None})

    refetched = 0
    for number, r in list(en_by.items()):
        previous_detail = reusable_detail(r, previous.get(("en", number)), recheck_details)
        if previous_detail: en_by[number] = previous_detail
    for number, r in list(fr_by.items()):
        previous_detail = reusable_detail(r, previous.get(("fr", number)), recheck_details)
        if previous_detail: fr_by[number] = previous_detail
    detail_jobs = [r for number, r in en_by.items() if recheck_details or not r.get("responseInventoryChecked")] + [r for number, r in fr_by.items() if recheck_details or not r.get("responseInventoryChecked")]
    finished = sum(1 for r in list(en_by.values()) + list(fr_by.values()) if r.get("detailFetchedAt"))
    def process(r):
        try:
            r = detail(r); r["detailFetchedAt"] = datetime.now(timezone.utc).isoformat(); return r
        except Exception as exc: r["fetchError"] = str(exc); return r
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, 6))) as pool:
        for result in pool.map(process, detail_jobs):
            (en_by if result["language"] == "en" else fr_by)[result["number"]] = result
            finished += 1; refetched += 1
            if finished % checkpoint == 0:
                initial["records"] = list(en_by.values()) + list(fr_by.values())
                initial["totals"].update({"enumeratedEn": len(en_by), "enumeratedFr": len(fr_by), "detailsFetched": finished})
                initial["observedAt"] = datetime.now(timezone.utc).isoformat(); save_atomic(partial_output, initial)
    initial["records"] = list(en_by.values()) + list(fr_by.values())
    initial["totals"].update({"enumeratedEn": len(en_by), "enumeratedFr": len(fr_by), "detailsFetched": finished,
        "complete": pages_to_fetch == page_count and current_total == len(en_by) == len(fr_by)
                    and en_ids == fr_ids and not dup_en and not dup_fr
                    and not any("fetchError" in r or not r.get("detailFetchedAt") for r in list(en_by.values()) + list(fr_by.values()))})
    initial["totals"]["detailsReused"] = len(en_by) + len(fr_by) - refetched
    initial["totals"]["detailsRefetched"] = refetched
    initial["paginationCheck"].update({"enumeratedEn": len(en_by), "enumeratedFr": len(fr_by),
                                      "visitedPageCountEn": len(initial["paginationCheck"]["visitedPagesEn"]),
                                      "visitedPageCountFr": len(initial["paginationCheck"]["visitedPagesFr"])})
    initial["observedAt"] = datetime.now(timezone.utc).isoformat()
    if initial["totals"]["complete"]:
        save_atomic(output, initial)
        try: partial_output.unlink()
        except FileNotFoundError: pass
    else:
        save_atomic(partial_output, initial)
    print(json.dumps(initial["totals"], ensure_ascii=False), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, default=OUT)
    ap.add_argument("--max-pages", type=int)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--checkpoint", type=int, default=40)
    ap.add_argument("--recheck-details", action="store_true", help="re-fetch every EN and FR detail shell despite unchanged listing metadata")
    a = ap.parse_args(); scrape(a.output, a.max_pages, a.workers, a.checkpoint, a.recheck_details)

if __name__ == "__main__": main()
