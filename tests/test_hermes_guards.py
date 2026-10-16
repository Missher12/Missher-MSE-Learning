import unittest

from adapters.hermes.guards import check_guard, validate_guard
from adapters.hermes.bridge import Hooks


RULE = {"guardId": "safe-input", "toolName": "write_file", "mode": "enforce", "version": 1,
        "requiredKeys": ["path", "content"], "allowedKeys": ["path", "content"]}


class HermesGuardTests(unittest.TestCase):
    def test_validation_and_deterministic_decision(self):
        self.assertIsNotNone(validate_guard(RULE))
        self.assertEqual(check_guard(RULE, "write_file", {"path": "a", "content": "b"}), (None, False))
        message, matched = check_guard(RULE, "write_file", {"path": "a", "content": "b", "extra": 1})
        self.assertEqual(message, "MSE guard safe-input: unexpected_key")
        self.assertTrue(matched)
        self.assertIsNone(validate_guard({**RULE, "mode": "run-script"}))

    def test_malformed_modes_are_refused_and_registered_rules_are_snapshots(self):
        for mode in ({}, [], 1, None):
            self.assertIsNone(validate_guard({**RULE, "mode": mode}))
        mutable = {**RULE, "requiredKeys": ["path"], "allowedKeys": ["path"]}
        frozen = validate_guard(mutable)
        mutable["allowedKeys"].append("unexpected")
        self.assertEqual(check_guard(frozen, "write_file", {"path": "x", "unexpected": "x"})[0],
                         "MSE guard safe-input: unexpected_key")

    def test_hook_returns_native_block_directive_and_modes(self):
        hooks = Hooks(config={"guardTemplates": [RULE]}, call=lambda *_: {"ok": True})
        self.assertEqual(hooks.pre_tool_call(tool_name="write_file", args={"path": "x"}),
                         {"action": "block", "message": "MSE guard safe-input: required_key_missing"})
        self.assertIsNone(hooks.pre_tool_call(tool_name="read_file", args={}))
        hooks.closed = True
        self.assertIsNone(hooks.pre_tool_call(tool_name="write_file", args={}))

    def test_shadow_observes_without_blocking(self):
        hooks = Hooks(config={"guardTemplates": [{**RULE, "mode": "shadow"}]}, call=lambda *_: {"ok": True})
        self.assertIsNone(hooks.pre_tool_call(tool_name="write_file", args={}))
        self.assertEqual(hooks.guard_shadow, {"safe-input": 1})


if __name__ == "__main__":
    unittest.main()
