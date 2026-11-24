import unittest

from scripts.lib.wq_catalog import clean_question_text, reusable_detail, tree


class TreeTextOrderTests(unittest.TestCase):
    def test_preserves_text_before_inside_and_after_inline_markup(self):
        root = tree("<p>before <em>inside</em> after <strong>last</strong> tail</p>")
        paragraph = root.find(lambda node: node.tag == "p")
        self.assertEqual(paragraph.text(), "before inside after last tail")

    def test_removes_only_trailing_publisher_controls(self):
        cleaned, removed = clean_question_text("Real question? Show more Show less", "en")
        self.assertEqual(cleaned, "Real question?")
        self.assertTrue(removed)

    def test_removes_french_controls_and_keeps_question_words(self):
        cleaned, removed = clean_question_text("Question sur le voir plus tard. Voir plus Voir moins", "fr")
        self.assertEqual(cleaned, "Question sur le voir plus tard.")
        self.assertTrue(removed)

    def test_force_recheck_fetches_same_status_for_late_response_metadata(self):
        listing = {"sourceId": 7, "status": "answered", "statusLabel": "Answered",
                   "askedBy": {"personId": 3}, "dateAsked": "May 1, 2025", "responseDue": None, "topics": []}
        previous = {**listing, "text": "Old question", "responses": [{"id": "old-response", "type": "viewer",
                    "responseId": "old-response", "url": "https://example.test/response"}],
                    "responseInventoryChecked": True, "detailFetchedAt": "2026-11-23T00:00:00+00:00"}
        self.assertIsNotNone(reusable_detail({**listing, "text": "Current question"}, previous))
        self.assertIsNone(reusable_detail({**listing, "text": "Current question"}, previous, force=True))

    def test_refreshes_listing_topics_without_refetching_unchanged_detail(self):
        current = {"sourceId": 9, "status": "answered", "statusLabel": "Answered",
                   "askedBy": {"personId": 3}, "dateAsked": "May 1, 2025", "responseDue": None,
                   "topics": ["Current topic"], "text": "Current question"}
        previous = {**current, "topics": ["Detail topic"], "responses": [],
                    "responseInventoryChecked": True, "detailFetchedAt": "2026-11-23T00:00:00+00:00"}
        reused = reusable_detail(current, previous)
        self.assertIsNotNone(reused)
        self.assertEqual(reused["topics"], ["Current topic"])


if __name__ == "__main__":
    unittest.main()
