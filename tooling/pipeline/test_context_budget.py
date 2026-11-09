import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import context_budget as budget


class ContextBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / 'guide.md').write_text('One authoritative source.\n')

    def read(self, context='run-A', limit=12000, force=False, paths=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = budget.read_sources(self.root, paths or ['guide.md'], context, limit, force)
        return code, json.loads(output.getvalue()), output.getvalue()

    def test_reuse_change_and_new_context(self):
        self.assertEqual(self.read()[1]['files'][0]['status'], 'read')
        self.assertEqual(self.read()[1]['files'][0]['status'], 'unchanged')
        (self.root / 'guide.md').write_text('Changed contract.')
        self.assertEqual(self.read()[1]['files'][0]['text'], 'Changed contract.')
        self.assertEqual(self.read(context='run-B')[1]['files'][0]['status'], 'read')
        self.assertEqual(self.read(force=True)[1]['files'][0]['status'], 'read')

    def test_incomplete_output_is_never_cached_as_read(self):
        (self.root / 'guide.md').write_text('long ' * 5000)
        for _ in range(2):
            code, result, output = self.read(limit=2000)
            self.assertEqual(code, 2)
            self.assertLessEqual(len(output), 2001)
            self.assertEqual(result['files'][0]['status'], 'needs_targeted_read')
        (self.root / 'guide.md').write_text('small')
        self.assertEqual(self.read()[1]['files'][0]['status'], 'read')

    def test_corrupt_receipt_fails_instead_of_skipping(self):
        self.read()
        next((self.root / '.pipeline-local/context').glob('*.json')).write_text('broken')
        with self.assertRaises(ValueError):
            self.read()

    def test_private_missing_and_symlink_inputs_are_refused(self):
        (self.root / '.env').write_text('not a source')
        (self.root / 'link.md').symlink_to(self.root / 'guide.md')
        for name in ['../guide.md', '.env', 'link.md', 'absent.md']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.read(paths=[name])

    def test_receipt_symlink_is_refused(self):
        (self.root / '.pipeline-local').symlink_to(self.root)
        with self.assertRaises(ValueError):
            self.read()

    def test_handoff_is_complete_bounded_and_never_dispatches(self):
        p = {k: ['Explicit scoped statement.'] for k in budget.HANDOFF_FIELDS}
        p.update(issue='PIT-98', head='a' * 40, role='reviewer')
        self.assertFalse(budget.validate_handoff(p)['dispatch'])
        for key in budget.HANDOFF_FIELDS:
            invalid = {k: v for k, v in p.items() if k != key}
            with self.subTest(missing=key), self.assertRaises(ValueError):
                budget.validate_handoff(invalid)
        with self.assertRaises(ValueError):
            budget.validate_handoff({**p, 'scope': ['x' * 12000]})
        with self.assertRaises(ValueError):
            budget.validate_handoff({**p, 'head': 'main'})


if __name__ == '__main__':
    unittest.main()
