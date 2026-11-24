"""Bilingual call identity must survive index reordering and ambiguous destinations."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'scripts/funding-esdc.py'
spec = importlib.util.spec_from_file_location('esdc_pairs', path)
esdc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(esdc)


def row(lang, path, title):
    return lang, {'title': title, 'url': 'https://www.canada.ca/' + path, 'group': ''}


class FundingPairs(unittest.TestCase):
    def test_uses_one_way_french_language_switch_without_inferring_another_pair(self):
        en = row('en', 'en/bursary.html', 'Bursary')
        fr = row('fr', 'fr/bourse.html', 'Bourse')
        other = row('fr', 'fr/bursary.html', 'Autre')
        html = b'<html lang="fr"><link rel="alternate" hreflang="en" href="/en/bursary.html"></html>'
        keys, gaps = esdc.edition_ids([fr, other, en], {fr[1]['url']: html})
        self.assertEqual(keys['en', 2], keys['fr', 0])
        self.assertNotEqual(keys['fr', 1], keys['en', 2])
        self.assertEqual([(g['id'], g['language']) for g in gaps], [(keys['fr', 1], 'en')])

    def test_shared_destinations_keep_order_independent_keys_and_do_not_pair_by_position(self):
        en = row('en', 'en/skills.html', '2027 skills call')
        old = row('en', 'en/skills.html', '2024 skills call')
        fr = row('fr', 'fr/formation.html', 'Formation')
        html = b'<html lang="en"><link rel="alternate" hreflang="fr" href="/fr/formation.html"></html>'
        def keys_by_title(rows):
            keys, gaps = esdc.edition_ids(rows, {en[1]['url']: html})
            self.assertEqual(len(gaps), 3)
            return {r['title']: keys[lang, i] for i, (lang, r) in enumerate(rows)}
        keys = keys_by_title([old, en, fr])
        self.assertEqual(keys, keys_by_title([fr, en, old]))
        self.assertEqual(len(set(keys.values())), 3)
