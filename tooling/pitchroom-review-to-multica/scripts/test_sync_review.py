import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
import sync_review as s

REPORT = '# Review\n## Clarify\nKeep the current topic.\n| CLR-02 · Useful questions | Partial |\n'


def proposal():
    return {'schema_version': 1, 'scope': 'v6-local-core', 'review_path': '/review.md', 'review_sha256': hashlib.sha256(REPORT.encode()).hexdigest(), 'tasks': [{'key': 'clarify-topic', 'title': 'Keep the selected topic', 'outcome': 'Resume the question', 'scope': 'Topic selection', 'non_goals': ['Deployment'], 'references': [{'heading': '## Clarify', 'quote': 'Keep the current topic.'}], 'depends_on': [], 'acceptance': [{'kind': 'browser', 'scenario': 'return from materials', 'expected': 'same topic and draft'}]}], 'coverage': [{'id': 'CLR-02', 'disposition': 'task', 'task_keys': ['clarify-topic'], 'reason': 'Remaining gap'}]}


def issue():
    return {'id': 'one', 'identifier': 'PIT-1', 'project_id': s.TARGET['project'], 'title': 'Keep the selected topic', 'description': 'Human notes stay here.', 'status': 'backlog', 'assignee_id': None, 'assignee_type': None, 'parent_issue_id': None, 'stage': None, 'priority': 'medium'}


class FakeCLI:
    def __init__(self, rows=()):
        self.rows = {row['id']: copy.deepcopy(row) for row in rows}
        self.writes = []
        self.timeout_create = False
        self.history = {}

    def issues(self):
        return copy.deepcopy(list(self.rows.values()))

    def get(self, key):
        return copy.deepcopy(self.rows[key])

    def raw(self, args):
        assert args[:2] == ['issue', 'update'] and '--no-start' in args
        self.writes.append(args)
        self.rows[args[2]]['description'] = Path(args[args.index('--description-file') + 1]).read_text()
        if '--priority' in args:
            self.rows[args[2]]['priority'] = args[args.index('--priority') + 1]
        return ''

    def call(self, args):
        if args[:2] == ['issue', 'runs']:
            return self.history.get(args[2], [])
        assert args[:2] == ['issue', 'create']
        assert '--assignee' not in args and args[args.index('--status') + 1] == 'backlog'
        row = issue()
        row['id'] = 'created'
        row['title'] = args[args.index('--title') + 1]
        row['description'] = Path(args[args.index('--description-file') + 1]).read_text()
        self.rows['created'] = row
        self.writes.append(args)
        if self.timeout_create:
            raise RuntimeError('Connection lost after remote creation')
        return row


class SyncTests(unittest.TestCase):
    def test_preview_is_read_only_and_preserves_human_notes(self):
        cli = FakeCLI([issue()])
        plan = s.preview(proposal(), REPORT, cli.issues())
        self.assertEqual(cli.writes, [])
        self.assertEqual(plan['payload']['operations'][0]['kind'], 'update')
        self.assertTrue(plan['payload']['operations'][0]['description'].startswith('Human notes stay here.'))

    def test_matching_and_second_preview_are_idempotent(self):
        row = issue()
        first = s.preview(proposal(), REPORT, [row])
        row['description'] = first['payload']['operations'][0]['description']
        self.assertEqual(s.preview(proposal(), REPORT, [row])['payload']['operations'][0]['kind'], 'unchanged')

    def test_ambiguous_duplicates_are_rejected(self):
        other = {**issue(), 'id': 'two', 'identifier': 'PIT-2'}
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            s.preview(proposal(), REPORT, [issue(), other])

    def test_assigned_and_terminal_changes_are_conflicts(self):
        for change in [{'assignee_id': 'agent'}, {'status': 'done'}]:
            self.assertEqual(s.preview(proposal(), REPORT, [{**issue(), **change}])['payload']['operations'][0]['kind'], 'conflict')

    def test_source_and_coverage_and_dependency_validation(self):
        bad = proposal()
        bad['coverage'] = []
        with self.assertRaisesRegex(ValueError, 'dispositions missing'):
            s.preview(bad, REPORT, [])
        bad = proposal()
        bad['tasks'][0]['references'][0]['quote'] = 'invented'
        with self.assertRaisesRegex(ValueError, 'not present'):
            s.preview(bad, REPORT, [])
        bad = proposal()
        bad['tasks'][0]['depends_on'] = ['clarify-topic']
        with self.assertRaisesRegex(ValueError, 'cycle'):
            s.preview(bad, REPORT, [])

    def test_wrong_approval_tampered_preview_and_changed_report_never_write(self):
        cli = FakeCLI([issue()])
        plan = s.preview(proposal(), REPORT, cli.issues())
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            journal = Path(directory) / 'journal.json'
            with self.assertRaisesRegex(ValueError, 'approval'):
                s.apply(plan, 'not-approved', REPORT, cli, journal)
            tampered = copy.deepcopy(plan)
            tampered['payload']['operations'][0]['description'] = 'arbitrary'
            with self.assertRaisesRegex(ValueError, 'approval'):
                s.apply(tampered, plan['sha256'], REPORT, cli, journal)
            with self.assertRaisesRegex(ValueError, 'Review changed'):
                s.apply(plan, plan['sha256'], REPORT + 'changed', cli, journal)
        self.assertEqual(cli.writes, [])

    def test_stale_issue_aborts_before_write(self):
        cli = FakeCLI([issue()])
        plan = s.preview(proposal(), REPORT, cli.issues())
        cli.rows['one']['description'] += '\nNew human edit'
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            with self.assertRaisesRegex(ValueError, 'changed after preview'):
                s.apply(plan, plan['sha256'], REPORT, cli, Path(directory) / 'journal.json')
        self.assertEqual(cli.writes, [])

    def test_update_retains_notes_and_ownership_and_replay_is_noop(self):
        cli = FakeCLI([issue()])
        plan = s.preview(proposal(), REPORT, cli.issues())
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            journal = Path(directory) / 'journal.json'
            s.apply(plan, plan['sha256'], REPORT, cli, journal)
            s.apply(plan, plan['sha256'], REPORT, cli, journal)
        self.assertEqual(len(cli.writes), 1)
        self.assertEqual(cli.rows['one']['priority'], 'medium')
        self.assertEqual(cli.rows['one']['status'], 'backlog')
        self.assertIsNone(cli.rows['one']['assignee_id'])
        self.assertTrue(cli.rows['one']['description'].startswith('Human notes stay here.'))

    def test_create_has_no_assignment_and_no_second_create(self):
        cli = FakeCLI()
        plan = s.preview(proposal(), REPORT, cli.issues())
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            journal = Path(directory) / 'journal.json'
            s.apply(plan, plan['sha256'], REPORT, cli, journal)
            s.apply(plan, plan['sha256'], REPORT, cli, journal)
        self.assertEqual(len(cli.writes), 1)
        self.assertEqual(s.preview(proposal(), REPORT, cli.issues())['payload']['operations'][0]['kind'], 'unchanged')

    def test_unknown_create_outcome_stops_retries(self):
        cli = FakeCLI()
        cli.timeout_create = True
        plan = s.preview(proposal(), REPORT, [])
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            journal = Path(directory) / 'journal.json'
            with self.assertRaises(RuntimeError):
                s.apply(plan, plan['sha256'], REPORT, cli, journal)
            with self.assertRaisesRegex(ValueError, 'uncertain'):
                s.apply(plan, plan['sha256'], REPORT, cli, journal)
        self.assertEqual(len(cli.writes), 1)

    def test_missing_explicit_match_cannot_fall_back_to_title_or_create(self):
        draft = proposal()
        draft['tasks'][0]['match_issue'] = 'PIT-999'
        for rows in [[], [issue()]]:
            with self.assertRaisesRegex(ValueError, 'Explicit match'):
                s.preview(draft, REPORT, rows)

    def test_two_new_tasks_cannot_share_a_normalized_title(self):
        draft = proposal()
        other = copy.deepcopy(draft['tasks'][0])
        other['key'] = 'other-capability'
        draft['tasks'].append(other)
        with self.assertRaisesRegex(ValueError, 'Duplicate normalized'):
            s.preview(draft, REPORT, [])

    def test_reversed_markers_never_duplicate_human_content(self):
        row = issue()
        start, end = s.marker('clarify-topic')
        row['description'] = end + '\nHuman content\n' + start
        with self.assertRaisesRegex(ValueError, 'Malformed'):
            s.preview(proposal(), REPORT, [row])

    def test_historical_runs_are_preserved_and_new_history_blocks_write(self):
        cli = FakeCLI([issue()])
        cli.history['one'] = [{'id': 'old-run', 'status': 'completed'}]
        plan = s.preview(proposal(), REPORT, cli.issues(), cli.history)
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            s.apply(plan, plan['sha256'], REPORT, cli, Path(directory) / 'journal.json')
        self.assertEqual(len(cli.writes), 1)
        fresh = s.preview(proposal(), REPORT, [issue()], cli.history)
        cli.rows['one'] = issue()
        cli.history['one'].append({'id': 'new-run', 'status': 'queued'})
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            with self.assertRaisesRegex(ValueError, 'Execution history changed'):
                s.apply(fresh, fresh['sha256'], REPORT, cli, Path(directory) / 'journal.json')
        self.assertEqual(len(cli.writes), 1)

    def test_new_duplicate_after_preview_blocks_create(self):
        cli = FakeCLI()
        plan = s.preview(proposal(), REPORT, [])
        cli.rows['one'] = issue()
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            with self.assertRaisesRegex(ValueError, 'duplicate appeared'):
                s.apply(plan, plan['sha256'], REPORT, cli, Path(directory) / 'journal.json')
        self.assertEqual(cli.writes, [])


if __name__ == '__main__':
    unittest.main()
