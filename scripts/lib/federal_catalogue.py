"""Parse the registered federal discovery endpoints without performing I/O."""
from html.parser import HTMLParser
import json
import re
from urllib.parse import urljoin, urlsplit

DATASET = re.compile(r"https://open\.canada\.ca/data/(?:en/|fr/)?dataset/([\da-f-]{36})/?$")


class IndexPage(HTMLParser):
    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.heading = []
        self.links = set()
        self.in_heading = False
        self.in_main = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "main" or values.get("role") == "main":
            self.in_main = True
        if tag == "h1":
            self.in_heading = True
        if self.in_main and tag == "a" and values.get("href"):
            target = urljoin(self.url, values["href"])
            if urlsplit(target).scheme == "https" and not values["href"].startswith("#"):
                self.links.add(target)

    def handle_endtag(self, tag):
        if tag == "h1":
            self.in_heading = False
        if tag == "main":
            self.in_main = False

    def handle_data(self, data):
        if self.in_heading:
            self.heading.append(data)


def source_endpoints(row):
    for field in ("entry_url", "companion_url"):
        url = row[field]
        if url:
            dataset = DATASET.fullmatch(url)
            yield field, (f"https://open.canada.ca/data/api/action/package_show?id={dataset[1]}" if dataset else url), (dataset[1] if dataset else None)


def describe(body, final_url, dataset):
    if dataset:
        document = json.loads(body)
        result = document.get("result", {})
        if document.get("success") is not True or result.get("id") != dataset or not result.get("resources"):
            raise ValueError("Missing or mismatched federal dataset")
        resources = sorted(({
            "id": r["id"], "url": r["url"], "format": r.get("format"),
            "titles": r.get("name_translated") or r.get("name"),
            "languages": r.get("language"), "lastModified": r.get("last_modified"),
        } for r in result["resources"]), key=lambda r: r["id"])
        return {"kind": "dataset-resources", "title": result.get("title_translated") or result["title"], "resources": resources}
    page = IndexPage(final_url)
    page.feed(body.decode("utf-8-sig", errors="replace"))
    title = " ".join("".join(page.heading).split())
    if not title or not page.links or re.search(r'access denied|request rejected|accès refusé|page not found|page introuvable', title, re.I):
        raise ValueError("No identifiable catalogue heading and main-content links")
    return {"kind": "index-links", "title": title, "links": sorted(page.links)}
