import importlib.util
from inspect import signature
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts.parent))
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("committee_expand", scripts / "committee-expand.py")
expand = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(expand)


class CommitteeExpansionRefresh(unittest.TestCase):
    def test_refreshes_cached_and_failed_linked_urls_once_but_skips_catalogue_urls(self):
        catalogue = {"indexes": {"senate/en/NFFN/meetings": {"links": [
            {"url": "https://sencanada.ca/en/committees/noticeofmeeting/100"},
        ]}}}
        already_refreshed = set(expand.download_urls(catalogue))
        linked_cached = "https://publications.gc.ca/collections/collection_2024/report.html"
        linked_failed = "https://sencanada.ca/en/content/sen/committee/45-1/NFFN/report-101"
        calls = []

        def capture(root, urls, workers, refresh=False):
            calls.append((list(urls), workers, refresh))

        with tempfile.TemporaryDirectory() as directory, patch.object(expand, "capture", side_effect=capture):
            checked = set()
            selected = expand.capture_new_linked_originals(Path(directory),
                [*already_refreshed, linked_cached, linked_failed, linked_cached + "#chapter"], already_refreshed, checked, 2)
            self.assertEqual(set(selected), {linked_cached, linked_failed})
            self.assertEqual(checked, {linked_cached, linked_failed})
            self.assertEqual(calls, [([linked_cached, linked_failed], 2, True)])

            self.assertEqual(expand.capture_new_linked_originals(Path(directory),
                [linked_cached, linked_failed], already_refreshed, checked, 2), [])
            self.assertEqual(len(calls), 1)

    def test_direct_expansion_keeps_refresh_disabled_by_default(self):
        self.assertFalse(signature(expand.expand).parameters["refresh_linked_originals"].default)


if __name__ == "__main__":
    unittest.main()
