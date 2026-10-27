import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from acceptance import AcceptanceError, IDENTITY, contract_digest, evaluate_proof, validate_contract, validate_completion


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "checks").mkdir()
        (self.root / "logs").mkdir()
        self.description = hashlib.sha256(b"Every original acceptance criterion").hexdigest()
        self.contract = {
            "schema_version": 1, "engineering": True,
            "description_sha256": self.description, "decisions": [],
            "criteria": [{"id": "recovery", "text": "Exact saved page survives restart", "kind": "engineering", "required": True, "check_ids": ["browser_restart"]}],
            "checks": {"browser_restart": {"argv": ["node", "checks/restart.cjs"], "cwd": ".", "proof": {"kind": "json", "pointer": "/assertions/restart", "equals": True}}},
        }
        self.artifact = {"issue": "PIT-22", "generation": 1,
                         "commit": "a" * 40, "tree": "b" * 40,
                         "description_sha256": self.description,
                         "contract_sha256": contract_digest(self.contract),
                         "actors": {"developer": "actor-dev", "reviewer": "actor-review", "qa": "actor-qa"}}
        self.reports = []
        for role, actor in self.artifact["actors"].items():
            self.reports.append({**{k: self.artifact[k] for k in IDENTITY},
                                 "role": role, "actor_id": actor, "run_id": "run-" + role,
                                 "dirty": False, "gaps": [], "decisions": [],
                                 "criterion_results": [{"id": "recovery", "status": "pass"}]})
        self.reports[1]["complete_contract_review"] = True
        self.log(b'{"assertions":{"restart":true}}\n')
        self.check = {**{k: self.artifact[k] for k in IDENTITY},
                      "schema_version": 1, "producer": "controller", "check_id": "browser_restart",
                      "argv": ["node", "checks/restart.cjs"], "cwd": ".", "exit_code": 0,
                      "dirty": False, "assertion_passed": True,
                      "stdout_log": "logs/browser_restart.stdout",
                      "stdout_sha256": hashlib.sha256(self.stdout).hexdigest()}
        self.write_check()

    def tearDown(self):
        self.tmp.cleanup()

    def log(self, data):
        self.stdout = data
        (self.root / "logs/browser_restart.stdout").write_bytes(data)

    def write_check(self):
        (self.root / "checks/browser_restart.json").write_text(json.dumps(self.check))

    def evaluate(self):
        return validate_completion(self.contract, self.artifact, *self.reports, self.root)

    def test_complete_real_log_proof_is_eligible(self):
        decision = self.evaluate()
        self.assertTrue(decision["eligible"])
        self.assertEqual(decision["commit"], "a" * 40)
        self.assertEqual(decision["criteria"], ["recovery"])

    def test_digest_is_canonical_and_rejects_non_json_numbers(self):
        self.assertEqual(contract_digest({"a": 1, "b": True}), contract_digest({"b": True, "a": 1}))
        with self.assertRaises(AcceptanceError):
            contract_digest({"a": float("nan")})

    def test_description_changed_since_freeze_blocks(self):
        with self.assertRaises(AcceptanceError):
            validate_contract(self.contract, "c" * 64)

    def test_empty_criteria_and_empty_text_cannot_auto_complete(self):
        for mutation in ("empty", "text"):
            contract = copy.deepcopy(self.contract)
            if mutation == "empty": contract["criteria"] = []
            else: contract["criteria"][0]["text"] = "  "
            with self.assertRaises(AcceptanceError): validate_contract(contract, self.description)

    def test_subjective_and_waived_criteria_block(self):
        for field, value in (("kind", "subjective"), ("required", False), ("required", "true")):
            contract = copy.deepcopy(self.contract)
            contract["criteria"][0][field] = value
            with self.assertRaises(AcceptanceError): validate_contract(contract, self.description)

    def test_missing_decision_or_engineering_flag_blocks(self):
        for field, value in (("engineering", False), ("engineering", 1), ("decisions", ["choose retention"])):
            contract = copy.deepcopy(self.contract); contract[field] = value
            with self.assertRaises(AcceptanceError): validate_contract(contract, self.description)

    def test_duplicate_criterion_ids_are_rejected(self):
        contract = copy.deepcopy(self.contract)
        contract["criteria"].append(copy.deepcopy(contract["criteria"][0]))
        with self.assertRaises(AcceptanceError): validate_contract(contract, self.description)

    def test_each_criterion_requires_registered_proof(self):
        for refs in ([], ["missing"], ["browser_restart", "browser_restart"]):
            contract = copy.deepcopy(self.contract); contract["criteria"][0]["check_ids"] = refs
            with self.assertRaises(AcceptanceError): validate_contract(contract, self.description)

    def test_unmapped_check_cannot_be_silently_ignored(self):
        contract = copy.deepcopy(self.contract); contract["checks"]["ignored"] = copy.deepcopy(contract["checks"]["browser_restart"])
        with self.assertRaises(AcceptanceError): validate_contract(contract, self.description)

    def test_argv_cwd_and_matcher_are_required(self):
        for patch in ({"argv": []}, {"cwd": "../main"}, {"cwd": "/main"}, {"proof": {}}, {"proof": {"kind": "json", "pointer": "/passed"}}):
            contract = copy.deepcopy(self.contract); contract["checks"]["browser_restart"].update(patch)
            with self.assertRaises(AcceptanceError): validate_contract(contract, self.description)

    def test_all_roles_must_certify_same_commit_tree_and_generation(self):
        for index in range(3):
            for field, value in (("commit", "c" * 40), ("tree", "d" * 40), ("generation", 2), ("contract_sha256", "e" * 64), ("description_sha256", "f" * 64), ("issue", "PIT-23")):
                reports = copy.deepcopy(self.reports); reports[index][field] = value
                with self.assertRaises(AcceptanceError): validate_completion(self.contract, self.artifact, *reports, self.root)

    def test_artifact_uses_full_valid_git_identities(self):
        for field, value in (("commit", "abc"), ("tree", "main"), ("generation", True), ("generation", 0), ("issue", "../../elsewhere")):
            artifact = copy.deepcopy(self.artifact); artifact[field] = value
            with self.assertRaises(AcceptanceError): validate_completion(self.contract, artifact, *self.reports, self.root)

    def test_contract_tampering_invalidates_artifact(self):
        self.contract["criteria"][0]["text"] = "weakened acceptance"
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_different_configured_actors_and_run_ids_required(self):
        for change in ("same_actor", "wrong_actor", "same_run", "wrong_role"):
            artifact, reports = copy.deepcopy(self.artifact), copy.deepcopy(self.reports)
            if change == "same_actor": artifact["actors"]["qa"] = artifact["actors"]["developer"]
            if change == "wrong_actor": reports[1]["actor_id"] = "some-other-reviewer"
            if change == "same_run": reports[2]["run_id"] = reports[0]["run_id"]
            if change == "wrong_role": reports[2]["role"] = "developer"
            with self.assertRaises(AcceptanceError): validate_completion(self.contract, artifact, *reports, self.root)

    def test_missing_duplicate_or_nonpassing_results_block(self):
        for result in ([], [{"id": "recovery", "status": "fail"}], [{"id": "recovery", "status": "skipped"}], [{"id": "recovery", "status": "not_run"}], [{"id": "unknown", "status": "pass"}], [{"id": "recovery", "status": "pass"}] * 2):
            reports = copy.deepcopy(self.reports); reports[2]["criterion_results"] = result
            with self.assertRaises(AcceptanceError): validate_completion(self.contract, self.artifact, *reports, self.root)

    def test_gaps_decisions_and_dirty_source_block(self):
        for role in range(3):
            for patch in ({"gaps": ["not tested"]}, {"decisions": ["budget"]}, {"dirty": True}, {"dirty": "false"}, {"failures": ["browser"]}, {"skipped": ["restart"]}, {"not_run": ["multitab"]}):
                reports = copy.deepcopy(self.reports); reports[role].update(patch)
                with self.assertRaises(AcceptanceError): validate_completion(self.contract, self.artifact, *reports, self.root)

    def test_scope_notes_do_not_waive_required_checks(self):
        reports=copy.deepcopy(self.reports)
        reports[2]['scope_exclusions']=['Product models outside this contract']
        reports[2]['pending_integration']=['Human-approved merge and exact main CI']
        validate_completion(self.contract,self.artifact,*reports,self.root)
        reports[2]['not_run']=['A required check']
        with self.assertRaises(AcceptanceError):validate_completion(self.contract,self.artifact,*reports,self.root)

    def test_missing_controller_receipt_blocks_agent_pass(self):
        (self.root / "checks/browser_restart.json").unlink()
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_agent_receipt_cannot_replace_controller_proof(self):
        self.check["producer"] = "qa-agent"; self.write_check()
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_stale_controller_check_identity_blocks(self):
        self.check["generation"] = 0; self.write_check()
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_executed_command_must_match_approved_argv_and_cwd(self):
        for patch in ({"argv": ["echo", "PASS"]}, {"cwd": "other"}):
            original = copy.deepcopy(self.check); self.check.update(patch); self.write_check()
            with self.assertRaises(AcceptanceError): self.evaluate()
            self.check = original

    def test_zero_exit_alone_is_not_proof(self):
        self.log(b'{"assertions":{"restart":false}}')
        self.check["stdout_sha256"] = hashlib.sha256(self.stdout).hexdigest(); self.write_check()
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_numeric_one_is_not_json_true(self):
        self.log(b'{"assertions":{"restart":1}}')
        self.check["stdout_sha256"] = hashlib.sha256(self.stdout).hexdigest(); self.write_check()
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_nonzero_missing_or_boolean_exit_code_blocks(self):
        for value in (1, None, False):
            self.check["exit_code"] = value; self.write_check()
            with self.assertRaises(AcceptanceError): self.evaluate()

    def test_assertion_absence_or_source_mutation_blocks(self):
        for patch in ({"assertion_passed": False}, {"assertion_passed": None}, {"dirty": True}):
            original = copy.deepcopy(self.check); self.check.update(patch); self.write_check()
            with self.assertRaises(AcceptanceError): self.evaluate()
            self.check = original

    def test_changed_or_missing_raw_log_blocks(self):
        self.log(b'{"assertions":{"restart":true},"tampered":true}')
        with self.assertRaises(AcceptanceError): self.evaluate()
        (self.root / "logs/browser_restart.stdout").unlink()
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_outside_or_symlink_log_cannot_be_used(self):
        self.check["stdout_log"] = "../external.log"; self.write_check()
        with self.assertRaises(AcceptanceError): self.evaluate()
        self.check["stdout_log"] = "logs/browser_restart.stdout"; self.write_check()
        real = self.root / "real.log"; real.write_bytes(self.stdout)
        log = self.root / "logs/browser_restart.stdout"; log.unlink(); log.symlink_to(real)
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_regex_proof_matches_entire_log_not_incidental_pass(self):
        self.contract["checks"]["browser_restart"]["proof"] = {"kind": "regex", "pattern": "PASS\\n"}
        digest = contract_digest(self.contract)
        self.artifact["contract_sha256"] = digest
        for report in self.reports: report["contract_sha256"] = digest
        self.check["contract_sha256"] = digest
        self.log(b"PASS\n"); self.check["stdout_sha256"] = hashlib.sha256(self.stdout).hexdigest(); self.write_check()
        self.assertTrue(self.evaluate()["eligible"])
        self.log(b"FAIL\nPASS\n"); self.check["stdout_sha256"] = hashlib.sha256(self.stdout).hexdigest(); self.write_check()
        with self.assertRaises(AcceptanceError): self.evaluate()

    def test_reviewer_must_independently_certify_full_contract(self):
        for value in (None, False, "true"):
            self.reports[1]["complete_contract_review"] = value
            with self.assertRaises(AcceptanceError): self.evaluate()

    def test_public_proof_evaluator_uses_exact_json_types(self):
        proof = {"kind": "json", "pointer": "/passed", "equals": True}
        self.assertTrue(evaluate_proof(proof, '{"passed":true}'))
        self.assertFalse(evaluate_proof(proof, '{"passed":1}'))
        self.assertFalse(evaluate_proof(proof, "not JSON"))
        with self.assertRaises(AcceptanceError): evaluate_proof({}, "PASS")


if __name__ == "__main__":
    unittest.main()
