"""Verify replay commands are tied to the acquisition from the same occurrence."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/institution-coverage/container'))
import run as runner  # noqa: E402


class InstitutionCoverageRunner(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / 'scripts').mkdir()
        self.log = self.root / 'producer.log'
        self.commands = (('publisher.py', 'refresh'), ('publisher.py', 'replay', '@runId'))

    def fixture(self, receipt, replay_args=('fresh-run',)):
        (self.root / 'scripts/publisher.py').write_text(
            'import sys\n'
            'if sys.argv[1] == "refresh":\n'
            '    print("Publisher reported a partial result", file=sys.stderr)\n'
            f'    print({receipt!r})\n'
            '    sys.exit(2)\n'
            f'assert sys.argv[2:] == {list(replay_args)!r}\n'
            'print("Replayed fresh-run")\n'
        )

    def test_partial_acquisition_replays_its_own_run(self):
        self.fixture('{"runId":"fresh-run"}')
        with patch.object(runner, 'ROOT', self.root):
            self.assertEqual(runner.run_producer(self.commands, 10, self.log), [2, 0])
        self.assertIn('Publisher reported a partial result', self.log.read_text())
        self.assertIn('Replayed fresh-run', self.log.read_text())

    def test_invalid_receipt_cannot_replay_an_older_generation(self):
        self.fixture('{"runId":"../older-run"}')
        with patch.object(runner, 'ROOT', self.root):
            self.assertEqual(runner.run_producer(self.commands, 10, self.log), [2, 1])
        self.assertIn('did not return a valid runId to replay', self.log.read_text())
        self.assertNotIn('Replayed fresh-run', self.log.read_text())

    def test_partial_policy_archive_replays_the_exact_report_and_keeps_its_exit_status(self):
        digest = '6' * 64
        self.fixture(f'{{"reportSha256":"{digest}"}}', ('--report', digest))
        commands = (('publisher.py', 'refresh'), ('publisher.py', 'replay', '--report', '@reportSha256'))
        with patch.object(runner, 'ROOT', self.root):
            self.assertEqual(runner.run_producer(commands, 10, self.log), [2, 0])
