import importlib.util
from collections import Counter
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('funding_esdc', ROOT / 'scripts/funding-esdc.py')
esdc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(esdc)


class EsdcCatalogue(unittest.TestCase):
    def fixture(self, name):
        return (ROOT / 'test/fixtures/funding/esdc' / name).read_bytes()

    def test_real_index_markup_parses_representative_cards_in_both_languages(self):
        en = esdc.list_cards(self.fixture('index-en.html'), 'en')
        fr = esdc.list_cards(self.fixture('index-fr.html'), 'fr')
        self.assertEqual((len(en), len(fr)), (17, 10))
        self.assertGreaterEqual(len({row['url'] for row in en}), 10)
        self.assertGreaterEqual(len({row['url'] for row in fr}), 5)
        self.assertTrue(any(row['status'] == 'open' for row in en))
        self.assertTrue(any(row['status'] == 'ongoing' for row in en))
        self.assertTrue(any(row['status'] == 'closed' for row in en))
        self.assertTrue(any(row['status'] == 'unknown' for row in en))

    def test_shared_detail_urls_keep_distinct_calls_and_titles(self):
        rows = esdc.list_cards(self.fixture('index-en.html'), 'en')
        groups = {}
        for row in rows:
            groups.setdefault(row['url'], []).append(row)
        shared = next(items for items in groups.values() if len(items) > 1)
        self.assertGreater(len({row['title'] for row in shared}), 1)
        self.assertGreater(len({row['overview'] for row in shared}), 1)

    def test_audience_labels_are_taken_from_published_filter_markup(self):
        rows = esdc.list_cards(self.fixture('index-en.html'), 'en')
        csj = next(row for row in rows if row['title'] == 'Canada Summer Jobs')
        self.assertIn('Employers', csj['audience'])
        self.assertIn('Not-for-profit employers', csj['amount'])
        french = esdc.list_cards(self.fixture('index-fr.html'), 'fr')
        french_csj = next(row for row in french if 'Emplois d' in row['title'] and 'Canada' in row['title'])
        self.assertTrue(any('Employeurs' in value for value in french_csj['audience']))

    def test_red_seal_bonus_eligibility_and_deadlines_are_from_linked_pages(self):
        qualify = esdc.detail_sections(self.fixture('qualify-en.html'),
            'https://www.canada.ca/en/employment-social-development/services/funding/red-seal-completion-bonus/qualify.html', 'en')
        eligibility = next(section for section in qualify if section['field'] == 'eligibility')
        deadline = next(section for section in qualify if section['field'] == 'deadline')
        self.assertIn('Canadian citizen', eligibility['text'])
        self.assertIn('registered apprentice', eligibility['text'])
        self.assertIn('not be a high school student', eligibility['text'])
        self.assertIn('May 31, 2027', deadline['text'])
        self.assertIn('within 12 months', deadline['text'])
        self.assertEqual(eligibility['url'], 'https://www.canada.ca/en/employment-social-development/services/funding/red-seal-completion-bonus/qualify.html')

    def test_old_apprenticeship_grant_is_distinct_from_current_completion_bonus(self):
        rows = esdc.list_cards(self.fixture('index-en.html'), 'en')
        legacy = next(row for row in rows if row['title'] == 'Apprenticeship Completion Grant')
        bonus = next(row for row in rows if row['title'] == 'Red Seal Completion Bonus')
        self.assertEqual(legacy['status'], 'closed')
        self.assertEqual(legacy['audience'], ['Individuals'])
        self.assertIn('registered apprentices', legacy['overview'])
        self.assertEqual(bonus['status'], 'open')
        self.assertIn('journeypersons', bonus['overview'])

    def test_utip_infrastructure_has_project_specific_amounts_and_union_eligibility(self):
        detail = esdc.detail_sections(self.fixture('utip-en.html'),
            'https://www.canada.ca/en/employment-social-development/services/funding/utip-infrastructure-expansion.html','en')
        amount = next(section for section in detail if section['field']=='amount')
        eligibility = next(section for section in detail if section['field']=='eligibility')
        self.assertIn('$3M', amount['text'])
        self.assertIn('$10M', amount['text'])
        self.assertIn('renovation', amount['text'])
        self.assertIn('new construction', amount['text'])
        self.assertIn('Unions representing workers in the Red Seal trades',eligibility['text'])
        self.assertIn('training trust funds',eligibility['text'])
        self.assertIn('November 12, 2026', next(section for section in detail if section['field']=='status')['text'])

    def test_collect_fetches_all_distinct_details_and_cites_index_facts(self):
        en = self.fixture('index-en.html')
        fr = self.fixture('index-fr.html')
        fetched = []
        def fake_fetch(url):
            fetched.append(url)
            if url == esdc.EN: return en
            if url == esdc.FR: return fr
            return b'<main><h1 id="wb-cont">Program information</h1><h2>Eligibility requirements</h2><p>Published applicant criteria.</p></main>'
        packet = esdc.collect(fake_fetch)
        self.assertEqual(len(packet['records']), 27)
        self.assertEqual(packet['indexes'], {'en':esdc.EN,'fr':esdc.FR})
        self.assertEqual(len(fetched), 2 + len({row['url'] for lang in ('en','fr') for row in esdc.list_cards(en if lang=='en' else fr,lang)}))
        for row in packet['records']:
            index = esdc.INDEXES[row['language']]
            index_sections = [section for section in row['sections'] if section['url'] == index]
            self.assertTrue(index_sections)
        shared = Counter(row['url'] for row in packet['records'] if row['language']=='en')
        duplicate_url = next(url for url,count in shared.items() if count > 1)
        self.assertGreater(sum(row['url']==duplicate_url for row in packet['records'] if row['language']=='en'),1)

    def test_calls_sharing_a_detail_page_do_not_inherit_ambiguous_newer_terms(self):
        en,fr=self.fixture('index-en.html'),self.fixture('index-fr.html')
        shared='https://www.canada.ca/en/employment-social-development/services/funding/accessible-grants-accessability-week.html'
        def fake_fetch(url):
            if url==esdc.EN:return en
            if url==esdc.FR:return fr
            if url==shared:
                return b'<html lang="en"><main><h1 id="wb-cont">Newer 2027 call</h1><h2>Eligibility requirements</h2><p>Newer call only terms.</p></main></html>'
            return b'<html lang="en"><main><h1 id="wb-cont">Program detail</h1><p>Published detail.</p></main></html>'
        packet=esdc.collect(fake_fetch)
        calls=[r for r in packet['records'] if r['language']=='en' and r['url']==shared]
        self.assertEqual(len(calls),2)
        self.assertTrue(all(r['availability']=='metadata-only' for r in calls))
        self.assertTrue(all('Newer call only terms.' not in ' '.join(s['text'] for s in r['sections']) for r in calls))
        self.assertTrue(all(any(g['id']==r['id'] and 'multiple-published-calls' in g['reason'] for g in packet['gaps']) for r in calls))

    def test_language_switch_uses_publisher_alternate_urls(self):
        url = 'https://www.canada.ca/en/employment-social-development/services/funding/red-seal-completion-bonus.html'
        alts = esdc.language_alternates(self.fixture('bonus-en.html'),url)
        self.assertEqual(alts['en'],url)
        self.assertEqual(alts['fr'],'https://www.canada.ca/fr/emploi-developpement-social/services/financement/prime-reussite-sceau-rouge.html')

    def test_mismatched_language_pages_are_not_used_as_record_text(self):
        english = b'<html lang="en"><main><h1 id="wb-cont">Title</h1><h2>Eligibility</h2><p>English only.</p></main></html>'
        self.assertEqual(esdc.content_language(english),'en')
        self.assertEqual(esdc.detail_sections(english,'https://www.canada.ca/en/example.html','fr'),[])


if __name__ == '__main__':
    unittest.main()
