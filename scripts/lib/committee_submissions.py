"""Text extraction and content-addressed original storage for committee submissions."""
from __future__ import annotations

from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
import posixpath
import re
import subprocess
import tempfile
from typing import Any
import xml.etree.ElementTree as ET
import zipfile


MAX_SUBMISSION_BYTES = 64 * 1024 * 1024
MAX_OOXML_MEMBERS = 4096
MAX_OOXML_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_OOXML_MEMBER_BYTES = 64 * 1024 * 1024
MAX_OOXML_XML_BYTES = 24 * 1024 * 1024
_BLOCKS = {"p", "div", "li", "tr", "section", "blockquote", "article"}
_HEADINGS = {"h1", "h2", "h3", "h4"}
_WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_X = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class _HtmlSubmission(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[tuple[str, str | None]] = []
        self.hidden = 0
        self.heading: str | None = None
        self.current: list[str] = []
        self.in_heading = False

    def _flush(self) -> None:
        text = re.sub(r"\s+", " ", " ".join(self.current)).strip()
        if text:
            if self.in_heading:
                self.heading = text[:240]
            else:
                self.parts.append((text, self.heading))
        self.current = []
        self.in_heading = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg", "template"}:
            self.hidden += 1
        if tag in _BLOCKS | _HEADINGS:
            self._flush()
        if tag in _HEADINGS:
            self.in_heading = True

    def handle_endtag(self, tag: str) -> None:
        if tag in _BLOCKS | _HEADINGS:
            self._flush()
        if tag in {"script", "style", "noscript", "svg", "template"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.current.append(data)


def _pdf_pages(body: bytes) -> list[dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="committee-pdf-") as temp:
        source = Path(temp) / "submission.pdf"
        source.write_bytes(body)
        try:
            result = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(source), "-"],
                                    capture_output=True, timeout=45, check=False)
        except OSError as exc:
            raise RuntimeError("pdftotext is unavailable while extracting a committee PDF") from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("pdftotext timed out while extracting a committee PDF") from exc
        if result.returncode:
            raise RuntimeError("pdftotext failed to extract committee PDF (exit " + str(result.returncode) + ")")
    pages = []
    for number, chunk in enumerate(result.stdout.decode("utf-8", "replace").split("\f"), start=1):
        text = re.sub(r"\n{3,}", "\n\n", chunk).strip()
        if text:
            pages.append({"text": text, "location": f"page:{number}", "speaker": None, "affiliation": None})
    return pages


def _read_ooxml_member(archive: zipfile.ZipFile, name: str, *, xml: bool = True) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError as exc:
        raise ValueError(f"OOXML package is missing {name}") from exc
    limit = min(MAX_OOXML_MEMBER_BYTES, MAX_OOXML_XML_BYTES if xml else MAX_OOXML_MEMBER_BYTES)
    if info.file_size < 0 or info.file_size > limit:
        raise ValueError(f"OOXML member exceeds its expanded-size limit: {name}")
    with archive.open(info, "r") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit or len(data) != info.file_size:
        raise ValueError(f"OOXML member size did not match its bounded read: {name}")
    declaration_check = data.replace(b"\x00", b"").upper()
    if xml and (b"<!DOCTYPE" in declaration_check or b"<!ENTITY" in declaration_check):
        raise ValueError(f"OOXML XML declarations are not supported: {name}")
    return data


def _ooxml_kind(body: bytes, url: str, content_type: str) -> str | None:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    path = url.lower().split("?", 1)[0]
    if mime == _WORD_MIME or path.endswith(".docx"):
        return "word"
    if mime == _EXCEL_MIME or path.endswith(".xlsx"):
        return "excel"
    if not body.startswith(b"PK\x03\x04"):
        return None
    try:
        with _open_ooxml(body) as archive:
            names = set(archive.namelist())
    except (OSError, zipfile.BadZipFile):
        return None
    if "word/document.xml" in names:
        return "word"
    if "xl/workbook.xml" in names:
        return "excel"
    return None


def _open_ooxml(body: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(BytesIO(body))
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValueError("submission is not a readable OOXML ZIP package") from exc
    infos = archive.infolist()
    if len(infos) > MAX_OOXML_MEMBERS:
        archive.close()
        raise ValueError("OOXML package contains too many members")
    expanded = 0
    for info in infos:
        if info.file_size < 0 or info.file_size > MAX_OOXML_MEMBER_BYTES:
            archive.close()
            raise ValueError(f"OOXML member exceeds its expanded-size limit: {info.filename}")
        expanded += info.file_size
        if expanded > MAX_OOXML_EXPANDED_BYTES:
            archive.close()
            raise ValueError("OOXML package exceeds its total expanded-size limit")
    return archive


def _xml_member(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        return ET.fromstring(_read_ooxml_member(archive, name))
    except ET.ParseError as exc:
        raise ValueError(f"OOXML XML could not be parsed: {name}") from exc


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _word_paragraph_text(paragraph: ET.Element) -> str:
    parts = []
    for node in paragraph.iter():
        if node.tag == _W + "t" and node.text:
            parts.append(node.text)
        elif node.tag in (_W + "tab", _W + "br", _W + "cr"):
            parts.append(" ")
    return _clean_text("".join(parts))


def _word_document(archive: zipfile.ZipFile) -> list[dict[str, Any]]:
    root = _xml_member(archive, "word/document.xml")
    body = root.find(_W + "body")
    if body is None:
        raise ValueError("OOXML Word document has no body")
    passages: list[dict[str, Any]] = []
    paragraph_number = 0
    table_number = 0

    def append(text: str, location: str) -> None:
        if text:
            passages.append({"text": text, "location": location, "speaker": None, "affiliation": None})

    def visit_table(table: ET.Element, table_index: int) -> None:
        nonlocal table_number
        for row_number, row in enumerate(table.findall(_W + "tr"), start=1):
            for cell_number, cell in enumerate(row.findall(_W + "tc"), start=1):
                cell_paragraph_number = 0
                for child in list(cell):
                    if child.tag == _W + "p":
                        cell_paragraph_number += 1
                        append(_word_paragraph_text(child),
                               f"table:{table_index},row:{row_number},cell:{cell_number},paragraph:{cell_paragraph_number}")
                    elif child.tag == _W + "tbl":
                        table_number += 1
                        visit_table(child, table_number)

    for child in list(body):
        if child.tag == _W + "p":
            paragraph_number += 1
            append(_word_paragraph_text(child), f"paragraph:{paragraph_number}")
        elif child.tag == _W + "tbl":
            table_number += 1
            visit_table(child, table_number)
    return passages


def _relationship_target(target: str) -> str:
    if target.startswith("/"):
        normalized = target.lstrip("/")
    else:
        normalized = posixpath.normpath(posixpath.join("xl", target))
    if normalized == ".." or normalized.startswith("../"):
        raise ValueError("OOXML worksheet relationship escapes the package root")
    return normalized


def _xlsx_text(value: str | None) -> str:
    return _clean_text(value or "")


def _excel_document(archive: zipfile.ZipFile) -> list[dict[str, Any]]:
    workbook = _xml_member(archive, "xl/workbook.xml")
    relationships = _xml_member(archive, "xl/_rels/workbook.xml.rels")
    targets = {}
    for relation in relationships.findall(_PKG_REL + "Relationship"):
        rel_id = relation.attrib.get("Id")
        target = relation.attrib.get("Target")
        if rel_id and target and relation.attrib.get("TargetMode") != "External":
            targets[rel_id] = _relationship_target(target)

    strings: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = _xml_member(archive, "xl/sharedStrings.xml")
        strings = [_xlsx_text("".join(t.text or "" for t in item.iter(_X + "t")))
                   for item in shared.findall(_X + "si")]

    passages: list[dict[str, Any]] = []
    sheets = workbook.find(_X + "sheets")
    if sheets is None:
        raise ValueError("OOXML Excel workbook has no worksheets")
    for sheet in sheets.findall(_X + "sheet"):
        title = sheet.attrib.get("name") or "Sheet"
        target = targets.get(sheet.attrib.get(_R_ID) or "")
        if not target:
            raise ValueError(f"OOXML worksheet has no relationship target: {title}")
        root = _xml_member(archive, target)
        sheet_data = root.find(_X + "sheetData")
        if sheet_data is None:
            continue
        for row_index, row in enumerate(sheet_data.findall(_X + "row"), start=1):
            row_number = row.attrib.get("r") or str(row_index)
            cells = []
            for cell in row.findall(_X + "c"):
                ref = cell.attrib.get("r") or "cell"
                kind = cell.attrib.get("t")
                value_node = cell.find(_X + "v")
                if kind == "inlineStr":
                    value = "".join(t.text or "" for t in cell.iter(_X + "t"))
                else:
                    value = value_node.text if value_node is not None else ""
                    if kind == "s" and value:
                        try:
                            value = strings[int(value)]
                        except (ValueError, IndexError) as exc:
                            raise ValueError(f"OOXML shared-string index is invalid at {ref}") from exc
                    elif kind == "b":
                        value = "TRUE" if value == "1" else "FALSE"
                text = _xlsx_text(value)
                if text:
                    cells.append(f"{ref}: {text}")
            if cells:
                passages.append({"text": " | ".join(cells), "location": f"sheet:{title},row:{row_number}",
                                 "speaker": None, "affiliation": None})
    return passages


def _ooxml_document(body: bytes, kind: str) -> list[dict[str, Any]]:
    archive = _open_ooxml(body)
    try:
        names = set(archive.namelist())
        if kind == "word":
            if "word/document.xml" not in names:
                raise ValueError("OOXML Word package is missing word/document.xml")
            return _word_document(archive)
        if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names:
            raise ValueError("OOXML Excel package is missing its workbook or relationships")
        return _excel_document(archive)
    finally:
        archive.close()


def extract_submission(body: bytes, url: str, content_type: str) -> list[dict]:
    """Return searchable text blocks with source locations, or [] when unsupported/unreadable.

    Author and affiliation are deliberately nullable: callers should fill them from
    published catalogue metadata, never infer them from document prose.
    """
    if not isinstance(body, bytes):
        raise TypeError("body must be bytes")
    if len(body) > MAX_SUBMISSION_BYTES:
        raise ValueError("submission exceeds the extraction byte limit")
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    ooxml = _ooxml_kind(body, url, mime)
    if ooxml:
        return _ooxml_document(body, ooxml)
    if body.startswith(b"%PDF-") or mime == "application/pdf" or url.lower().split("?", 1)[0].endswith(".pdf"):
        if not body.startswith(b"%PDF-"):
            raise ValueError("submission was labeled as PDF but has no PDF signature")
        return _pdf_pages(body)
    if mime in ("text/html", "application/xhtml+xml") or body.lstrip().lower().startswith((b"<!doctype html", b"<html")):
        parser = _HtmlSubmission()
        parser.feed(body.decode("utf-8", "replace"))
        parser.close()
        parser._flush()
        return [{"text": text, "location": f"section:{heading}" if heading else f"section:{i}",
                 "speaker": None, "affiliation": None}
                for i, (text, heading) in enumerate(parser.parts, start=1)]
    if mime.startswith("text/"):
        decoded = body.decode("utf-8", "replace")
        blocks = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", decoded)]
        return [{"text": text, "location": f"section:{i}", "speaker": None, "affiliation": None}
                for i, text in enumerate(blocks, start=1) if text]
    return []


def classify_extraction(body: bytes | None, url: str, content_type: str,
                        passages: list[dict] | None = None) -> str:
    """Distinguish unavailable, unsupported and image-only material from searchable text.

    Callers that fetch files should use ``unavailable`` when no body was obtained.
    PDF tool failures raise from ``extract_submission`` and must be retained as
    extraction errors, not downgraded to an image-only gap.
    """
    if body is None:
        return "unavailable"
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    path = url.lower().split("?", 1)[0]
    ooxml = _ooxml_kind(body, url, mime)
    is_legacy_office = mime in {"application/msword", "application/vnd.ms-excel"} or path.endswith((".doc", ".xls"))
    if is_legacy_office and not ooxml:
        return "unsupported"
    is_pdf = body.startswith(b"%PDF-") or mime == "application/pdf" or path.endswith(".pdf")
    is_html = mime in ("text/html", "application/xhtml+xml") or body.lstrip().lower().startswith((b"<!doctype html", b"<html"))
    is_text = mime.startswith("text/")
    if not (is_pdf or is_html or is_text or ooxml):
        return "unsupported"
    if is_pdf and not body.startswith(b"%PDF-"):
        return "invalid_format"
    extracted = passages if passages is not None else extract_submission(body, url, content_type)
    if extracted:
        return "searchable"
    if is_pdf:
        return "image_only"
    return "empty_text"


