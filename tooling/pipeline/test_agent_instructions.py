import hashlib
import unittest

from agent_instructions import clean, remove_note


class InstructionCleanupTests(unittest.TestCase):
    def setUp(self):
        self.note = "## Temporary QA\nTask-specific scope.\n"
        self.persistent = "## QA pstack entry\nLoad local skills.\n"
        self.current = "Existing policy.\n" + self.note + self.persistent

    def test_cleanup_preserves_concurrent_policy_and_other_temporary_sections(self):
        current = self.current + "## Other operator note\nRetain this.\n"
        self.assertEqual(remove_note(current, self.note),
                         "Existing policy.\n" + self.persistent + "## Other operator note\nRetain this.\n")

    def test_changed_missing_duplicate_and_partial_notes_refuse(self):
        for current, note in [(self.current.replace("scope", "changed"), self.note),
                              (self.persistent, self.note),
                              (self.current + self.note, self.note),
                              (self.current, "## Temporary QA\n"),
                              (self.current, "Existing policy.\n" + self.note)]:
            with self.subTest(current=current, note=note), self.assertRaises(ValueError):
                remove_note(current, note)

    def test_stale_snapshot_refused_without_write(self):
        calls = []
        def call(args):
            calls.append(args)
            return {"instructions": self.current, "status": "idle"}
        with self.assertRaises(ValueError):
            clean("qa", self.note, hashlib.sha256(b"Old snapshot").hexdigest(), True, call)
        self.assertFalse(any("update" in args for args in calls))

    def test_inline_hash_continuation_refuses_without_write(self):
        note = "## Temporary QA\nOwned instruction."
        for continuation in ["## inline continuation\n", " ## inline continuation\n",
                             "\t## inline continuation\n"]:
            with self.subTest(continuation=continuation):
                current = note + continuation + self.persistent
                calls = []
                def call(args):
                    nonlocal current
                    calls.append(args)
                    if "update" in args:
                        current = args[-1]
                    return {"instructions": current, "status": "idle"}
                with self.assertRaises(ValueError):
                    clean("qa", note, hashlib.sha256(current.encode()).hexdigest(), True, call)
                self.assertFalse(any("update" in args for args in calls))

    def test_real_line_boundaries_preserve_following_policy(self):
        note = "## Temporary QA\nOwned instruction."
        for ending, separator in [("", "\n"), ("\n", ""), ("", "\r\n"),
                                  ("\r\n", ""), ("", " \n\t\n")]:
            with self.subTest(ending=ending, separator=separator):
                owned = note + ending
                self.assertEqual(remove_note(owned + separator + self.persistent, owned),
                                 separator + self.persistent)

    def test_indented_hashes_are_not_a_following_section(self):
        current = self.note + "    ## code or continuation\n" + self.persistent
        with self.assertRaises(ValueError):
            remove_note(current, self.note)

    def test_change_between_reads_or_active_agent_refuses_without_write(self):
        for later in [{"instructions": self.current + "New policy", "status": "idle"},
                      {"instructions": self.current, "status": "working"}]:
            calls = []
            def call(args):
                calls.append(args)
                return {"instructions": self.current, "status": "idle"} if len(calls) == 1 else later
            with self.assertRaises(ValueError):
                clean("qa", self.note, hashlib.sha256(self.current.encode()).hexdigest(), True, call)
            self.assertFalse(any("update" in args for args in calls))

    def test_success_only_updates_instructions_and_verifies_readback(self):
        calls = []
        result = self.current
        def call(args):
            nonlocal result
            calls.append(args)
            if "update" in args:
                result = args[-1]
            return {"instructions": result, "status": "idle", "skills": ["bridge"]}
        self.assertTrue(clean("qa", self.note, hashlib.sha256(self.current.encode()).hexdigest(), True, call)["applied"])
        self.assertIn(self.persistent, result)
        self.assertEqual([a for a in calls if "update" in a],
                         [["agent", "update", "qa", "--instructions", "Existing policy.\n" + self.persistent]])

    def test_uncertain_write_stops_without_retry(self):
        calls = []
        def call(args):
            calls.append(args)
            return {"instructions": self.current, "status": "idle"}
        with self.assertRaises(RuntimeError):
            clean("qa", self.note, hashlib.sha256(self.current.encode()).hexdigest(), True, call)
        self.assertEqual(sum("update" in a for a in calls), 1)


if __name__ == "__main__":
    unittest.main()
