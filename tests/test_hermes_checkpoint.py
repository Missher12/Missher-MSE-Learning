"""Hermes per-step recovery tests; intentionally independent of the optional OpenAI SDK."""
import hashlib
import importlib.util
import json
from pathlib import Path
import types
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("mse_checkpoint_driver", ROOT / "adapters/hermes/driver.py")
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


def request_hash(identity, prompt):
    shape = {"provider": identity.provider, "base_url": identity.base_url,
             "api_mode": identity.api_mode, "model": identity.model,
             "messages": [{"role": "system", "content": prompt["system"]},
                          {"role": "user", "content": prompt["text"]}],
             "max_tokens": 256 if prompt["stepKey"].startswith("review:judge:") else 128}
    if identity.reasoning_state == DRIVER.REASONING_EXPLICIT:
        shape["reasoning_effort"] = identity.reasoning_value
    body = json.dumps(shape, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


class HermesCheckpointTests(unittest.TestCase):
    def test_completed_step_returns_saved_answer_without_dispatch(self):
        identity = types.SimpleNamespace(provider="deepseek-official", base_url="https://api.deepseek.com",
                                         api_mode="chat_completions", model="deepseek-flash",
                                         reasoning_state=DRIVER.REASONING_EXPLICIT, reasoning_value="max")
        prompt = {"system": "system text", "text": "user text", "stepKey": "objective:case-1:candidate"}
        expected = request_hash(identity, prompt)
        calls = []

        def core_call(name, payload):
            calls.append(name)
            if name == "planProgress":
                return {"ok": True, "step": {"requestHash": expected, "tokens": 77,
                                               "text": "saved response", "truncated": False}}
            self.fail("a completed checkpoint must not reserve, start, or dispatch again: %s" % name)

        result = DRIVER._multi_step(None, None, identity, prompt,
                                    {"ticket": "ticket-1", "spend": {"known": 0}},
                                    {"steps": 0}, {"armChars": 4000, "verdictBytes": 8192}, core_call)
        # _multi_step is async; run it without requiring the optional provider SDK.
        import asyncio
        result = asyncio.run(result)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["resumed"])
        self.assertEqual(result["content"]["text"], "saved response")
        self.assertEqual(calls, ["planProgress"])

    def test_checkpoint_identity_changes_with_reasoning_route(self):
        identity = types.SimpleNamespace(provider="deepseek-official", base_url="https://api.deepseek.com",
                                         api_mode="chat_completions", model="deepseek-flash",
                                         reasoning_state=DRIVER.REASONING_EXPLICIT, reasoning_value="max")
        prompt = {"system": "s", "text": "t", "stepKey": "review:candidate"}
        original = request_hash(identity, prompt)
        identity.reasoning_value = "low"
        self.assertNotEqual(original, request_hash(identity, prompt))


if __name__ == "__main__":
    unittest.main()
