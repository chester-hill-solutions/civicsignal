from contextlib import chdir, closing
import gzip
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("federal_report_directories", ROOT / "scripts/federal-report-directories.py")
directory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(directory)
EDITIONS_SPEC = importlib.util.spec_from_file_location("editions", ROOT / "scripts/departmental-report-editions.py")
editions = importlib.util.module_from_spec(EDITIONS_SPEC)
EDITIONS_SPEC.loader.exec_module(editions)


class FederalReportDirectoryTests(unittest.TestCase):
    def test_only_verified_labelled_links_inside_institution_directory_are_kept(self):
        html = b"""<nav><a href='/nav'>Navigation label</a></nav><main>
        <h1>Departmental Plans</h1><a href='https://www.canada.ca/en/old'>Old archive</a>
        <h2>List of institutions</h2><ul><li><a href='https://agriculture.canada.ca/en/plan'>Agriculture and Agri-Food Canada</a></li>
        <li><a href='https://example.com/not-official'>Outside issuer</a></li><li><a href='#A'>A</a></li>
        <li><a href='https://www.canada.ca/en/report'>Unlabelled <span></span></a></li></ul>
        <h2>Related links</h2><ul><li><a href='https://www.canada.ca/en/related'>Related page</a></li></ul></main>"""
        parser = directory.PageLinks("https://www.canada.ca/en/index")
        parser.feed(html.decode())
        links = directory.verified_labelled_links(parser)
        self.assertEqual([(item["label"], item["url"]) for item in links], [
            ("Agriculture and Agri-Food Canada", "https://agriculture.canada.ca/en/plan"),
            ("Unlabelled", "https://www.canada.ca/en/report"),
        ])

    def test_french_institution_heading_and_language_selector_are_supported(self):
        html = b"""<main><a href='https://www.canada.ca/en/index'>English en</a>
        <h2>Liste des institutions</h2><ul><li><a href='https://agriculture.canada.ca/fr/plan'>Agriculture et Agroalimentaire Canada</a></li></ul></main>"""
        parser = directory.PageLinks("https://www.canada.ca/fr/index")
        parser.feed(html.decode())
        self.assertEqual(directory.language_url_from_links(parser), "https://www.canada.ca/en/index")
        self.assertEqual(directory.verified_labelled_links(parser)[0]["label"], "Agriculture et Agroalimentaire Canada")

    def test_localized_footer_heading_ends_the_institution_directory(self):
        html = """<main><h2>Liste des institutions</h2><ul><li><a href='https://agency.gc.ca/fr'>Organisme fédéral</a></li></ul>
        <h2>Détails de la page</h2><ul><li><a href='https://www.canada.ca/fr/services/finance.html'>Argent et finances</a></li></ul></main>""".encode()
        parser = directory.PageLinks("https://www.canada.ca/fr/index")
        parser.feed(html.decode())
        self.assertEqual([x["label"] for x in directory.verified_labelled_links(parser)], ["Organisme fédéral"])

    def test_government_wide_directory_preserves_published_urls_only_in_letter_sections(self):
        parser = directory.RegulatorDirectoryLinks("https://www.canada.ca/en/index.html")
        parser.feed("""<main><ul><li><a href="/preface">Introduction</a></li></ul>
          <section><h3>Institutions starting with the letter A</h3>
          <ul><li><a href="https://authority.example/">Authority</a>
          <ul><li><a href="http://board.gc.ca/acts">Appeals Board</a></li></ul></li></ul>
          <a href="#top">Top</a></section>
          <section><h3>Les institutions débutant par la lettre B</h3><ul>
          <li><a href="/fr/b">Bureau</a></li></ul></section></main>
          <footer><ul><li><a href="/privacy">Privacy</a></li></ul></footer>""")
        self.assertEqual([(item["label"], item["url"]) for item in parser.directory_links], [
            ("Authority", "https://authority.example/"), ("Appeals Board", "http://board.gc.ca/acts"),
            ("Bureau", "https://www.canada.ca/fr/b")])

    def test_current_regulatory_cycles_are_selected_per_family_and_language(self):
        html = b"""<main><a href='https://www.canada.ca/en/old'>Forward Regulatory Plan: 2025 to 2027</a>
        <a href='https://www.canada.ca/en/current'>Forward Regulatory Plan: 2026 to 2028</a>
        <a href='https://www.canada.ca/en/stock'>Regulatory Stock Review Plan: 2026 to 2036</a>
        <a href='http://example.ca/not-https'>Forward Regulatory Plan: 2027 to 2029</a></main>"""
        parser = directory.PageLinks("https://www.canada.ca/en/index")
        parser.feed(html.decode())
        selected = directory.current_regulatory_links(parser, "en")
        self.assertEqual([(item["cycleFamily"], item["cycle"], item["url"]) for item in selected], [
            ("forward-regulatory-plan", "2026-2028", "https://www.canada.ca/en/current"),
            ("regulatory-stock-review", "2026-2036", "https://www.canada.ca/en/stock"),
        ])

    def test_current_french_stock_review_label_is_detected(self):
        html = "<a href='https://www.canada.ca/fr/current'>Plan d’examen de l’inventaire des règlements de 2026 à 2036</a>".encode()
        parser = directory.PageLinks("https://www.canada.ca/fr/index")
        parser.feed(html.decode())
        selected = directory.current_regulatory_links(parser, "fr")
        self.assertEqual([(item["cycleFamily"], item["cycle"]) for item in selected], [
            ("regulatory-stock-review", "2026-2036")
        ])

    def test_bilingual_grouping_keeps_explicit_edition_links(self):
        entries = [
            {"issuerKey":"roster-I-1", "issuerLabel":"Department A", "language":"en", "url":"https://a/en"},
            {"issuerKey":"roster-I-1", "issuerLabel":"Ministère A", "language":"fr", "url":"https://a/fr"},
        ]
        grouped = directory._pair_bilingual(entries)
        self.assertEqual(len(grouped), 1)
        self.assertTrue(grouped[0]["bilingualMatch"])
        self.assertEqual([edition["url"] for edition in grouped[0]["editions"]], ["https://a/en", "https://a/fr"])

    def test_regulatory_cycle_coverage_exposes_language_mismatch(self):
        summary = directory.cycle_coverage([
            {"language":"en", "cycleFamily":"forward-regulatory-plan", "cycle":"2026-2028"},
            {"language":"fr", "cycleFamily":"forward-regulatory-plan", "cycle":"2026-2028"},
            {"language":"en", "cycleFamily":"regulatory-stock-review", "cycle":"2025-2035"},
            {"language":"fr", "cycleFamily":"regulatory-stock-review", "cycle":"2026-2036"},
        ])
        self.assertEqual(summary["currentCycles"], 3)
        self.assertEqual(summary["bilingualCurrentCycles"], 1)
        self.assertEqual(summary["englishOnlyCycles"], [{"family":"regulatory-stock-review", "cycle":"2025-2035"}])
        self.assertEqual(summary["frenchOnlyCycles"], [{"family":"regulatory-stock-review", "cycle":"2026-2036"}])

    def test_content_source_reference_keeps_hash_without_volatile_capture_time(self):
        source = {"url":"https://www.canada.ca/index", "finalUrl":"https://www.canada.ca/index",
                  "sha256":"digest", "bytes":123, "observedAt":"volatile", "archive":"objects/digest.gz",
                  "body":b"not serialized"}
        self.assertEqual(directory.source_ref(source), {
            "url":"https://www.canada.ca/index", "finalUrl":"https://www.canada.ca/index",
            "sha256":"digest", "bytes":123, "archive":"objects/digest.gz",
        })

    def test_hosted_origins_are_read_only_and_only_linked_indexes_are_fetched(self):
        registered = directory._read_register(directory.REGISTER)
        pinned_stamp, fresh_stamp = "2026-11-28T14:00:30+00:00", "2026-11-28T16:00:30+00:00"
        registered_urls = [registered[family]["entry_url"] for family in directory.FAMILIES]
        french_urls = {family: f"https://www.canada.ca/fr/{family}.html" for family in directory.FAMILIES}
        wide_urls = ["https://www.canada.ca/en/wide.html", "https://www.canada.ca/fr/wide.html"]
        bodies = {}
        for family, url in zip(directory.FAMILIES, registered_urls):
            switch = f'<a href="{french_urls[family]}">Français</a>'
            if family == "regulatory-plans":
                bodies[url] = (switch + f'<a href="{wide_urls[0]}">Government-wide regulatory plans and reports</a>'
                               '<a href="/en/current">Forward Regulatory Plan: 2026 to 2028</a>')
                bodies[french_urls[family]] = (f'<a href="{wide_urls[1]}">Plans et rapports prospectifs à l’échelle du gouvernement</a>'
                                              '<a href="/fr/current">Plan prospectif de la réglementation de 2026 à 2028</a>')
            else:
                bodies[url] = switch + '<h2>List of institutions</h2><ul><li><a href="/en/plan">Issuer</a></li></ul>'
                bodies[french_urls[family]] = '<h2>Liste des institutions</h2><ul><li><a href="/fr/plan">Organisme</a></li></ul>'
        for url in wide_urls:
            bodies[url] = '<main><h3>Institutions starting with the letter A</h3><ul><li><a href="/plan">Issuer</a></li></ul></main>'

        def archive(cache, url, stamp):
            raw = bodies[url].encode()
            digest = sha256(raw).hexdigest()
            path = directory.committee_files.object_path(cache, digest)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(gzip.compress(raw, mtime=0))
            return {"url": url, "finalUrl": url, "observedAt": stamp, "sha256": digest, "bytes": len(raw),
                    "key": f"weekly/federal-discovery/sources/{digest}.html"}

        def capture(cache, urls, *, workers, refresh):
            self.assertTrue(refresh)
            rows = [archive(cache, url, fresh_stamp) for url in urls]
            with closing(directory.committee_files.cache_db(cache)) as db:
                directory.committee_files.checkpoint(db, [(row["url"], row["sha256"], "text/html", row["bytes"], None,
                                                           row["observedAt"], row["finalUrl"]) for row in rows])

        with tempfile.TemporaryDirectory() as temporary, patch.object(directory.committee_files, "capture", side_effect=capture) as fetched:
            workspace = Path(temporary).resolve()
            cache = workspace / "inputs"
            origins = {family: archive(cache, url, pinned_stamp) for family, url in zip(directory.FAMILIES, registered_urls)}
            manifest = cache / "report-directory-origins.json"
            discovery = {"key": "weekly/federal-discovery/runs/federal-discovery-1795874400000.json"}
            manifest.write_text(json.dumps({"schemaVersion": 1, "registerSha256": sha256(directory.REGISTER.read_bytes()).hexdigest(),
                                            "discovery": discovery, "origins": origins}))
            output = workspace / "directories"
            output.mkdir()
            with patch.object(directory, "ROOT", workspace):
                result = directory.build(output, hosted_origins=manifest)
                self.assertEqual([call.args[1] for call in fetched.call_args_list], [sorted(french_urls.values()), wide_urls])
                for family in directory.FAMILIES:
                    source = result["sourceArchives"][f"{family}-en"]
                    self.assertEqual(source["sha256"], origins[family]["sha256"])
                    self.assertEqual(result["receipt"]["sourceCaptureTimes"][f"{family}-en"], pinned_stamp)
                    self.assertEqual(result["receipt"]["sourceCaptureTimes"][f"{family}-fr"], fresh_stamp)
                    self.assertTrue((workspace / source["archive"]).is_file())
                    self.assertFalse(Path(source["archive"]).is_absolute())
                self.assertEqual(result["receipt"]["hostedOrigins"], {"discovery": discovery, "origins": origins})
                with chdir(workspace), patch.object(editions, "ROOT", workspace):
                    _, replayed = editions.load_verified_inventory(output / "dist/receipt.json")
                    self.assertEqual(replayed["sourceArchives"], result["sourceArchives"])
                fetched.reset_mock()
                local = directory.build(output)
                self.assertEqual(fetched.call_args_list[0].args[1], registered_urls)
                self.assertNotIn("hostedOrigins", local["receipt"])


if __name__ == "__main__":
    unittest.main()
