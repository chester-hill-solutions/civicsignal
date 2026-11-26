"""Parse the House current-consultation list and the submission instructions it links.

The House publishes one page of committee studies that are seeking briefs, and each
study page carries a participation button with an optional deadline and a block of
submission instructions. The Senate publishes no equivalent listing; the intake
records that as a source gap rather than inventing calls.

Every fact here is the publisher's. A deadline is stored verbatim and is turned into
an instant only when the phrase states a zone, a date and a weekday that agree.
"""

from __future__ import annotations

import hashlib
import html as html_module
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

PARTICIPATE_INDEX = {
    "en": "https://www.ourcommons.ca/Committees/en/Participate",
    "fr": "https://www.ourcommons.ca/Committees/fr/Participate",
}
# The Senate publishes committee briefs but, at these pages, no listing of studies
# that are currently inviting them.
SENATE_CHECKS = {
    "en": [
        "https://sencanada.ca/en/committees/",
        "https://sencanada.ca/en/committees/aefa/",
        "https://sencanada.ca/en/committees/aefa/briefs/45-1",
        "https://sencanada.ca/en/committees/aefa/studiesandbills/45-1",
    ],
    "fr": [
        "https://sencanada.ca/fr/comites/",
        "https://sencanada.ca/fr/comites/aefa/",
        "https://sencanada.ca/fr/comites/aefa/memoires/45-1",
        "https://sencanada.ca/fr/comites/aefa/etudesetprojetsdeloi/45-1",
    ],
}
CALL_MARKERS = ("call for submissions", "call for briefs", "appel de mémoires")

HOUSE_TERMS = "https://apps.ourcommons.ca/en/important-notices"

MONTHS = {
    "en": {
        name: number
        for number, name in enumerate(
            [
                "january",
                "february",
                "march",
                "april",
                "may",
                "june",
                "july",
                "august",
                "september",
                "october",
                "november",
                "december",
            ],
            1,
        )
    },
    "fr": {
        "janvier": 1,
        "février": 2,
        "fevrier": 2,
        "mars": 3,
        "avril": 4,
        "mai": 5,
        "juin": 6,
        "juillet": 7,
        "août": 8,
        "aout": 8,
        "septembre": 9,
        "octobre": 10,
        "novembre": 11,
        "décembre": 12,
        "decembre": 12,
    },
}
WEEKDAYS = {
    "en": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    "fr": ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
}
# Eastern Time as the publisher labels it. A bare ET/HE follows Toronto's rules.
FIXED_ZONES = {"EST": -5, "HNE": -5, "EDT": -4, "HAE": -4}
CITY_ZONES = {"ET", "HE"}

EN_DEADLINE = re.compile(
    r"(?P<hour>\d{1,2}):(?P<minute>\d{2})\s*(?P<meridiem>[ap])\.?\s*m\.?\s*"
    r"\((?P<zone>[A-Z]{2,4})\)\s+on\s+(?P<weekday>[A-Za-z]+),\s+"
    r"(?P<month>[A-Za-z]+)\s+(?P<day>\d{1,2}),\s+(?P<year>\d{4})"
)
FR_DEADLINE = re.compile(
    r"(?P<hour>\d{1,2})\s*h\s*(?P<minute>\d{2})\s*"
    r"\((?P<zone>[A-ZÉÈÀ]{2,4})\)\s+le\s+(?P<weekday>[a-zéèêàû]+)\s+"
    r"(?P<day>\d{1,2})\s+(?P<month>[a-zéèêàû]+)\s+(?P<year>\d{4})",
    re.IGNORECASE,
)
PARTICIPATE_LINK = re.compile(
    r'<a[^>]+href="(?P<href>/committees/(?P<language>en|fr)/(?P<committee>[A-Z0-9]+)'
    r"/StudyActivity\?studyActivityId=(?P<study>\d+))\"[^>]*>(?P<label>.*?)</a>",
    re.DOTALL,
)
EN_SESSION = re.compile(r"(\d+)(?:st|nd|rd|th)\s+Parliament,\s+(\d+)(?:st|nd|rd|th)\s+Session")
FR_SESSION = re.compile(r"(\d+)\s*e\s+l[ée]gislature\s*,\s*(\d+)\s*(?:re|ère|e)\s+session", re.IGNORECASE)
INSTRUCTION_BLOCK = re.compile(r'<div[^>]*class="custom-message-container[^"]*"[^>]*>', re.IGNORECASE)
MESSAGE_BLOCK = re.compile(r'<div id="custom-message-\d+" class="custom-message">')
WARNING_MARKERS = ("content warning", "avertissement")


def visible(fragment: str) -> str:
    """Publisher text with tags, entities and layout whitespace normalized."""
    without_tags = re.sub(r"<[^>]+>", " ", fragment)
    return " ".join(html_module.unescape(without_tags).split())


def digest(value) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def parse_participate(page: str, language: str) -> list[dict]:
    """Every study the publisher lists as currently seeking input."""
    studies: dict[str, dict] = {}
    for match in PARTICIPATE_LINK.finditer(page):
        if match.group("language") != language:
            continue
        study_id = match.group("study")
        label = visible(match.group("label"))
        if not label:
            continue
        studies.setdefault(
            study_id,
            {
                "committee": match.group("committee"),
                "study_id": study_id,
                "title": label,
            },
        )
    return list(studies.values())


def parse_call_indexes(pages: dict[str, str | None]) -> dict[str, list[dict]]:
    """Require a captured, nonempty consultation list in each published edition."""
    listings = {}
    for language, url in PARTICIPATE_INDEX.items():
        body = pages.get(url)
        if body is None:
            raise ValueError(f"the {language} consultation list was not captured")
        studies = parse_participate(body, language)
        if not studies:
            raise ValueError(f"no consultations were listed in the {language} edition")
        listings[language] = studies
    return listings


def parse_call_editions(session: str, listings: dict[str, list[dict]],
                        pages: dict[str, str | None]) -> list[dict]:
    """Read every listed study before publication and identify conflicting motion text."""
    editions = []
    motions = {}
    for language in PARTICIPATE_INDEX:
        for study in listings[language]:
            study_id = study["study_id"]
            url = study_url(study["committee"], study_id, language)
            body = pages.get(url)
            if body is None:
                raise ValueError(f"{url} was not captured")
            published_session = parse_session(body, language)
            if published_session != session:
                raise ValueError(f"expected session {session} at {url}, found {published_session!r}")
            parsed = parse_study(body, language)
            edition = {"language": language, "study": study, "url": url, "parsed": parsed, "shares_with": []}
            editions.append(edition)
            # Standard committee instructions may be shared. A motion is study-specific.
            instructions = (parsed["instructions"] or "").strip()
            if instructions and "motion" in instructions.casefold():
                motions.setdefault((language, instructions), []).append(edition)
    for matches in motions.values():
        study_ids = {edition["study"]["study_id"] for edition in matches}
        if len(study_ids) > 1:
            for edition in matches:
                edition["shares_with"] = sorted(study_ids - {edition["study"]["study_id"]})
    return editions


def classify_senate_probe(body: str | None) -> str:
    """Report what the checked Senate page contains, including unavailable pages."""
    if body is None:
        return "unreadable"
    folded = body.casefold()
    if any(marker in folded for marker in CALL_MARKERS):
        return "call-listing-present"
    return "no-call-listing-in-archived-html"


def parse_session(page: str, language: str) -> str | None:
    pattern = EN_SESSION if language == "en" else FR_SESSION
    match = pattern.search(visible(page))
    if not match:
        return None
    return f"{int(match.group(1))}-{int(match.group(2))}"


def parse_study(page: str, language: str) -> dict:
    """The participation button and instructions a study page publishes."""
    title = visible(match.group(1)) if (
        match := re.search(r'<h1 class="study-title-label">(.*?)</h1>', page, re.DOTALL)
    ) else None
    if not title:
        bill = re.search(r'<h1 class="study-bill-label">(.*?)</h1>', page, re.DOTALL)
        long_title = re.search(r'<h2 class="study-bill-title-label">(.*?)</h2>', page, re.DOTALL)
        if bill:
            title = ", ".join(
                part for part in [visible(bill.group(1)), visible(long_title.group(1)) if long_title else ""] if part
            )
    button = re.search(
        r'<a class="btn btn-dark" href="(?P<href>[^"]+)"[^>]*title="[^"]*"', page
    )
    subtitle = re.search(r'class="btn-subtitle">(.*?)</span>', page, re.DOTALL)
    instructions = None
    warning_text = None
    if block := INSTRUCTION_BLOCK.search(page):
        end = page.find("<!-- Information -->", block.end())
        fragment = page[block.end() : end if end > 0 else block.end() + 12000]
        messages = [text for chunk in MESSAGE_BLOCK.split(fragment)[1:] if (text := visible(chunk))]
        warning = [text for text in messages if any(marker in text.casefold() for marker in WARNING_MARKERS)]
        warning_text = " ".join(warning) or None
        instructions = " ".join(text for text in messages if text not in warning) or None
    deadline_text = visible(subtitle.group(1)) if subtitle and visible(subtitle.group(1)) else None
    return {
        "page_title": title,
        "instruction_href": button.group("href") if button else None,
        "deadline_text": deadline_text,
        "deadline": parse_deadline(deadline_text, language),
        "instructions": instructions,
        "content_warning": warning_text is not None,
        "content_warning_text": warning_text,
    }


def parse_deadline(value: str | None, language: str) -> dict | None:
    """Keep the publisher's phrase; add an instant only when the phrase is complete."""
    if not value:
        return None
    pattern = EN_DEADLINE if language == "en" else FR_DEADLINE
    match = pattern.search(value)
    if not match:
        return {"text": value, "instant": None, "timeZone": None}
    parts = match.groupdict()
    zone = parts["zone"]
    unparsed = {"text": value, "instant": None, "timeZone": zone}
    month = MONTHS[language].get(parts["month"].casefold())
    if month is None:
        return unparsed
    hour = int(parts["hour"])
    if language == "en":
        if not 1 <= hour <= 12:
            return unparsed
        hour = hour % 12 + (12 if parts["meridiem"].lower() == "p" else 0)
    try:
        local = datetime(
            int(parts["year"]), month, int(parts["day"]), hour, int(parts["minute"])
        )
    except ValueError:
        return unparsed
    # A weekday that disagrees with its own date is not a fact to resolve silently.
    if WEEKDAYS[language][local.weekday()] != parts["weekday"].casefold():
        return unparsed
    if zone in FIXED_ZONES:
        local = local.replace(tzinfo=timezone(timedelta(hours=FIXED_ZONES[zone])))
    elif zone in CITY_ZONES:
        local = local.replace(tzinfo=ZoneInfo("America/Toronto"))
    else:
        return unparsed
    return {
        "text": value,
        "instant": local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timeZone": zone,
    }


def call_observation_time(sources, previous: str | None) -> str:
    """Order complete House captures by publisher request times, including cached replays."""
    captured = []
    for source in sources:
        if source.get("error") or not source.get("checked"):
            raise ValueError(f"missing successful publisher observation for {source['url']}")
        instant = datetime.fromisoformat(source["checked"])
        if instant.utcoffset() is None:
            raise ValueError(f"publisher request time lacks a zone at {source['url']}")
        captured.append(instant)
    latest = max(captured)
    if previous:
        cutoff = datetime.fromisoformat(previous)
        # The original operator recorded the end of collection in whole seconds.
        if "." not in previous:
            cutoff = cutoff.replace(microsecond=999999)
        if latest <= cutoff:
            return previous
        if min(captured) <= cutoff:
            raise ValueError("House capture mixes previously applied pages with newer publisher requests")
    return latest.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def build_call(
    *,
    session: str,
    language: str,
    committee: str,
    study_id: str,
    listed_title: str,
    observed_at: str,
    parsed: dict,
    existing: dict | None = None,
    conflict: bool = False,
) -> dict:
    """The record the committee store receives. IDs are CivicSignal's, not the source's.

    The House occasionally serves another study's motion block on a study page, and
    alternates between variants. A changed block therefore has to be observed twice
    in a row before it replaces the confirmed content: one contradictory page load
    records a pending candidate instead of rewriting the record.
    """
    history = (existing or {}).get("metadata") or {}
    content = {
        "studyId": study_id,
        "instructionUrl": urljoin("https://www.ourcommons.ca", parsed["instruction_href"]) if parsed["instruction_href"] else None,
        "deadline": parsed["deadline"],
        "instructions": parsed["instructions"],
    }
    candidate = digest(content)
    confirmed = history.get("contentDigest")
    replay = False
    if history.get("observedAt"):
        prior_instant = datetime.fromisoformat(history["observedAt"])
        incoming = datetime.fromisoformat(observed_at)
        if incoming < prior_instant:
            raise ValueError(f"cannot apply an older observation to {study_id}/{language}")
        if incoming == prior_instant:
            replay = True
            observed_at = history["observedAt"]
    if replay:
        expected = history.get("pendingDigest") or confirmed
        if (candidate != expected or history.get("listed") is False
                or bool(history.get("contentConflict")) != conflict
                or parsed["content_warning"] != bool(history.get("contentWarning"))
                or parsed["content_warning_text"] != history.get("contentWarningText")
                or (existing.get("title") is not None and existing["title"] != listed_title)):
            raise ValueError(f"cached study differs from the stored observation: {study_id}/{language}")
    revision = int(history.get("revision") or 1)
    pending = None
    if history and candidate != confirmed:
        if conflict or replay:
            pending = candidate                # shared motion or the same archived sighting
            content = {key: history.get(key) for key in content}
        elif history.get("pendingDigest") == candidate:
            revision += 1                      # second consecutive observation: commit
        else:
            pending = candidate                # first sighting: hold it
            content = {key: history.get(key) for key in content}
    committed = digest(content)
    return {
        "session": session,
        "id": call_id(committee, study_id),
        "language": language,
        "kind": "call",
        "chamber": "house",
        "committee_id": committee_id(committee),
        "title": listed_title,
        "url": study_url(committee, study_id, language),
        "status": "indexed",
        "metadata": {
            "delivery": "excerpt",
            "termsUrl": HOUSE_TERMS,
            "committeeCode": committee,
            "listingUrl": PARTICIPATE_INDEX[language],
            "contentWarning": parsed["content_warning"],
            "contentWarningText": parsed["content_warning_text"],
            # Listing presence is an observation, not publisher content: a call that
            # leaves the current list keeps its last listed date and gains no revision.
            "listed": True,
            "lastListedAt": observed_at,
            "observedAt": observed_at,
            "firstObservedAt": history.get("firstObservedAt", observed_at),
            "revision": revision,
            "contentDigest": committed,
            "pendingDigest": pending,
            "contentConflict": conflict,
            **content,
        },
    }


def dropped_call_metadata(metadata: dict) -> dict | None:
    """Keep the last confirmed facts and revision when a previously listed call leaves."""
    return None if metadata.get("listed") is False else {**metadata, "listed": False}


def mark_unlisted(db, session: str, present: set[tuple[str, str]]) -> list[dict]:
    """Flag stored calls that the current listing no longer names.

    Listing presence is an observation, not publisher content: the store's
    signature ignores ``listed`` and ``lastListedAt``, so this creates no
    revision. The call keeps its published deadline and instructions, and the
    API reports the last observation that listed it.
    """
    from .committee_store import update

    dropped = []
    for row in db.execute(
        "SELECT session,id,language,kind,chamber,committee_id,title,url,status,metadata_json "
        "FROM cc_records WHERE session=? AND kind='call'",
        (session,),
    ):
        if (row["id"], row["language"]) in present:
            continue
        metadata = dropped_call_metadata(json.loads(row["metadata_json"]))
        if metadata is None:
            continue
        update(db, {
            "session": row["session"], "id": row["id"], "language": row["language"],
            "kind": row["kind"], "chamber": row["chamber"], "committee_id": row["committee_id"],
            "title": row["title"], "url": row["url"], "status": row["status"],
            "metadata": metadata,
        })
        dropped.append({"id": row["id"], "language": row["language"],
                        "lastListedAt": metadata.get("lastListedAt")})
    return dropped


def committee_id(code: str) -> str:
    return "house-" + code.lower()


def call_id(code: str, study_id: str) -> str:
    return f"{committee_id(code)}-call-{study_id}"


def study_url(code: str, study_id: str, language: str) -> str:
    return (
        f"https://www.ourcommons.ca/committees/{language}/{code.upper()}"
        f"/StudyActivity?studyActivityId={study_id}"
    )
