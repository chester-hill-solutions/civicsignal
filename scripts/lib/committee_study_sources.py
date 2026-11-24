"""Read citations and report events published on an individual House study page."""

from html.parser import HTMLParser
import re
from urllib.parse import urljoin, urlsplit
from .committee_files import official


class StudyCitations(HTMLParser):
    def __init__(self, url, session, committee, language):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.path_prefix = f"/documentviewer/{language}/{session}/{committee}/".lower()
        self.publications = set()
        self.bills = set()
        self.events = []
        self.event_list = False
        self.words = None
        self.report = None
        self.in_report_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if "study-report-title" in classes:
            self.in_report_title = True
            self.report = None
        if "study-report-events" in classes:
            self.event_list = True
        if tag == "li" and self.event_list:
            self.words = []
        if tag != "a" or not attrs.get("href"):
            return
        link = urljoin(self.url, attrs["href"])
        if not official(link):
            return
        path = urlsplit(link).path.lower()
        if self.path_prefix in path:
            self.publications.add(link)
            if self.in_report_title and re.search(r"/(?:report|rapport)-\d+/?$", path):
                self.report = link
        if "/legisinfo/" in path and (
            "billdetails" in path
            or re.search(r"/(?:bill|projet-de-loi)/\d+-\d+/", path)
        ):
            self.bills.add(link)

    def handle_data(self, text):
        if self.words is not None:
            self.words.append(text)

    def handle_endtag(self, tag):
        if tag == "div" and self.in_report_title:
            self.in_report_title = False
        if tag == "li" and self.words is not None:
            text = " ".join("".join(self.words).split())
            if text:
                self.events.append({"text": text, "reportUrl": self.report})
            self.words = None
        if tag == "ul":
            self.event_list = False


def publication_facts(task):
    from .committee_files import read_object
    from .committee_publications import publication_metadata

    root, language, record_id, url, digest = task
    facts = publication_metadata(read_object(root, digest), url, language)
    return {
        "language": language,
        "id": record_id,
        "url": url,
        "digest": digest,
        "facts": facts,
    }
