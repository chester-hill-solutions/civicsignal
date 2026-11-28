"""Verify the Senate directory publisher contract and archive replay."""

import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("committee_senate", ROOT / "services/committee-senate/run.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


def directory_html(language, code="AEFA"):
    path = "en/committees" if language == "en" else "fr/comites"
    title = "Foreign Affairs" if language == "en" else "Affaires étrangères"
    return (
        f'<a class="sc-committee-list-item" id="{code.lower()}" href="/{path}/{code.lower()}/45-1">'
        f'<span class="sc-committee-list-item-name">{title}</span></a>'
    ).encode()


class SenateCommitteeDirectory(unittest.TestCase):
    def test_shared_parser_preserves_the_weekly_catalogue_input_and_result(self):
        catalogue = discovery.CATALOGUE
        for language in discovery.LANGUAGES:
            with self.subTest(language=language):
                src = catalogue["senate_directory_url"](language)
                original = directory_html(language)
                facts = discovery.records(original, language)
                with patch.dict(catalogue["directories"].__globals__, {"get": lambda _: original.decode()}):
                    self.assertEqual(catalogue["directories"]("senate", language), facts)
                self.assertEqual([(row["code"], row["directory"]) for row in facts], [("AEFA", src)])
                self.assertIn("étrangères" if language == "fr" else "Foreign", facts[0]["name"])

    def test_complete_acquisition_has_exactly_two_sources_and_replays(self):
        with TemporaryDirectory() as scratch:
            root = Path(scratch) / "directory"
            with patch.object(discovery, "fetch_directory", side_effect=directory_html) as fetch:
                receipt = discovery.acquire(root)
            self.assertEqual([call.args for call in fetch.call_args_list], [("en",), ("fr",)])
            self.assertEqual(receipt, discovery.verify_directory(root))
            self.assertEqual(receipt["sources"]["fr"]["committees"], 1)
            self.assertEqual(receipt["sources"]["en"]["sha256"], discovery.digest(directory_html("en")))
            (root / "fr.html").write_bytes(directory_html("fr") + b"\n")
            with self.assertRaisesRegex(ValueError, "differs from the archived"):
                discovery.verify_directory(root)

    def test_cross_language_mismatch_refuses_publication(self):
        with self.assertRaisesRegex(ValueError, "codes differ"):
            discovery.directory_document({"en": directory_html("en"), "fr": directory_html("fr", "AGFO")})

    def test_error_and_duplicate_directory_responses_are_rejected(self):
        for body in (b"<html>Not the committee directory</html>", 2 * directory_html("en")):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "Invalid or duplicate"):
                discovery.records(body, "en")


if __name__ == "__main__":
    unittest.main()
