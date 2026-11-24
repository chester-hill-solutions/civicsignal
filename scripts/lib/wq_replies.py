"""Acquire published House written-question replies from the official viewer.

The viewer's page is a shell.  Its public frontend loads section manifests and
HTML fragments from the sibling ``/ajax`` routes; those fragment calls and
headers are part of the source contract.  This module accepts the orchestrator's
``get(url) -> bytes`` client.  A bytes subclass may expose response headers as
``.headers`` and status as ``.status``; plain bytes remain supported for links
and response shells.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from html.parser import HTMLParser
import os
from pathlib import Path
import re
import inspect
import subprocess
import tempfile
from typing import Any, Callable, Mapping
from urllib.parse import quote, unquote, urljoin, urlparse

HOUSE = "https://www.ourcommons.ca"
MAX_PAGE_BYTES = 16 * 1024 * 1024
MAX_FRAGMENTS = 256
MAX_LINKS = 256
MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
_SAFE_COMPONENT = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
_ATTACHMENT_HINT = re.compile(
    r"\b(?:annex(?:e)?|appendix|piece jointe|fichier joint|document joint|attachment|download|télécharger|"
    r"feuille de calcul|tableau joint|spreadsheet|workbook|excel file|working document|pièce jointe|document à télécharger)\b",
    re.I,
)


def _text(html: str) -> str:
    """Extract human-readable HTML text, retaining table and paragraph breaks."""
    parser = _TextParser()
    parser.feed(html)
    return re.sub(r"[ \t\xa0]+", " ", re.sub(r"\n{3,}", "\n\n", "".join(parser.parts))).strip()


class _TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self.hidden += 1
        if tag in {"br", "p", "div", "tr", "td", "th", "li", "h1", "h2", "h3", "section"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self.hidden:
            self.hidden -= 1
        if tag in {"p", "div", "tr", "li", "h1", "h2", "h3", "section"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden and not re.fullmatch(r"\s*Loading(?:\.\.\.|…)?\s*", data, re.I):
            self.parts.append(data)


class _Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str, str, bool]] = []
        self._href: str | None = None
        self._label: list[str] = []
        self._download = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "a" and values.get("href"):
            self._href = values["href"]
            self._label = []
            self._download = "download" in values or "attachment" in (values.get("class") or "").lower()
        elif tag in {"iframe", "embed", "object", "img"}:
            src = values.get("src") or values.get("data")
            if src:
                self.links.append((src, " ".join(values.get(k, "") or "" for k in ("title", "alt", "type")), tag, True))

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._label.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href is not None:
            self.links.append((self._href, re.sub(r"\s+", " ", " ".join(self._label)).strip(), "a", self._download))
            self._href = None


def _parse_sections(html: str) -> list[dict[str, str]]:
    parser = _SectionParser()
    parser.feed(html)
    unique: dict[str, dict[str, str]] = {}
    for section in parser.sections:
        unique.setdefault(section["code"].lower(), section)
    return list(unique.values())


class _SectionParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[dict[str, str]] = []
        self.current: dict[str, str] | None = None
        self.label: list[str] = []
        self.depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "a" and (code := values.get("data-section-code")):
            self.current = {"code": code, "label": ""}
            self.label = []
            self.depth = 1
        elif self.current:
            self.depth += 1

    def handle_data(self, data: str) -> None:
        if self.current:
            self.label.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.current:
            self.depth -= 1
            if self.depth <= 0:
                self.current["label"] = re.sub(r"\s+", " ", " ".join(self.label)).strip()
                if self.current["code"] and self.current["label"]:
                    self.sections.append(self.current)
                self.current = None


def _call(get: Callable[..., bytes], url: str, request_headers: Mapping[str, str] | None = None) -> tuple[bytes, Mapping[str, Any], int | None]:
    if request_headers:
        try:
            params = inspect.signature(get).parameters.values()
            accepts_headers = any(p.name == "headers" or p.kind == inspect.Parameter.VAR_KEYWORD for p in params)
        except (TypeError, ValueError):
            accepts_headers = False
        result = get(url, headers=dict(request_headers)) if accepts_headers else get(url)
    else:
        result = get(url)
    if not isinstance(result, (bytes, bytearray, memoryview)):
        raise TypeError("get(url) must return bytes-like content")
    body = bytes(result)
    if len(body) > MAX_ATTACHMENT_BYTES:
        raise ValueError("source response exceeds the acquisition byte limit")
    headers = getattr(result, "headers", {}) or {}
    if hasattr(headers, "items"):
        headers = {str(k).lower(): v for k, v in headers.items()}
    else:
        headers = {}
    status = getattr(result, "status", None)
    return body, headers, int(status) if status is not None else None


def _headers(headers: Mapping[str, Any]) -> dict[str, str]:
    return {str(k).lower(): str(v) for k, v in headers.items()}


def _store(objects: Path, body: bytes) -> str:
    digest = sha256(body).hexdigest()
    objects.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(objects, 0o700)
    except OSError:
        pass
    target = objects / digest
    if target.exists():
        if target.stat().st_size != len(body) or sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError("content-addressed object collision or corruption")
        return digest
    fd, temporary = tempfile.mkstemp(prefix=".wq-", dir=objects)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            if sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError("content-addressed object collision or corruption")
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return digest


def _pdf_text(body: bytes) -> str:
    if not body.startswith(b"%PDF-"):
        return ""
    with tempfile.TemporaryDirectory(prefix="wq-pdf-") as temp:
        source = Path(temp) / "source.pdf"
        source.write_bytes(body)
        try:
            completed = subprocess.run(["pdftotext", "-layout", str(source), "-"], capture_output=True,
                                       timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        if completed.returncode:
            return ""
        return completed.stdout.decode("utf-8", "replace").strip()


def _attachment_title(label: str, url: str) -> str:
    value = re.sub(r"\s+", " ", label).strip()
    if not value or len(value) > 180 or re.search(r"\bLoading\b", value, re.I):
        return unquote(urlparse(url).path.rsplit("/", 1)[-1]) or "Published attachment"
    return value


def _hansard_answer(text: str, number: str, language: str) -> str:
    marker = r"Question\s+(?:No\.?|no)\s*" + re.escape(number) + r"\s*[—–-]"
    start = re.search(r"(?im)(?:^|\n)\s*" + marker, text)
    if not start:
        return ""
    next_marker = re.search(r"(?im)\n\s*Question\s+(?:No\.?|no)\s*[1-9][0-9]*\s*[—–-]", text[start.end():])
    if not next_marker:
        return ""
    section = text[start.end():start.end() + next_marker.start()].strip()
    # Keep the responding member and answer, dropping the repeated question text.
    # French speaker lines can contain nested role parentheses, e.g. a
    # parliamentary secretary title with a parenthesized portfolio. Require a
    # labeled line ending in a colon, and skip the questioner's unparenthesized
    # line at the start of the block.
    speaker = re.search(r"(?m)^([^\n]{1,400}\([^\n]{1,350}\):)[ \t]*", section)
    if speaker:
        return section[speaker.start():].strip()
    greeting = re.search(r"(?im)^\s*(?:Monsieur le Président|Madame la Présidente|Monsieur le Président|Madam Speaker|Mr\. Speaker)\b", section)
    return section[greeting.start():].strip() if greeting else ""


def _public_url(raw: str, base: str) -> str | None:
    url = urljoin(base, raw)
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return None
    return url


def _government_host(host: str) -> bool:
    host = host.lower().rstrip(".")
    return (host in {"ourcommons.ca", "noscommunes.ca", "canada.ca", "gc.ca", "parl.ca"} or
            host.endswith((".ourcommons.ca", ".noscommunes.ca", ".canada.ca", ".gc.ca", ".parl.ca")))


def _official_url(raw: str, base: str) -> str | None:
    url = _public_url(raw, base)
    parsed = urlparse(url) if url else None
    return url if parsed and _government_host(parsed.hostname or "") else None


def _response_shell_url(session: str, number: str, response_id: str, language: str) -> str:
    app = "written-questions" if language == "en" else "questions-ecrites"
    slug = f"q-{number}" if language == "en" else f"Q-{number}"
    return f"{HOUSE}/{app}/{session}/{quote(slug, safe='-')}/{quote(response_id, safe='')}"


def _response_detail_url(session: str, number: str, language: str) -> str:
    app = "written-questions" if language == "en" else "questions-ecrites"
    slug = f"q-{number}" if language == "en" else f"Q-{number}"
    return f"{HOUSE}/{app}/{session}/{quote(slug, safe='-')}"


def acquire_written_question_replies(record: Mapping[str, Any], get: Callable[..., bytes],
                                     object_dir: str | Path) -> dict[str, Any]:
    """Fetch all published response sections and linked attachments for one record.

    ``record`` needs ``number``, ``session`` (for example ``45-1``),
    ``language`` (``en`` or ``fr``), and ``responses`` containing response IDs.
    The function performs no bulk discovery and never treats a shell as reply text.
    """
    number = str(record.get("number", ""))
    session = str(record.get("session", ""))
    language = str(record.get("language", "en"))
    if not re.fullmatch(r"Q?-?[1-9][0-9]{0,5}", number, re.I) or not re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", session) or language not in {"en", "fr"}:
        raise ValueError("invalid written-question number, session, or language")
    number = number.upper().removeprefix("Q-").removeprefix("Q")
    responses = record.get("responses", [])
    if not isinstance(responses, list):
        raise ValueError("responses must be a list")
    objects = Path(object_dir)
    docs: list[dict[str, Any]] = []
    response_results: list[dict[str, Any]] = []
    references: list[dict[str, Any]] = []
    errors: list[str] = []

    for response in responses:
        if not isinstance(response, Mapping):
            errors.append("invalid_response_record")
            continue
        response_type = str(response.get("type", "viewer"))
        response_url = str(response.get("url", ""))
        path_hint = response_url.lower()
        is_debates = response_type == "debates" or "/hansard" in path_hint or "/debats" in path_hint
        if is_debates:
            identifier = str(response.get("id", response.get("eventId", "")))
            published_url = _official_url(response_url, _response_detail_url(session, number, language))
            if not re.fullmatch(r"[1-9][0-9]{0,11}", identifier) or not published_url:
                errors.append("invalid_debates_response_reference")
                response_results.append({"id": identifier, "type": response_type, "availability": "invalid_reference"})
                continue
            acquisition_url = published_url.split("#", 1)[0]
            try:
                body, hdrs, status = _call(get, acquisition_url)
            except Exception as exc:
                errors.append(f"response_{identifier}_debates_fetch_{type(exc).__name__}")
                response_results.append({"id": identifier, "type": "debates", "catalogue_type": response_type, "url": published_url, "availability": "fetch_error"})
                continue
            if status == 404 or not body:
                errors.append(f"response_{identifier}_debates_http_404")
                response_results.append({"id": identifier, "type": "debates", "catalogue_type": response_type, "url": published_url, "availability": "unavailable"})
                continue
            digest = _store(objects, body)
            hansard_text = _text(body.decode("utf-8", "replace"))
            answer = _hansard_answer(hansard_text, number, language)
            if not answer:
                errors.append(f"response_{identifier}_debates_answer_not_found")
                docs.append({"doc_key": f"wq:{session}:q{number}:r{identifier}:debates", "kind": "reply",
                             "respondent": "House of Commons Debates (Hansard)", "title": "Hansard response",
                             "url": published_url, "acquisition_url": acquisition_url, "text": "",
                             "object_sha256": digest, "availability": "gap", "response_id": identifier,
                             "sessional_paper_number": response.get("sessionalPaperNumber"), "source_type": "debates"})
                response_results.append({"id": identifier, "type": response_type, "url": published_url, "availability": "answer_not_found", "shell_sha256": digest})
                continue
            docs.append({"doc_key": f"wq:{session}:q{number}:r{identifier}:debates", "kind": "reply",
                         "respondent": "House of Commons Debates (Hansard)", "title": "Hansard response",
                         "url": published_url, "acquisition_url": acquisition_url, "text": answer,
                         "object_sha256": digest, "availability": "searchable", "response_id": identifier,
                         "sessional_paper_number": response.get("sessionalPaperNumber"), "source_type": "debates"})
            response_results.append({"id": identifier, "type": "debates", "catalogue_type": response_type, "url": published_url,
                                     "availability": "published_text", "shell_sha256": digest})
            continue
        if response_type == "sessional_paper":
            response_results.append({"id": str(response.get("id", response.get("sessionalPaperId", ""))),
                                     "type": response_type, "url": response.get("url"),
                                     "sessional_paper_id": response.get("sessionalPaperId"),
                                     "event_id": response.get("eventId"),
                                     "sessional_paper_number": response.get("sessionalPaperNumber"),
                                     "date": response.get("date"), "institution": response.get("institution"),
                                     "availability": "archived_reference"})
            continue
        response_id = str(response.get("id", response.get("governmentResponseId", response.get("responseId", ""))))
        if not re.fullmatch(r"[1-9][0-9]{0,11}", response_id):
            errors.append("invalid_response_id")
            continue
        shell_url = _response_shell_url(session, number, response_id, language)
        # The frontend's AJAX URL builder uses the question detail pathname as
        # its base, even though the full-text preview shell has /{responseId}.
        api_base = _response_detail_url(session, number, language)
        try:
            shell, shell_headers, shell_status = _call(get, shell_url)
        except Exception as exc:
            errors.append(f"response_{response_id}_fetch_{type(exc).__name__}")
            response_results.append({"id": response_id, "url": shell_url, "availability": "fetch_error"})
            continue
        if shell_status == 404:
            errors.append(f"response_{response_id}_shell_404")
            response_results.append({"id": response_id, "url": shell_url, "availability": "unavailable"})
            continue
        shell_text = shell.decode("utf-8", "replace")
        # A standard site/error shell can be returned with HTTP 200 by the host.
        if re.search(r"<title>\s*(?:404|page not found|error)\b|StatusCode=404|The resource you are looking for has been removed", shell_text, re.I):
            response_results.append({"id": response_id, "url": shell_url, "availability": "unavailable"})
            continue
        if not re.search(rf'data-government-response-id=["\']{re.escape(response_id)}["\']', shell_text, re.I):
            errors.append(f"response_{response_id}_shell_mismatch")
            response_results.append({"id": response_id, "url": shell_url, "availability": "host_error_or_mismatch"})
            continue

        shell_hash = _store(objects, shell)
        token = re.search(r'<meta\b[^>]*\bname=["\']request-verification-token["\'][^>]*\bcontent=["\']([^"\']+)', shell_text, re.I)
        if token is None:
            token = re.search(r'<meta\b[^>]*\bcontent=["\']([^"\']+)["\'][^>]*\bname=["\']request-verification-token["\']', shell_text, re.I)
        fragment_headers = {"RequestVerificationToken": token.group(1)} if token else {}
        # This official frontend endpoint returns section labels and section codes.
        section_url = f"{api_base}/ajax/{response_id}/sections"
        sections: list[dict[str, str]] = []
        try:
            section_body, _, section_status = _call(get, section_url, fragment_headers)
            if section_status == 404:
                errors.append(f"response_{response_id}_sections_404")
                response_results.append({"id": response_id, "url": shell_url, "availability": "section_list_unavailable", "shell_sha256": shell_hash})
                continue
            sections = _parse_sections(section_body.decode("utf-8", "replace"))
        except Exception as exc:
            errors.append(f"response_{response_id}_sections_{type(exc).__name__}")
        if not sections:
            # Published section inventory missing is distinct from an unanswered question.
            errors.append(f"response_{response_id}_sections_empty")
            response_results.append({"id": response_id, "url": shell_url, "availability": "section_list_missing", "shell_sha256": shell_hash})
            continue

        found_text = False
        for section in sections:
            code = section["code"].lower()
            if not re.fullmatch(r"[a-z0-9_-]{1,64}", code):
                errors.append(f"response_{response_id}_invalid_section_code")
                continue
            fragment_url = f"{api_base}/ajax/{response_id}/{quote(code, safe='-')}/file-content?part={quote(code + '-main', safe='-')}"
            section_docs: list[tuple[str, bytes, Mapping[str, Any], int | None, str]] = []
            try:
                body, hdrs, status = _call(get, fragment_url, fragment_headers)
                if status == 404:
                    section_docs = []
                    errors.append(f"response_{response_id}_section_{code}_main_404")
                else:
                    keys = _headers(hdrs).get("x-htmlfragments-keys", "")
                    if not keys:
                        errors.append(f"response_{response_id}_section_{code}_fragment_header_missing")
                        current_key = f"{code}-main"
                        section_docs.append((fragment_url, body, hdrs, status, current_key))
                    else:
                        fragment_keys = list(dict.fromkeys(k.strip() for k in keys.split(",") if k.strip()))
                        if len(fragment_keys) > MAX_FRAGMENTS:
                            errors.append(f"response_{response_id}_fragment_limit")
                            fragment_keys = fragment_keys[:MAX_FRAGMENTS]
                        current_key = fragment_keys[0] if fragment_keys else f"{code}-main"
                        if not current_key or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", current_key):
                            errors.append(f"response_{response_id}_invalid_fragment_key")
                            current_key = f"{code}-main"
                        section_docs.append((fragment_url, body, hdrs, status, current_key))
                        for key in fragment_keys[1:]:
                            if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", key):
                                errors.append(f"response_{response_id}_invalid_fragment_key")
                                continue
                            url = f"{api_base}/ajax/{response_id}/{quote(code, safe='-')}/file-content?part={quote(key, safe='-')}"
                            try:
                                part, part_headers, part_status = _call(get, url, fragment_headers)
                                if part_status == 404:
                                    errors.append(f"response_{response_id}_section_{code}_fragment_404")
                                    continue
                                section_docs.append((url, part, part_headers, part_status, key))
                            except Exception as exc:
                                errors.append(f"response_{response_id}_section_{code}_fragment_{type(exc).__name__}")
            except Exception as exc:
                errors.append(f"response_{response_id}_section_{code}_fragment_{type(exc).__name__}")

            collected_html = []
            is_cover = code in {"cov", "cover", "cover-page"}
            public_section_url = shell_url + "?section=" + quote(code, safe="-")
            for index, (url, body, hdrs, status, fragment_key) in enumerate(section_docs):
                digest = _store(objects, body)
                html = body.decode("utf-8", "replace")
                plain = _text(html)
                collected_html.append(html)
                if plain and not re.fullmatch(r"\s*(?:No response found|No content found)\.?\s*", plain, re.I):
                    if not is_cover:
                        found_text = True
                    docs.append({"doc_key": f"wq:{session}:q{number}:r{response_id}:section:{code}:fragment:{index}",
                                 "kind": "cover_page" if is_cover else "reply", "respondent": section["label"], "title": section["label"],
                                 "url": public_section_url, "acquisition_url": url, "text": plain, "object_sha256": digest, "availability": "searchable",
                                 "response_id": response_id, "section_code": code, "section_role": "cover_page" if is_cover else "respondent_reply", "fragment_index": index,
                                 "fragment_key": fragment_key, "shell_sha256": shell_hash,
                                 "sessional_paper_number": response.get("sessionalPaperNumber")})
                else:
                    docs.append({"doc_key": f"wq:{session}:q{number}:r{response_id}:section:{code}:fragment:{index}",
                                 "kind": "cover_page" if is_cover else "reply", "respondent": section["label"], "title": section["label"],
                                 "url": public_section_url, "acquisition_url": url, "text": "", "object_sha256": digest, "availability": "gap",
                                 "response_id": response_id, "section_code": code, "section_role": "cover_page" if is_cover else "respondent_reply", "fragment_index": index,
                                 "fragment_key": fragment_key, "shell_sha256": shell_hash})

            # Keep outbound prose references separate from files attached to a
            # response. Relative uploaded files, embed/download controls, and
            # explicitly named annexes are attachment candidates; an absolute
            # PDF or HTML citation by itself is not.
            section_links: list[tuple[str, str, str, bool, str]] = []
            for html, item in zip(collected_html, section_docs):
                link_parser = _Links()
                link_parser.feed(html)
                section_links.extend((href, label, tag, download, item[4]) for href, label, tag, download in link_parser.links)
            if len(section_links) > MAX_LINKS:
                errors.append(f"response_{response_id}_section_{code}_attachment_link_limit")
            attachment_urls: dict[str, str] = {}
            section_references: list[dict[str, Any]] = []
            seen_section_references: set[str] = set()
            for href, label, tag, download, fragment_key in section_links[:MAX_LINKS]:
                target = _public_url(href, api_base)
                parsed_target = urlparse(target) if target else None
                path = parsed_target.path.lower() if parsed_target else ""
                official_host = bool(parsed_target and _government_host(parsed_target.hostname or ""))
                file_extension = bool(re.search(r"\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|xml|html?|jpe?g|png|tiff?|zip)$", path))
                relative_link = not urlparse(href).scheme and not href.startswith(("/", "//", "#"))
                explicit_document_context = bool(_ATTACHMENT_HINT.search(label) or _ATTACHMENT_HINT.search(path))
                is_document = official_host and (tag in {"iframe", "embed", "object"} or download or
                                                 relative_link and file_extension or
                                                 file_extension and explicit_document_context)
                if tag == "img":
                    is_figure = bool(re.search(r"\b(?:figure|chart|diagram|map|annex|appendix|photo|photograph|image)\b", label, re.I))
                    decorative = re.search(r"(?:logo|stamp|crest|flag|signature|icon|emblem|coat.?of.?arms|house of commons|parliament of canada)", path + " " + label, re.I)
                    is_document = official_host and is_figure and not decorative
                    if not is_document:
                        continue
                if not target or target == api_base:
                    continue
                if is_document and target not in attachment_urls:
                    attachment_urls[target] = label
                elif target not in seen_section_references:
                    reference = {"response_id": response_id, "section_code": code, "fragment_key": fragment_key,
                                 "url": target, "label": label[:240], "source_type": "linked_reference"}
                    section_references.append(reference)
                    seen_section_references.add(target)
                    references.append(reference)
            refs_by_fragment: dict[str, list[dict[str, Any]]] = {}
            for reference in section_references:
                refs_by_fragment.setdefault(str(reference["fragment_key"]), []).append(reference)
            for doc in docs:
                if doc.get("response_id") == response_id and doc.get("section_code") == code and doc.get("section_role"):
                    doc["outbound_references"] = refs_by_fragment.get(str(doc.get("fragment_key")), [])
            for index, (url, label) in enumerate(attachment_urls.items()):
                try:
                    body, hdrs, status = _call(get, url)
                except Exception as exc:
                    docs.append({"doc_key": f"wq:{session}:q{number}:r{response_id}:section:{code}:attachment:{index}",
                                 "kind": "attachment", "respondent": section["label"], "title": _attachment_title(label, url),
                                 "url": url, "text": "", "availability": "gap", "reason": type(exc).__name__, "response_id": response_id})
                    continue
                if status == 404:
                    docs.append({"doc_key": f"wq:{session}:q{number}:r{response_id}:section:{code}:attachment:{index}",
                                 "kind": "attachment", "respondent": section["label"], "title": _attachment_title(label, url),
                                 "url": url, "text": "", "availability": "gap", "reason": "http_404", "response_id": response_id,
                                 "section_code": code})
                    continue
                digest = _store(objects, body)
                media = _headers(hdrs).get("content-type", "").split(";", 1)[0].lower()
                is_pdf = media == "application/pdf" or body.startswith(b"%PDF-")
                html_document = media in {"text/html", "application/xhtml+xml"} or b"<html" in body[:2048].lower()
                document_text = body.decode("utf-8", "replace") if html_document else ""
                attachment_error_shell = bool(document_text and re.search(
                    r"<title>\s*(?:404|page not found|error)\b|StatusCode=404|The resource you are looking for has been removed",
                    document_text, re.I))
                text = _pdf_text(body) if is_pdf else _text(document_text) if html_document and not attachment_error_shell else ""
                docs.append({"doc_key": f"wq:{session}:q{number}:r{response_id}:section:{code}:attachment:{index}",
                             "kind": "attachment", "respondent": section["label"], "title": _attachment_title(label, url),
                             "url": url, "text": text, "object_sha256": digest,
                             "availability": "gap" if attachment_error_shell else "searchable" if text else "stored" if body else "gap",
                             "mime_type": media or ("application/pdf" if is_pdf else "unknown"),
                             "is_scan_or_textless_pdf": bool(is_pdf and not text), "response_id": response_id,
                             **({"reason": "host_error_shell"} if attachment_error_shell else {}),
                             "section_code": code})
        if not found_text:
            errors.append(f"response_{response_id}_no_substantive_reply_text")
        response_results.append({"id": response_id, "url": shell_url,
                                 "availability": "published_text" if found_text else "published_cover_only" if any(s["code"].lower() in {"cov", "cover", "cover-page"} for s in sections) else "published_without_searchable_text",
                                 "sections": sections, "shell_sha256": shell_hash,
                                 "sessional_paper_number": response.get("sessionalPaperNumber")})

    return {"documents": docs, "responses": response_results, "references": references, "errors": errors}

