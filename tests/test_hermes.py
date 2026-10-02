import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mse_learning_bridge_test", ROOT / "adapters/hermes/bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def core_payload(payload):
    """Exactly what the bridge submits to the core.

    The adapter keeps its own bookkeeping inside the queue entry (`_key`, `_durable`); those keys
    are stripped at the real transport boundary, so a fake core must see the frozen business
    fields only — otherwise "the retry replays the identical payload" would compare the wrong
    document.
    """
    return {name: value for name, value in payload.items() if not name.startswith("_")}


def durable_core(call, wall=None, enqueue=None):
    """Adapt a ``complete``-only fake core to the durable operations the bridge now uses.

    This is a TEST-side shim, not a production fallback: the bridge really calls
    ``settlementEnqueue`` then ``settlementApply``, and these fakes predate that boundary. It
    models exactly the two facts the adapter depends on — an acknowledgement returns a handle and
    a deadline, and the business write receives the same frozen payload without the adapter's
    internal keys — plus an injectable ``enqueue`` answer so the never-acknowledged path stays
    covered. Production never takes this path.
    """
    state = {"generation": 1, "pending": {}}
    clock = wall or (lambda: time.time() * 1000.0)

    def session_hash(session_id):
        return hashlib.sha256(str(session_id).encode()).hexdigest()

    def wrapped(op, value):
        if op == "settlementStatus":
            return {"ok": True, "control": {"generation": state["generation"], "userPaused": False,
                                            "stops": 0},
                    "pending": [{"key": key, "payloadHash": entry["payloadHash"],
                                 "deadline": entry["deadline"], "sessionHash": entry["sessionHash"]}
                                for key, entry in state["pending"].items()],
                    "history": [], "counts": {"pending": len(state["pending"])}}
        if op == "settlementEnqueue":
            if enqueue is not None:
                injected = enqueue(core_payload(value), state)
                if injected is not None:
                    return injected
            key = str(value.get("_key") or value.get("turnId") or len(state["pending"]))
            payload_hash = "hash-" + key
            state["pending"][key] = {"payload": core_payload(value), "payloadHash": payload_hash,
                                     "deadline": clock() + 300_000.0,
                                     "sessionHash": session_hash(value.get("sessionId"))}
            return {"ok": True, "durable": True, "key": key, "payloadHash": payload_hash,
                    "generation": state["generation"], "deadline": state["pending"][key]["deadline"]}
        if op == "settlementApply":
            entry = state["pending"].get(value.get("key"))
            if entry is None:
                return {"ok": True, "duplicate": True, "outcome": None, "attributed": 0, "terminal": "settled"}
            result = call("complete", dict(entry["payload"]))
            if result.get("ok"):
                state["pending"].pop(value.get("key"), None)
            return result
        if op == "settlementPause":
            state["generation"] += 1
            return {"ok": True, "generation": state["generation"], "userPaused": value.get("paused")}
        if op == "settlementStop":
            state["generation"] += 1
            if isinstance(value.get("sessionId"), str):
                return {"ok": True, "generation": state["generation"], "stopped": 0,
                        "sessionHash": session_hash(value["sessionId"])}
            entry = state["pending"].get(value.get("key"))
            if entry is None:
                return {"ok": False, "code": "settlement_unknown_key"}
            return {"ok": True, "generation": state["generation"], "stopped": 0,
                    "sessionHash": entry["sessionHash"]}
        return call(op, value)

    return wrapped


class HermesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mse-hermes-")
        self.addCleanup(self.directory.cleanup)
        self.environment = patch.dict(os.environ, {"MSE_LEARN_CLI": str(ROOT / "src/cli.mjs"),
                                    "MSE_NODE_EXECUTABLE": shutil.which("node"), "MSE_REFLECTION_ENABLED": "0"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = {"stateRoot": self.directory.name, "adapterId": "hermes", "maxContextBytes": 768}
        self.hooks = module.Hooks(config=self.config)
        self.hooks.pre_llm_call(session_id="first", turn_id="1", user_message="以后导出金额前先转换为数值，再按金额排序")
        self.hooks.on_session_end(session_id="first", turn_id="1", completed=True, failed=False, interrupted=False)

    def test_restart_recall_and_effective_request_acknowledgement(self):
        hooks = module.Hooks(config=self.config)
        prompt = "导出金额并排序"
        result = hooks.pre_llm_call(session_id="next", turn_id="1", user_message=prompt)
        self.assertIn("转换为数值", result["context"])
        self.assertLessEqual(len(result["context"].encode()), 768)
        self.assertIsNone(hooks.pre_llm_call(session_id="next", turn_id="1", user_message=prompt))
        common = {"session_id": "next", "turn_id": "1", "api_request_id": "request-1"}
        hooks.pre_api_request(**common, request_messages=[{"role": "user", "content": prompt + "\n\n" + result["context"]}])
        self.assertEqual(hooks.call("status", {})["adopted"], 0)
        hooks.post_api_request(**common)
        self.assertEqual(hooks.call("status", {})["adopted"], 1)
        hooks.post_llm_call(session_id="next", turn_id="1", assistant_response="任务已经成功完成")
        hooks.on_session_end(session_id="next", turn_id="1", completed=True, failed=False, interrupted=False)
        status = hooks.call("status", {})
        self.assertEqual(status["verified"], 0)
        self.assertEqual(status["inconclusive"], 1)

    def test_old_or_forged_context_is_not_credited(self):
        result = self.hooks.pre_llm_call(session_id="next", turn_id="1", user_message="导出金额并排序")
        common = {"session_id": "next", "turn_id": "1", "api_request_id": "request-2"}
        self.hooks.pre_api_request(**common, request_messages=[{"role": "user", "content": result["context"]}])
        self.hooks.post_api_request(**common)
        self.hooks.on_session_end(session_id="next", turn_id="1", completed=True)
        self.assertEqual(self.hooks.call("status", {})["adopted"], 0)

    def test_cancelled_and_nested_tasks_do_not_count(self):
        self.assertIsNone(self.hooks.pre_llm_call(session_id="nested", turn_id="1", user_message="导出金额并排序", parent_session_id="parent"))
        self.assertIsNone(self.hooks.pre_llm_call(session_id="cron_job", turn_id="1", user_message="以后处理金额要先验证精度"))
        self.hooks.pre_llm_call(session_id="next", turn_id="1", user_message="导出金额并排序")
        self.hooks.on_session_end(session_id="next", turn_id="1", completed=False, interrupted=True)
        self.assertEqual(self.hooks.call("status", {})["verified"], 0)
        self.assertEqual(self.hooks.call("status", {})["lessons"], 1)

    def test_missing_runtime_does_not_break_host(self):
        with patch.dict(os.environ, {"MSE_LEARN_CLI": "/no-such-runtime/cli.mjs"}):
            self.assertIsNone(self.hooks.pre_llm_call(session_id="next", turn_id="1", user_message="导出金额并排序"))

    def test_native_error_status_and_unload(self):
        prompt = "导出金额并排序"
        result = self.hooks.pre_llm_call(session_id="next", turn_id="1", user_message=prompt)
        common = {"session_id": "next", "turn_id": "1", "api_request_id": "native-1"}
        self.hooks.pre_api_request(**common, request_messages=[{"role": "user", "content": [
            {"type": "input_text", "text": prompt + "\n\n" + result["context"]}]}])
        self.hooks.post_api_request(**common)
        self.hooks.post_tool_call(session_id="next", turn_id="1", status="error", tool_name="terminal")
        self.hooks.on_session_end(session_id="next", turn_id="1", completed=True)
        self.assertEqual(self.hooks.call("status", {})["failed"], 0)
        self.assertEqual(self.hooks.call("status", {})["inconclusive"], 1)
        self.hooks.dispose()
        self.assertIsNone(self.hooks.pre_llm_call(session_id="closed", turn_id="1", user_message=prompt))

    def test_legacy_controller_pauses_new_learning(self):
        hooks = module.Hooks(config=self.config, enabled=lambda: False)
        self.assertIsNone(hooks.pre_llm_call(session_id="next", turn_id="1", user_message="导出金额并排序"))
        self.assertEqual(hooks.call("status", {})["adopted"], 0)

    def test_reset_cancels_the_old_session_without_granting_success(self):
        self.hooks.pre_llm_call(session_id="old", turn_id="1", user_message="导出金额并排序")
        self.hooks.verification("old", "1", "prior-check", True)
        self.hooks.on_session_reset(old_session_id="old", new_session_id="new")
        self.assertNotIn(("old", "1"), self.hooks.turns)
        self.assertEqual(self.hooks.call("status", {})["verified"], 0)

    def test_unload_during_review_does_not_commit_a_late_candidate(self):
        def review(request, model, cancel_event):
            self.hooks.dispose()
            return json.dumps({"instruction": "导出金额时先检查数据类型，再按数值排序"})
        self.hooks.review = review
        self.hooks._reflect({"base": {"sessionId": "late", "turnId": "1"},
                             "task_summary": "根据金额列进行排序并导出", "result_summary": "金额列被错误地当成字符串进行排序", "model": "unused"}, "failed")
        self.assertEqual(self.hooks.call("status", {})["counts"]["candidate"], 0)


    def _adopt(self, hooks=None, session="next"):
        hooks = hooks or self.hooks
        prompt = "请导出金额并进行排序"
        result = hooks.pre_llm_call(session_id=session, turn_id="1", user_message=prompt)
        common = {"session_id": session, "turn_id": "1", "api_request_id": "verified-request"}
        hooks.pre_api_request(**common, request_messages=[{"role": "user", "content": prompt + "\n\n" + result["context"]}])
        hooks.post_api_request(**common)
        return hooks.turns[(session, "1")]["lessons"]

    def test_bound_checker_failure_and_write_invalidation(self):
        lessons = self._adopt()
        self.assertFalse(self.hooks.verification("next", "1", "unbound", False))
        self.assertFalse(self.hooks.verification("next", "1", "wrong", False, ["unrelated"]))
        self.assertTrue(self.hooks.verification("next", "1", "checked", False, lessons))
        self.hooks.on_session_end(session_id="next", turn_id="1", completed=True)
        self.assertEqual(self.hooks.call("status", {})["failed"], 1)
        lessons = self._adopt(session="later")
        self.assertTrue(self.hooks.verification("later", "1", "checked", True, lessons))
        self.hooks.post_tool_call(session_id="later", turn_id="1", status="success")
        self.hooks.on_session_end(session_id="later", turn_id="1", completed=True)
        self.assertEqual(self.hooks.call("status", {})["verified"], 0)
        self.assertEqual(self.hooks.call("status", {})["inconclusive"], 1)

    def test_failed_request_and_pause_before_response_do_not_adopt(self):
        prompt = "导出金额并排序"
        result = self.hooks.pre_llm_call(session_id="next", turn_id="1", user_message=prompt)
        common = {"session_id": "next", "turn_id": "1", "api_request_id": "failed-request"}
        self.hooks.pre_api_request(**common, request_messages=[{"role": "user", "content": prompt + "\n\n" + result["context"]}])
        self.hooks.post_api_request(**common, failed=True)
        self.hooks.set_enabled(False)
        self.hooks.set_enabled(True)
        self.hooks.post_api_request(**common)
        self.assertEqual(self.hooks.call("status", {})["adopted"], 0)
        self.assertEqual(self.hooks.call("status", {})["failed"], 0)

    def test_pause_and_resume_during_review_cancels_ticket_and_late_candidate(self):
        started, release = threading.Event(), threading.Event()
        signals = []
        def review(request, model, cancel_event):
            signals.append(cancel_event)
            started.set()
            release.wait(5)
            return json.dumps({"instruction": "导出金额时先检查数值类型，再核对排序结果"})
        hooks = module.Hooks(config=self.config, review=review)
        worker = threading.Thread(target=hooks._reflect, args=({"base": {"sessionId": "late", "turnId": "1"},
            "task_summary": "根据金额列进行排序并导出", "result_summary": "金额列被错误地当成字符串进行排序", "model": "unused"}, "failed"))
        worker.start()
        self.assertTrue(started.wait(5))
        hooks.set_enabled(False)
        hooks.set_enabled(True)
        self.assertTrue(signals[0].is_set())
        release.set()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(hooks.call("status", {})["counts"]["candidate"], 0)

    def test_session_reset_cancels_review_of_old_session(self):
        started, release = threading.Event(), threading.Event()
        def review(request, model, cancel_event):
            started.set()
            release.wait(5)
            self.assertTrue(cancel_event.is_set())
            return json.dumps({"instruction": "导出金额时先检查数值类型，再核对排序结果"})
        hooks = module.Hooks(config=self.config, review=review)
        worker = threading.Thread(target=hooks._reflect, args=({"base": {"sessionId": "old", "turnId": "1"},
            "task_summary": "根据金额列进行排序并导出", "result_summary": "金额列被错误地当成字符串进行排序", "model": "unused"}, "failed"))
        worker.start()
        self.assertTrue(started.wait(5))
        hooks.on_session_reset(old_session_id="old", new_session_id="new")
        release.set()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(hooks.call("status", {})["counts"]["candidate"], 0)


    def test_checker_rejects_stale_version(self):
        lessons = self._adopt()
        version = self.hooks.turns[("next", "1")]["lesson_versions"][0]["version"]
        self.assertFalse(self.hooks.verification("next", "1", "current-check", True, lessons, version + 1))
        self.assertTrue(self.hooks.verification("next", "1", "current-check", True, lessons, version))
        self.hooks.on_session_end(session_id="next", turn_id="1", completed=True)
        self.assertEqual(self.hooks.call("status", {})["verified"], 1)


    def test_offline_model_budget_is_opt_in_and_invalid_env_fails_closed(self):
        with patch.dict(os.environ, {"MSE_EVALUATION_TOKENS_PER_DAY": "-1", "MSE_EVALUATION_CALLS_PER_DAY": "999"}):
            hooks = module.Hooks(config=self.config)
            self.assertEqual(hooks.config["evaluationTokensPerDay"], 0)
            self.assertEqual(hooks.config["evaluationCallsPerDay"], 2)
        with patch.dict(os.environ, {"MSE_EVALUATION_TOKENS_PER_DAY": "4096", "MSE_EVALUATION_CALLS_PER_DAY": "1"}):
            hooks = module.Hooks(config=self.config)
            self.assertEqual(hooks.config["evaluationTokensPerDay"], 4096)
            self.assertEqual(hooks.config["evaluationCallsPerDay"], 1)


    def test_review_keeps_nested_default_model_provider_and_cancellation(self):
        calls = []
        def resolve_route(**kwargs):
            calls.append(kwargs)
            return {"provider": "selected-provider"}
        def call_llm(**kwargs):
            calls.append({"provider": kwargs["provider"], "model": kwargs["model"]})
            self.assertEqual(kwargs["timeout"], 60.0)
            self.assertEqual(kwargs["max_tokens"], 384)
            self.assertEqual(kwargs["reasoning_config"], {"effort": "max"})
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="{}", tool_calls=None))])
        fake = {
            "hermes_cli.config": types.SimpleNamespace(
                load_config_readonly=lambda: {"model": {"default": {"model": "chosen-model", "provider": "selected-provider"}}},
                split_model_config_default=lambda raw: (raw["model"], raw["provider"])),
            "hermes_cli.runtime_provider": types.SimpleNamespace(resolve_runtime_provider=resolve_route),
            "agent.auxiliary_client": types.SimpleNamespace(call_llm=call_llm),
            "hermes_constants": types.SimpleNamespace(resolve_reasoning_config=lambda *args: {"effort": "max"}),
        }
        request = {"maxTokens": 384, "system": "review", "text": "synthetic"}
        with patch.dict("sys.modules", fake):
            self.assertEqual(module.Hooks._review(request, "chosen-model"), "{}")
            self.assertEqual(calls, [{"requested": "selected-provider", "target_model": "chosen-model"},
                                     {"provider": "selected-provider", "model": "chosen-model"}])
            cancelled = threading.Event()
            cancelled.set()
            self.assertIsNone(module.Hooks._review(request, "chosen-model", cancelled))
            self.assertIsNone(module.Hooks._review(request, "other-model"))
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()


class LegacyUpgradeTests(unittest.TestCase):
    """The Hermes bridge must keep recalling a method validated by 0.9.0-alpha.2.

    The store below was produced by the real alpha.2 engine with adapterId=hermes
    (scripts/make-legacy-fixtures.mjs); no environment was configured anywhere.
    """

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mse-hermes-legacy-")
        self.addCleanup(self.directory.cleanup)
        source = Path(__file__).resolve().parent / "fixtures" / "legacy-alpha2-schema2-hermes"
        for item in source.iterdir():
            target = Path(self.directory.name) / item.name
            if item.is_dir():
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)
        self.environment = patch.dict(os.environ, {"MSE_LEARN_CLI": str(ROOT / "src/cli.mjs"),
                                    "MSE_NODE_EXECUTABLE": shutil.which("node"), "MSE_REFLECTION_ENABLED": "0"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = {"stateRoot": self.directory.name, "adapterId": "hermes", "maxContextBytes": 768}

    def test_legacy_validated_method_still_recalls_by_default(self):
        hooks = module.Hooks(config=self.config)
        status = hooks.call("status", {})
        self.assertEqual(status["counts"]["validated"], 1)
        instruction = next(row["instruction"] for row in hooks.call("list", {"limit": 20})["lessons"]
                           if row["kind"] == "method")
        result = hooks.pre_llm_call(session_id="legacy-hermes", turn_id="1", user_message=instruction)
        self.assertIsNotNone(result, "the alpha.2 validated method must still be offered")
        self.assertLessEqual(len(result["context"].encode()), 768)

    def test_legacy_store_scope_is_not_widened_by_the_new_default(self):
        hooks = module.Hooks(config=dict(self.config, environmentId="some-other-toolchain"))
        instruction = next(row["instruction"] for row in hooks.call("list", {"limit": 20})["lessons"]
                           if row["kind"] == "method")
        self.assertIsNone(hooks.pre_llm_call(session_id="legacy-other-env", turn_id="1", user_message=instruction))


class FakeClock:
    """Deterministic clock and scheduler: no real sleeping, every timer is inspectable."""

    def __init__(self):
        self.time = 1000.0
        self.timers = {}
        self.next_id = 0

    def now(self):
        return self.time

    def schedule(self, fn, delay):
        self.next_id += 1
        self.timers[self.next_id] = (self.time + max(delay, 0.0), fn)
        return self.next_id

    def cancel(self, handle):
        self.timers.pop(handle, None)

    def advance(self, seconds):
        self.time += seconds
        for _ in range(64):
            due = [(handle, item) for handle, item in self.timers.items() if item[0] <= self.time]
            if not due:
                return
            for handle, (_, fn) in due:
                self.timers.pop(handle, None)
                fn()
        raise AssertionError("timer loop did not settle")

    def pending(self):
        return len(self.timers)


class SettlementRetryTests(unittest.TestCase):
    """Bounded, idempotent settlement replay on the Hermes hook path."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mse-hermes-settlement-")
        self.addCleanup(self.directory.cleanup)
        self.clock = FakeClock()
        self.environment = patch.dict(os.environ, {"MSE_LEARN_CLI": str(ROOT / "src/cli.mjs"),
                                    "MSE_NODE_EXECUTABLE": shutil.which("node"), "MSE_REFLECTION_ENABLED": "0"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = {"stateRoot": self.directory.name, "adapterId": "hermes", "maxContextBytes": 768}
        self.calls = []
        self.failures = 0
        self.complete_hook = None
        test = self

        def call(op, value):
            test.calls.append((op, json.dumps(value, sort_keys=True)))
            if op == "complete" and test.complete_hook is not None:
                override = test.complete_hook(op, value)
                if override is not None:
                    return override
            if op == "complete" and test.failures > 0:
                test.failures -= 1
                return {"ok": False, "code": "state_unavailable"}
            return test.real_call(op, value)


        class ClockedHooks(module.Hooks):
            def __init__(inner_self, *args, **kwargs):
                inner_self.monotonic = test.clock.now
                inner_self.schedule = test.clock.schedule
                inner_self.cancel = test.clock.cancel
                super().__init__(*args, **kwargs)

        self.ClockedHooks = ClockedHooks
        # The bridge settles through the durable operations now; this test-side shim maps them
        # onto the fake `complete` above, with the test clock as the core's deadline clock.
        # Production never takes this path.
        self.enqueue_hook = None
        self.raw_call = call
        self.call = self.new_core()
        self.learner = self.fresh_hooks()
        self.learner.pre_llm_call(session_id="learn", turn_id="1",
                                  user_message="以后导出金额前先转换为数值，再按金额排序")
        self.learner.on_session_end(session_id="learn", turn_id="1", completed=True, failed=False, interrupted=False)
        self.hooks = self.fresh_hooks()

    def new_core(self):
        """A fresh scripted core store: one scenario, one durable document."""
        return durable_core(self.raw_call,
                            enqueue=lambda payload, state: self.enqueue_hook() if self.enqueue_hook else None)

    def fresh_hooks(self):
        hooks = self.ClockedHooks(config=self.config, call=self.call)
        if self.real_call is None:
            self.real_call = module.Hooks._call.__get__(hooks)
        return hooks

    real_call = None

    def run_turn(self, session="settle", verification_check="numeric-check", completed=True):
        self.calls.clear()
        # A summary long enough for the reflection preconditions, still related to the rule.
        prompt = "导出报表金额并核对排序结果"
        result = self.hooks.pre_llm_call(session_id=session, turn_id="1", user_message=prompt)
        self.assertIsNotNone(result, "the settled turn must recall the learned rule")
        self.hooks.pre_api_request(session_id=session, turn_id="1", api_request_id="req-1",
                                   request_messages=[{"role": "user", "content": prompt + "\n\n" + result["context"]}])
        self.hooks.post_api_request(session_id=session, turn_id="1", api_request_id="req-1")
        self.assertGreaterEqual(self.hooks.call("status", {})["adopted"], 1)
        row = self.hooks.turns[(session, "1")]
        lesson_id = row["lessons"][0]
        version = next(item["version"] for item in row["lesson_versions"] if item["id"] == lesson_id)
        self.assertTrue(self.hooks.verification(session, "1", verification_check, True, [lesson_id], version))
        self.hooks.post_llm_call(session_id=session, turn_id="1", completed=completed, failed=False, interrupted=False,
                                 assistant_response="金额排序完成，数值类型检查通过")
        return lesson_id

    def complete_attempts(self):
        return [row for row in self.calls if row[0] == "complete"]

    def test_transient_failure_recovers_and_credits_once(self):
        self.failures = 2
        self.run_turn()
        self.assertEqual(self.hooks.call("status", {})["verified"], 0, "the first attempt did not commit")
        self.assertEqual(len(self.hooks.settlement_status()), 1)
        self.clock.advance(0.25)
        self.clock.advance(1.0)
        self.assertEqual(self.hooks.call("status", {})["verified"], 1, "the retry settles exactly once")
        self.assertEqual(len(self.hooks.settlement_status()), 0)
        payloads = {row[1] for row in self.complete_attempts()}
        self.assertEqual(len(payloads), 1, "every attempt replays the identical payload")
        self.assertEqual(len(self.complete_attempts()), 3)
        self.assertEqual(self.clock.pending(), 0)

    def test_commit_before_failed_response_is_reported_as_recorded(self):
        settled_once = {"done": False}

        def hook(op, value):
            if op != "complete" or settled_once["done"]:
                return None
            settled_once["done"] = True
            module.Hooks._call(self.hooks, op, value)
            return {"ok": False, "code": "state_unavailable"}

        self.complete_hook = hook
        self.run_turn()
        self.assertEqual(self.hooks.call("status", {})["verified"], 1, "the first attempt committed")
        self.assertEqual(self.hooks.settlement_status()[0]["attempts"], 1)
        self.clock.advance(0.25)
        self.assertEqual(self.hooks.call("status", {})["verified"], 1, "the replay never double counts")
        settled = [event for event in self.hooks.settlement_events if event["kind"] == "settled"]
        self.assertTrue(settled and settled[-1]["result"].get("duplicate") is True)
        self.assertEqual(settled[-1]["result"].get("outcome"), "verified")
        self.assertEqual(settled[-1]["result"].get("attributed"), 1)

    def test_permanent_errors_stop_and_exhaustion_is_reported(self):
        self.complete_hook = lambda op, value: {"ok": False, "code": "invalid_store"}
        self.run_turn()
        self.assertEqual(self.hooks.settlement_status(), [], "a permanent error is never queued")
        self.assertEqual(self.hooks.settlement_events[-1]["kind"], "failed")
        self.assertEqual(self.hooks.settlement_events[-1]["code"], "invalid_store")
        status = self.hooks.call("status", {})
        self.assertEqual(status["verified"], 0, "a permanent failure never becomes success")

        # The never-acknowledged path keeps its own local bound: the core never took ownership of
        # this settlement, so repeated transient ENQUEUE failures exhaust it locally and it is
        # reported as such. A `lock_busy` in front of the core's main lock is not a business
        # attempt, so it can never be counted against the core's own attempt bound.
        self.call = self.new_core()
        self.hooks = self.fresh_hooks()
        self.enqueue_hook = lambda: {"ok": False, "code": "lock_busy"}
        self.run_turn(session="settle-two")
        for delay in (0.25, 1.0, 3.0):
            self.clock.advance(delay)
        self.assertEqual(self.hooks.settlement_status(), [])
        exhausted = [event for event in self.hooks.settlement_events if event["kind"] == "exhausted"]
        self.assertEqual(len(exhausted), 1)
        self.assertEqual(exhausted[-1]["attempts"], 4)
        self.assertEqual(exhausted[-1]["code"], "lock_busy")
        self.assertEqual(self.complete_attempts(), [],
                         "an unacknowledged settlement is never written to the core")

        # A durable item is ended by the CORE, and its own terminal answer is reported as-is:
        # the adapter stops there instead of retrying a decision the document already recorded.
        self.call = self.new_core()
        self.hooks = self.fresh_hooks()
        self.enqueue_hook = None
        self.complete_hook = lambda op, value: {"ok": False, "code": "settlement_attempts_exhausted"}
        self.run_turn(session="settle-three")
        self.clock.advance(30.0)
        self.assertEqual(self.hooks.settlement_status(), [], "the core's terminal answer needs no retry")
        self.assertEqual(self.hooks.settlement_history()[-1]["state"], "failed")
        self.assertEqual(self.hooks.settlement_history()[-1]["lastError"], "settlement_attempts_exhausted")
        self.assertEqual(len(self.complete_attempts()), 1, "a core terminal answer is submitted once")

    def test_pause_resume_close_and_dispose_bound_the_retries(self):
        self.complete_hook = lambda op, value: {"ok": False, "code": "state_unavailable"}
        self.run_turn()
        attempts = len(self.complete_attempts())
        self.assertEqual(attempts, 1)
        self.hooks.set_enabled(False)
        self.clock.advance(60)
        self.assertEqual(len(self.complete_attempts()), attempts, "a paused bridge starts no attempt")
        self.hooks.set_enabled(True)
        self.clock.advance(0)
        self.assertEqual(len(self.complete_attempts()), attempts + 1, "resume replays the frozen completion")
        self.hooks.close_session("settle")
        self.clock.advance(60)
        self.assertEqual(self.hooks.settlement_history()[-1]["state"], "stopped")
        stopped_attempts = len(self.complete_attempts())
        self.hooks.dispose()
        self.clock.advance(60)
        self.assertEqual(len(self.complete_attempts()), stopped_attempts, "nothing runs after dispose")

    def test_retries_never_restart_a_review(self):
        reviews = []
        self.hooks.review = lambda request, model, cancel=None: reviews.append(model) or None
        self.failures = 1
        # Run the review thread inline so the count is deterministic; the retry path is
        # exercised exactly as in production, it just cannot race the assertion.
        inline = lambda target, args, daemon: types.SimpleNamespace(start=lambda: target(*args))
        with patch.dict(os.environ, {"MSE_REFLECTION_ENABLED": "1"}), patch.object(module.threading, "Thread", inline):
            self.run_turn()
            self.clock.advance(0.25)
            self.clock.advance(1.0)
        self.assertEqual(len(reviews), 1, "a settlement retry adds no reflection call")


class HookLevelClock:
    """Deterministic monotonic seconds + separate wall milliseconds, plus a timer table."""

    def __init__(self, wall_ms=1800000000000.0):
        self.time = 1000.0
        self.wall = wall_ms
        self.jobs = {}
        self.counter = 0

    def now(self):
        return self.time

    def wall_ms(self):
        return self.wall

    def schedule(self, fn, delay):
        self.counter += 1
        self.jobs[self.counter] = (self.time + delay, fn)
        return self.counter

    def cancel(self, key):
        self.jobs.pop(key, None)

    def advance(self, delay):
        self.time += delay
        for key, (at, fn) in list(self.jobs.items()):
            if at <= self.time:
                self.jobs.pop(key, None)
                fn()


class HookSettlementBoundaryTests(unittest.TestCase):
    """D2/D3/D4: the real Hermes hook entry points must govern the settlement queue."""

    def build(self, receipt_remaining_ms=100, enabled=None, enqueue=None, core=None):
        clock = HookLevelClock()
        calls = []
        window = {"permitted": True}
        if enabled is not None:
            window["permitted"] = enabled
        permitted = window

        def call(op, value):
            if op == "prepare":
                return {"ok": True, "context": "本地经验：导出金额前核对数值类型", "lessons": ["lesson-fixture"],
                        "lessonVersions": [{"id": "lesson-fixture", "version": 1, "methodId": None}],
                        "receipt": "receipt-fixture", "receiptExpiresAt": clock.wall_ms() + receipt_remaining_ms}
            if op == "complete":
                calls.append({"at": clock.now(), "payload": dict(value)})
                if core is not None:
                    return core(value)
                return {"ok": False, "code": "lock_busy"} if len(calls) == 1 else {
                    "ok": True, "outcome": value["outcome"], "attributed": 0}
            return {"ok": True}

        class HookLevelHooks(module.Hooks):
            def __init__(inner_self, *args, **kwargs):
                inner_self.monotonic = clock.now
                inner_self.schedule = clock.schedule
                inner_self.cancel = clock.cancel
                inner_self.wall_ms = clock.wall_ms
                super().__init__(*args, **kwargs)

        hooks = HookLevelHooks(config={"stateRoot": "/tmp/unused-fake-engine", "adapterId": "hermes",
                                       "maxContextBytes": 768},
                               call=durable_core(call, wall=clock.wall_ms,
                                                 enqueue=(lambda payload, state: enqueue()) if enqueue else None),
                               enabled=lambda: permitted["permitted"])
        return clock, calls, hooks, window

    def run_turn(self, hooks, session="old", turn="1"):
        prepared = hooks.pre_llm_call(session_id=session, turn_id=turn, user_message="请导出金额并排序")
        self.assertIsNotNone(prepared, "the fixture turn must recall the synthetic rule")
        hooks.pre_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture",
                              request_messages=[{"role": "user", "content": "请导出金额并排序\n\n" + prepared["context"]}])
        hooks.post_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture")
        self.assertTrue(hooks.verification(session, turn, "trusted-fixture", True, ["lesson-fixture"], 1))
        hooks.post_llm_call(session_id=session, turn_id=turn, completed=True)
        return prepared

    def test_session_reset_stops_retries_through_the_real_hook(self):
        clock, calls, hooks, _ = self.build(receipt_remaining_ms=3_600_000)
        self.run_turn(hooks)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(hooks.settlement_status()), 1, "the frozen settlement is still retrying")
        hooks.on_session_reset(old_session_id="old", new_session_id="new")
        clock.advance(0.25)
        self.assertEqual(len(calls), 1, "a reset session must not keep settling")
        self.assertEqual(hooks.settlement_history()[-1]["state"], "stopped")
        self.assertEqual(hooks.settlement_status(), [])
        hooks.dispose()

    def test_legacy_conflict_pauses_retries_and_recovery_replays_them(self):
        clock, calls, hooks, window = self.build(receipt_remaining_ms=3_600_000)
        self.run_turn(hooks)
        window["permitted"] = False
        # The real pre-step entry is what observes the legacy controller taking over.
        self.assertIsNone(hooks.pre_llm_call(session_id="another", turn_id="1", user_message="请导出金额并排序"))
        clock.advance(0.25)
        self.assertEqual(len(calls), 1, "a legacy takeover must stop retrying")
        self.assertTrue(hooks.settlement.paused)
        window["permitted"] = True
        self.assertIsNotNone(hooks.pre_llm_call(session_id="another", turn_id="1", user_message="请导出金额并排序"))
        clock.advance(0)
        self.assertEqual(len(calls), 2, "recovered permission replays the unexpired completion once")
        hooks.dispose()

    def test_per_turn_end_is_not_a_session_close(self):
        clock, calls, hooks, _ = self.build()
        self.run_turn(hooks)
        hooks.on_session_end(session_id="old", turn_id="1", completed=True, failed=False, interrupted=False)
        clock.advance(0.25)
        self.assertEqual(len(calls), 2, "an ordinary turn end keeps the frozen settlement alive")
        hooks.dispose()

    def test_a_quiet_period_retry_cannot_bypass_a_withdrawn_permission(self):
        # F5: the first write failed transiently, then the host withdrew permission without
        # firing any hook. The retry timer must re-read the latest permission before writing.
        clock, calls, hooks, window = self.build(receipt_remaining_ms=3_600_000)
        self.run_turn(hooks)
        self.assertEqual(len(calls), 1)
        frozen = json.dumps(calls[0]["payload"], sort_keys=True)
        window["permitted"] = False
        clock.advance(0.25)
        self.assertEqual(len(calls), 1, "a withdrawn permission must stop the retry before it writes")
        status = hooks.settlement_status()
        self.assertEqual(len(status), 1, "the frozen settlement is kept, not dropped")
        self.assertEqual(status[0]["state"], "pending")
        self.assertEqual(status[0]["attempts"], 1, "a refused attempt is not an attempt")
        self.assertEqual(hooks.settlement_history(), [], "nothing is retired as cancelled or failed")
        self.assertTrue(hooks.settlement.paused)
        self.assertTrue(any(event["kind"] == "blocked" for event in hooks.settlement_events))
        # Recovery replays the SAME frozen payload once, and nothing else.
        window["permitted"] = True
        hooks.pre_llm_call(session_id="another", turn_id="1", user_message="请导出金额并排序")
        clock.advance(0)
        self.assertEqual(len(calls), 2, "the unexpired original is replayed exactly once")
        self.assertEqual(json.dumps(calls[1]["payload"], sort_keys=True), frozen,
                         "the replay is the original frozen payload, never rewritten to cancelled")
        self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
        hooks.dispose()

    def test_a_paused_settlement_that_expires_is_retired_not_written(self):
        # NEVER ACKNOWLEDGED: the core never took ownership of this settlement, so the adapter's
        # own deadline still ends it locally — and it is never written late. (Once the core HAS
        # acknowledged an item, its deadline belongs to the core; see
        # `test_a_durable_settlement_past_its_deadline_is_ended_by_the_core`.)
        clock, calls, hooks, window = self.build(receipt_remaining_ms=2000,
                                                 enqueue=lambda: {"ok": False, "code": "lock_busy"})
        self.run_turn(hooks)
        self.assertEqual(calls, [], "an unacknowledged settlement is never written")
        window["permitted"] = False
        clock.advance(0.25)
        self.assertEqual(calls, [])
        clock.advance(10)
        window["permitted"] = True
        hooks.pre_llm_call(session_id="another", turn_id="1", user_message="请导出金额并排序")
        clock.advance(0)
        self.assertEqual(calls, [], "an expired settlement is never written late")
        self.assertEqual(hooks.settlement_status(), [])
        self.assertEqual(hooks.settlement_history()[-1]["state"], "expired")
        hooks.dispose()

    def test_a_durable_item_whose_deadline_attempt_is_unconfirmed_stops_and_says_so(self):
        # The deadline attempt itself cannot reach the core (a live writer holds the lock, or the
        # runtime is unavailable). The adapter may not claim the core expired the item, and it may
        # not retry for ever: the item stays visible as unconfirmed with its ORIGINAL deadline and
        # no timer, and a later legitimate lifecycle re-reads the core instead.
        def core(value):
            return {"ok": False, "code": "lock_busy"}

        clock, calls, hooks, _ = self.build(receipt_remaining_ms=200, core=core)
        self.run_turn(hooks)
        entry = hooks.settlement.entries[("old", "1")]
        deadline = entry["deadline"]
        self.assertEqual(len(calls), 1)
        self.assertEqual([job[0] for job in clock.jobs.values()], [deadline],
                         "the last automatic attempt sits on the deadline, not on the backoff")
        clock.advance(0.1)
        self.assertEqual(len(calls), 1, "nothing is attempted before the deadline")
        clock.advance(0.1)                       # exactly the deadline
        self.assertEqual(len(calls), 2, "the deadline attempt is issued once")
        status = hooks.settlement_status()
        self.assertEqual(len(status), 1, "an unconfirmed item is kept, never retired as a claim")
        self.assertEqual(status[0]["state"], "unconfirmed")
        self.assertEqual(status[0]["lastError"], "lock_busy")
        self.assertEqual(status[0]["deadline"], deadline, "the original deadline is never refreshed")
        self.assertEqual(clock.jobs, {}, "automatic scheduling stops after the deadline attempt")
        clock.advance(300)
        self.assertEqual(len(calls), 2, "an unconfirmed item is never retried unboundedly")
        self.assertEqual(hooks.settlement_history(), [], "no local terminal state the core never wrote")
        # A later legitimate lifecycle re-reads the core: one attempt per lifecycle moment, still
        # with no successor scheduled and still on the same deadline.
        hooks.pre_llm_call(session_id="later", turn_id="1", user_message="请导出金额并排序")
        self.assertEqual(len(calls), 3, "the lifecycle re-read reaches the core once")
        self.assertEqual(clock.jobs, {})
        self.assertEqual(hooks.settlement.entries[("old", "1")]["deadline"], deadline)
        hooks.dispose()

    def test_a_durable_settlement_past_its_deadline_is_ended_by_the_core(self):
        # ACKNOWLEDGED: the pending row and its deadline live in the core's own document, so the
        # adapter may not retire it locally — and it may not retry for ever either. The last
        # automatic attempt is placed ON the original deadline (never past it, never refreshed),
        # and the core's own terminal answer is what ends it. Nothing is credited twice, and the
        # local record carries the core's code rather than a locally invented expiry.
        def core(value):
            # The first attempt meets a busy store; once the queue is allowed to retry, the core
            # answers with its own terminal row for the acknowledged, now-unusable settlement.
            return {"ok": False, "code": "lock_busy"} if len(calls) == 1 else \
                {"ok": False, "code": "settlement_expired"}

        clock, calls, hooks, window = self.build(receipt_remaining_ms=3_600_000, core=core)
        self.run_turn(hooks)
        self.assertEqual(len(calls), 1)
        entry = hooks.settlement.entries[("old", "1")]
        self.assertEqual(entry["state"], "pending", "an acknowledged item is not retired locally")
        window["permitted"] = False
        clock.advance(0.25)
        self.assertEqual(len(calls), 1, "a withdrawn permission still starts no attempt")
        window["permitted"] = True
        hooks.pre_llm_call(session_id="another", turn_id="1", user_message="请导出金额并排序")
        clock.advance(0)
        self.assertEqual(len(calls), 2, "the core gets its own chance to end the acknowledged item")
        self.assertEqual(hooks.settlement_status(), [])
        self.assertEqual(hooks.settlement_history()[-1]["state"], "expired")
        self.assertEqual(hooks.settlement_history()[-1]["lastError"], "settlement_expired")
        self.assertFalse(any(event["kind"] == "expired" for event in hooks.settlement_events),
                         "the local queue never claims an expiry the core did not answer")
        hooks.dispose()

    def test_stopped_sessions_release_capacity_and_history_stays_bounded(self):
        clock, calls, hooks, _ = self.build()
        for index in range(64):
            session = f"closed-{index}"
            hooks.pre_llm_call(session_id=session, turn_id="1", user_message="请导出金额并排序")
            hooks.post_llm_call(session_id=session, turn_id="1", completed=True)
            hooks.close_session(session)
        self.assertEqual(hooks.settlement_status(), [], "stopped entries hold no live capacity")
        clock.advance(300.001)
        fresh = hooks.pre_llm_call(session_id="healthy", turn_id="1", user_message="请导出金额并排序")
        self.assertIsNotNone(fresh, "a healthy turn still settles after 64 stopped sessions")
        self.assertLessEqual(len(hooks.settlement_history()), 32)
        hooks.dispose()

    def test_receipt_deadline_units_are_converted_and_the_age_bound_still_applies(self):
        # The core's epoch-millisecond receipt deadline is converted once, at the queue boundary,
        # and it is what bounds the next automatic attempt: 100ms of receipt life must not become
        # a 250ms retry. For an acknowledged item that bound is the deadline itself — the last
        # automatic attempt is placed there so the core can retire it from its own clock, instead
        # of the queue declaring a terminal state the document never heard about.
        clock, calls, hooks, _ = self.build(receipt_remaining_ms=100)
        self.run_turn(hooks)
        entry = hooks.settlement.entries[("old", "1")]
        self.assertAlmostEqual(entry["deadline"], 1000.0 + 0.1, places=6)
        self.assertEqual(len(calls), 1, "the first attempt really happened")
        self.assertEqual(entry["state"], "pending", "an acknowledged item is not retired locally")
        self.assertEqual([job[0] for job in clock.jobs.values()], [1000.1],
                         "the last automatic attempt sits on the receipt deadline, not on the backoff")
        clock.advance(0.099)
        self.assertEqual(len(calls), 1, "nothing is attempted before the deadline")
        clock.advance(0.002)
        self.assertEqual(len(calls), 2, "the deadline attempt is issued so the core can decide")
        hooks.dispose()

    def test_a_far_receipt_still_retries_within_the_five_minute_age_bound(self):
        clock, calls, hooks, _ = self.build(receipt_remaining_ms=3_600_000)
        self.run_turn(hooks)
        self.assertAlmostEqual(hooks.settlement.entries[("old", "1")]["deadline"], 1000.0 + 300.0, places=6)
        clock.advance(0.25)
        self.assertEqual(len(calls), 2, "the age bound, not the far receipt, governs")
        hooks.dispose()


class ForegroundBackgroundInterlockTests(unittest.TestCase):
    """R2: the background settlement replay and the foreground recall share one write boundary.

    Every interleaving here is deterministic. The retry runs on an explicit background thread
    (exactly what the product's `threading.Timer` does), the fake core call blocks on an Event
    so the test decides who writes first, and an overlap detector fails the test if two core
    calls are ever inside the boundary at the same time.
    """

    def build(self, complete_plan=None, fail_times=1):
        clock = HookLevelClock()
        calls = []
        order = []
        gates = {"complete_started": threading.Event(), "release_complete": threading.Event()}
        state = {"complete_calls": 0, "prepare_calls": 0, "active": 0, "overlap": False, "max_active": 0}

        def enter(operation):
            state["active"] += 1
            state["max_active"] = max(state["max_active"], state["active"])
            if state["active"] > 1:
                state["overlap"] = True
            order.append(operation + ":start")

        def leave(operation):
            order.append(operation + ":end")
            state["active"] -= 1

        def call(op, value):
            if op == "prepare":
                state["prepare_calls"] += 1
                enter("prepare")
                try:
                    return {"ok": True, "context": "本地经验：导出金额前核对数值类型", "lessons": ["lesson-fixture"],
                            "lessonVersions": [{"id": "lesson-fixture", "version": 1, "methodId": None}],
                            "receipt": "receipt-fixture", "receiptExpiresAt": clock.wall_ms() + 3_600_000}
                finally:
                    leave("prepare")
            if op == "complete":
                state["complete_calls"] += 1
                calls.append({"at": clock.now(), "payload": dict(value)})
                enter("complete")
                try:
                    if complete_plan is not None:
                        complete_plan(gates, state, calls)
                    if state["complete_calls"] <= fail_times:
                        return {"ok": False, "code": "lock_busy"}
                    return {"ok": True, "outcome": value["outcome"], "attributed": 0}
                finally:
                    leave("complete")
            return {"ok": True}

        class InterlockHooks(module.Hooks):
            def __init__(inner_self, *args, **kwargs):
                inner_self.monotonic = clock.now
                inner_self.schedule = clock.schedule
                inner_self.cancel = clock.cancel
                inner_self.wall_ms = clock.wall_ms
                super().__init__(*args, **kwargs)

        hooks = InterlockHooks(config={"stateRoot": "/tmp/unused-fake-engine", "adapterId": "hermes",
                                       "maxContextBytes": 768}, call=durable_core(call))
        return clock, calls, order, gates, state, hooks

    def start_turn(self, hooks, session="old", turn="1", settle=True):
        """Arm one turn; `settle=False` leaves it open so a pause cancels it in flight."""
        prepared = hooks.pre_llm_call(session_id=session, turn_id=turn, user_message="请导出金额并排序")
        self.assertIsNotNone(prepared)
        hooks.pre_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture",
                              request_messages=[{"role": "user",
                                                 "content": "请导出金额并排序\n\n" + prepared["context"]}])
        hooks.post_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture")
        self.assertTrue(hooks.verification(session, turn, "trusted-fixture", True, ["lesson-fixture"], 1))
        if settle:
            hooks.post_llm_call(session_id=session, turn_id=turn, completed=True)
        return prepared

    def background_attempt(self, hooks, key=("old", "1")):
        """Run one settlement attempt on its own thread, exactly like the retry timer."""
        finished = threading.Event()
        results = []

        def body():
            try:
                results.append(hooks.settlement.attempt(key))
            finally:
                finished.set()

        thread = threading.Thread(target=body, name="mse-settlement-retry")
        thread.daemon = True
        thread.start()
        return finished, results

    def wait_until(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return predicate()

    def test_a_background_write_in_flight_never_costs_the_foreground_recall(self):
        # The retry is inside the boundary (a slow write); the foreground turn must wait for
        # it and still inject, and the two core calls must never overlap.
        def complete_plan(gates, state, calls):
            if state["complete_calls"] >= 2:
                gates["complete_started"].set()
                gates["release_complete"].wait(5)
        clock, calls, order, gates, state, hooks = self.build(complete_plan=complete_plan)
        try:
            self.start_turn(hooks)
            self.assertEqual(len(calls), 1)
            frozen = json.dumps(core_payload(hooks.settlement.entries[("old", "1")]["payload"]), sort_keys=True)
            finished, _ = self.background_attempt(hooks)
            self.assertTrue(gates["complete_started"].wait(5), "the retry started writing")
            resumed = hooks.pre_llm_call(session_id="resumed", turn_id="1", user_message="请导出金额并进行排序")
            self.assertFalse(state["overlap"], "the foreground and background writes must not overlap")
            gates["release_complete"].set()
            self.assertTrue(finished.wait(5))
            self.assertTrue(self.wait_until(lambda: hooks.settlement_status() == []))
            self.assertEqual(len(calls), 2, "the frozen retry still lands exactly once")
            self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
            self.assertIsNotNone(resumed, "the foreground turn still recalls")
            self.assertIn("核对数值类型", resumed["context"])
            self.assertEqual(state["max_active"], 1)
            self.assertEqual(json.dumps(core_payload(calls[-1]["payload"]), sort_keys=True), frozen)
        finally:
            gates["release_complete"].set()
            hooks.dispose()

    def test_a_held_foreground_boundary_defers_the_background_replay(self):
        # The foreground boundary is held first: the retry must not write while it is held,
        # and it must not be lost — it settles afterwards with the same frozen payload.
        clock, calls, order, gates, state, hooks = self.build()
        try:
            self.start_turn(hooks)
            self.assertEqual(len(calls), 1)
            frozen = json.dumps(core_payload(hooks.settlement.entries[("old", "1")]["payload"]), sort_keys=True)
            hooks.lock.acquire()                      # a foreground core call is in progress
            finished, _ = self.background_attempt(hooks)
            try:
                time.sleep(0.2)
                self.assertEqual(len(calls), 1, "the background write waits for the foreground boundary")
                self.assertEqual(len(hooks.settlement_status()), 1, "the frozen payload stays queued")
            finally:
                hooks.lock.release()
            self.assertTrue(finished.wait(5))
            self.assertTrue(self.wait_until(lambda: hooks.settlement_status() == []))
            self.assertEqual(len(calls), 2, "the deferred replay is not lost")
            self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
            self.assertEqual(json.dumps(core_payload(calls[-1]["payload"]), sort_keys=True), frozen)
            self.assertFalse(state["overlap"])
            self.assertEqual(state["max_active"], 1)
        finally:
            hooks.dispose()

    def test_a_recovery_turn_injects_while_the_old_cancelled_settlement_lands(self):
        # The reviewed recovery interleaving: a cancelled settlement from the takeover turn is
        # still queued when permission returns, and the resumed turn's recall starts at once.
        def complete_plan(gates, state, calls):
            gates["complete_started"].set()
            gates["release_complete"].wait(5)
        clock, calls, order, gates, state, hooks = self.build(complete_plan=complete_plan, fail_times=0)
        try:
            window = {"permitted": True}
            hooks.enabled = lambda: window["permitted"]
            self.start_turn(hooks, session="next", turn="2", settle=False)
            self.assertEqual(len(calls), 0, "the open turn has not settled yet")
            window["permitted"] = False
            self.assertIsNone(hooks.pre_llm_call(session_id="conflict", turn_id="1",
                                                 user_message="请导出金额并排序"))
            queued = hooks.settlement_status()
            self.assertEqual(len(queued), 1, "the cancelled settlement stays queued while paused")
            self.assertEqual(hooks.settlement.entries[("next", "2")]["payload"]["outcome"], "cancelled")
            # Permission returns through the real hook entry (an empty prompt resumes the
            # queue without issuing a core call of its own), then the cancelled settlement
            # lands while the recovery turn recalls.
            window["permitted"] = True
            self.assertIsNone(hooks.pre_llm_call(session_id="warm", turn_id="1", user_message=""))
            finished, _ = self.background_attempt(hooks, key=("next", "2"))
            self.assertTrue(gates["complete_started"].wait(5))
            resumed = hooks.pre_llm_call(session_id="resumed", turn_id="1", user_message="请导出金额并进行排序")
            self.assertIsNotNone(resumed, "the recovery turn must inject")
            self.assertIn("核对数值类型", resumed["context"])
            self.assertFalse(state["overlap"], "the landing cancellation and the recall must serialise")
            gates["release_complete"].set()
            self.assertTrue(finished.wait(5))
            self.assertTrue(self.wait_until(lambda: hooks.settlement_status() == []))
            self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
            self.assertEqual([row["payload"]["outcome"] for row in calls], ["cancelled"],
                             "the old cancelled outcome is replayed as itself, never rewritten")
            self.assertEqual([row["payload"].get("sessionId") for row in calls], ["next"],
                             "the old settlement never leaks into the resumed turn")
            self.assertEqual(state["max_active"], 1)
        finally:
            gates["release_complete"].set()
            hooks.dispose()

    def test_a_boundary_held_too_long_defers_with_a_transient_code(self):
        # Bounded coordination: a foreground that never releases must not hang the retry.
        original = module.SETTLEMENT_LOCK_TIMEOUT
        module.SETTLEMENT_LOCK_TIMEOUT = 0.05
        clock, calls, order, gates, state, hooks = self.build()
        try:
            self.start_turn(hooks)
            self.assertEqual(len(calls), 1)
            hooks.lock.acquire()
            finished, results = self.background_attempt(hooks)
            try:
                self.assertTrue(finished.wait(5), "a bounded wait always returns")
                self.assertEqual(len(calls), 1, "the write is refused while the boundary is held")
                self.assertEqual(results[0]["state"], "retrying")
                self.assertEqual(results[0]["code"], "lock_busy")
                self.assertEqual(len(hooks.settlement_status()), 1, "the frozen payload stays queued")
            finally:
                hooks.lock.release()
            clock.advance(0.25)                       # the scheduled retry fires
            self.assertTrue(self.wait_until(lambda: len(calls) == 2))
            self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
            self.assertFalse(state["overlap"])
        finally:
            module.SETTLEMENT_LOCK_TIMEOUT = original
            hooks.dispose()


class ObservedLock:
    """The Hooks write boundary, with a signal for "a background attempt is waiting on it"."""

    def __init__(self):
        self.raw = threading.RLock()
        self.waiting = threading.Event()
        self.acquisitions = 0

    def acquire(self, *args, **kwargs):
        self.acquisitions += 1
        if threading.current_thread().name == "mse-wait-boundary":
            self.waiting.set()
        return self.raw.acquire(*args, **kwargs)

    def release(self):
        return self.raw.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


class WaitBoundaryRevalidationTests(unittest.TestCase):
    """R3: a retry that waited for the write boundary must re-check validity under it.

    Every case holds the boundary, drives the scheduled retry onto its own thread, waits for
    the background to actually enter the lock wait, and only then changes state — so a pass
    can never come from "the retry was refused before it started".
    """

    def build(self, receipt_remaining_ms=3_600_000, fail_times=1, enqueue=None):
        clock = HookLevelClock()
        calls = []
        state = {"complete_calls": 0, "prepare_calls": 0}
        window = {"permitted": True, "prepare_result": None}

        def call(op, value):
            if op == "prepare":
                state["prepare_calls"] += 1
                if window["prepare_result"] is not None:
                    return window["prepare_result"]
                return {"ok": True, "context": "本地经验：导出金额前核对数值类型", "lessons": ["lesson-fixture"],
                        "lessonVersions": [{"id": "lesson-fixture", "version": 1, "methodId": None}],
                        "receipt": "receipt-fixture", "receiptExpiresAt": clock.wall_ms() + receipt_remaining_ms}
            if op == "complete":
                state["complete_calls"] += 1
                calls.append({"at": clock.now(), "payload": dict(value)})
                if state["complete_calls"] <= fail_times:
                    return {"ok": False, "code": "lock_busy"}
                return {"ok": True, "outcome": value["outcome"], "attributed": 0}
            return {"ok": True}

        class WaitHooks(module.Hooks):
            def __init__(inner_self, *args, **kwargs):
                inner_self.monotonic = clock.now
                inner_self.schedule = clock.schedule
                inner_self.cancel = clock.cancel
                inner_self.wall_ms = clock.wall_ms
                super().__init__(*args, **kwargs)

        hooks = WaitHooks(config={"stateRoot": "/tmp/unused-fake-engine", "adapterId": "hermes",
                                  "maxContextBytes": 768},
                          call=durable_core(call, wall=clock.wall_ms,
                                            enqueue=(lambda payload, state_: enqueue()) if enqueue else None),
                          enabled=lambda: window["permitted"])
        hooks.lock = ObservedLock()
        return clock, calls, state, window, hooks

    def start_turn(self, hooks, session="old", turn="1"):
        prepared = hooks.pre_llm_call(session_id=session, turn_id=turn, user_message="请导出金额并排序")
        self.assertIsNotNone(prepared)
        hooks.pre_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture",
                              request_messages=[{"role": "user",
                                                 "content": "请导出金额并排序\n\n" + prepared["context"]}])
        hooks.post_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture")
        self.assertTrue(hooks.verification(session, turn, "trusted-fixture", True, ["lesson-fixture"], 1))
        hooks.post_llm_call(session_id=session, turn_id=turn, completed=True)
        return prepared

    def retry_in_background(self, clock):
        """Fire the scheduled retry on its own thread; the caller holds the boundary."""
        self.assertTrue(clock.jobs, "the retry is scheduled")
        timer_id, (due, callback) = next(iter(clock.jobs.items()))
        clock.jobs.pop(timer_id)
        clock.time = due
        failures = []

        def body():
            try:
                callback()
            except Exception as exc:  # noqa: BLE001 - reported as a failed check
                failures.append(repr(exc))

        worker = threading.Thread(target=body, name="mse-wait-boundary")
        worker.daemon = True
        worker.start()
        return worker, failures

    def wait_then_change(self, action, clock, window, hooks, calls, written=1):
        """Drive one retry into the lock wait, change state, then release the boundary."""
        frozen = json.dumps(core_payload(hooks.settlement.entries[("old", "1")]["payload"]), sort_keys=True)
        with hooks.lock:
            worker, failures = self.retry_in_background(clock)
            self.assertTrue(hooks.lock.waiting.wait(5), "the background reached the lock wait")
            self.assertEqual(len(calls), written, "nothing is written while the boundary is held")
            if action == "legacy_disable":
                window["permitted"] = False
            elif action == "pause":
                hooks.set_enabled(False)
            elif action == "close":
                hooks.close_session("old")
            elif action == "dispose":
                hooks.dispose()
            elif action == "expiry":
                clock.time += 301.0
            elif action == "pause_then_expire":
                hooks.set_enabled(False)
                clock.time += 301.0
        worker.join(5)
        self.assertFalse(worker.is_alive(), "the bounded wait always returns")
        self.assertEqual(failures, [])
        return frozen

    def test_a_control_retry_still_lands_after_the_wait(self):
        clock, calls, state, window, hooks = self.build()
        try:
            self.start_turn(hooks)
            frozen = self.wait_then_change("control", clock, window, hooks, calls)
            self.assertEqual(len(calls), 2, "an unchanged retry settles after the wait")
            self.assertEqual(json.dumps(core_payload(calls[-1]["payload"]), sort_keys=True), frozen)
            self.assertEqual(hooks.settlement_status(), [])
            self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
        finally:
            hooks.dispose()

    def test_five_invalidations_during_the_wait_never_reach_the_core(self):
        # Each of these is a PERMISSION change: the host withdrew permission, paused, closed the
        # session or unloaded while the write was waiting for the boundary. The stale write must
        # never be issued, whatever the item's durability. (A deadline is a different fact, and
        # once the core acknowledged the item it belongs to the core — see the two tests below.)
        for action in ["legacy_disable", "pause", "close", "dispose"]:
            clock, calls, state, window, hooks = self.build()
            try:
                self.start_turn(hooks)
                frozen = self.wait_then_change(action, clock, window, hooks, calls)
                self.assertEqual(len(calls), 1, f"{action}: the stale write must not be issued")
                states = [row["state"] for row in hooks.settlement_history()]
                self.assertNotIn("settled", states, f"{action}: an invalid retry is never settled")
                if action in {"legacy_disable", "pause"}:
                    pending = hooks.settlement.entries.get(("old", "1"))
                    self.assertIsNotNone(pending, f"{action}: the frozen payload is kept for a resume")
                    self.assertEqual(pending["state"], "pending")
                    self.assertEqual(pending["attempts"], 1, f"{action}: a refused write consumes no attempt")
                    self.assertEqual(json.dumps(core_payload(pending["payload"]), sort_keys=True), frozen)
                    self.assertTrue(hooks.settlement.paused)
                elif action == "close":
                    self.assertIsNone(hooks.settlement.entries.get(("old", "1")))
                    self.assertEqual(states, ["stopped"], f"{action}: retired once, never settled twice")
                elif action == "dispose":
                    self.assertTrue(hooks.settlement.disposed)
                    self.assertEqual(hooks.settlement.attempt(("old", "1"))["state"], "pending",
                                     f"{action}: a disposed queue never starts another attempt")
                    self.assertEqual(len(calls), 1)
            finally:
                hooks.dispose()

    def test_the_deadline_during_the_wait_is_decided_by_the_core_not_locally(self):
        # An acknowledged item's deadline lives in the core's document, so a deadline that passes
        # while the write waits must NOT become a local terminal state: the write is issued and the
        # core's own answer governs. The payload is still the originally frozen one.
        clock, calls, state, window, hooks = self.build()
        try:
            self.start_turn(hooks)
            frozen = self.wait_then_change("expiry", clock, window, hooks, calls)
            self.assertEqual(len(calls), 2, "the core decides an acknowledged deadline")
            self.assertEqual(json.dumps(core_payload(calls[-1]["payload"]), sort_keys=True), frozen)
            self.assertEqual(hooks.settlement_status(), [])
            self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
            self.assertFalse(any(event["kind"] == "expired" for event in hooks.settlement_events),
                             "the local queue never claims an expiry the core did not answer")
        finally:
            hooks.dispose()

    def test_an_unacknowledged_deadline_during_the_wait_still_expires_locally(self):
        # The same held-boundary deadline, but the core never acknowledged the item: the adapter
        # still owns it, so it expires locally and is never written.
        clock, calls, state, window, hooks = self.build(enqueue=lambda: {"ok": False, "code": "lock_busy"})
        try:
            self.start_turn(hooks)
            self.wait_then_change("expiry", clock, window, hooks, calls, written=0)
            self.assertEqual(calls, [], "an unacknowledged settlement is never written")
            self.assertIsNone(hooks.settlement.entries.get(("old", "1")))
            self.assertEqual([row["state"] for row in hooks.settlement_history()], ["expired"])
            self.assertEqual([tuple(row["key"]) for row in hooks.settlement_history()], [("old", "1")])
        finally:
            hooks.dispose()

    def test_a_pause_during_the_wait_still_replays_after_a_legitimate_resume(self):
        clock, calls, state, window, hooks = self.build()
        try:
            self.start_turn(hooks)
            frozen = self.wait_then_change("legacy_disable", clock, window, hooks, calls)
            self.assertEqual(len(calls), 1)
            # Permission returns through a real hook entry; the frozen payload replays once.
            window["permitted"] = True
            self.assertIsNone(hooks.pre_llm_call(session_id="warm", turn_id="1", user_message=""))
            clock.advance(0)
            self.assertEqual(len(calls), 2, "the unexpired frozen payload is replayed exactly once")
            self.assertEqual(json.dumps(core_payload(calls[-1]["payload"]), sort_keys=True), frozen,
                             "the replay uses the original frozen payload")
            self.assertEqual(hooks.settlement_status(), [])
            self.assertEqual(hooks.settlement_history()[-1]["state"], "settled")
        finally:
            hooks.dispose()

    def test_a_pause_during_the_wait_that_expires_is_retired_not_written(self):
        # Never acknowledged, so the pause and the deadline are both the adapter's: the pause stops
        # the retry, the passed deadline ends it locally, and nothing is ever written late.
        clock, calls, state, window, hooks = self.build(enqueue=lambda: {"ok": False, "code": "lock_busy"})
        try:
            self.start_turn(hooks)
            self.wait_then_change("pause_then_expire", clock, window, hooks, calls, written=0)
            self.assertEqual(calls, [])
            hooks.set_enabled(True)          # the explicit pause is lifted the explicit way
            clock.advance(0)
            self.assertEqual(calls, [], "an expired settlement is never written late")
            self.assertEqual(hooks.settlement_status(), [])
            self.assertEqual(hooks.settlement_history()[-1]["state"], "expired")
        finally:
            hooks.dispose()

    def test_the_foreground_backoff_stops_when_permission_is_withdrawn(self):
        clock, calls, state, window, hooks = self.build()
        try:
            window["permitted"] = True
            first = {"ok": False, "code": "lock_busy"}

            def prepare(value):
                state["complete_calls"] += 0  # no complete involved
                window["permitted"] = False   # the host withdraws permission during the backoff
                return first
            window["prepare_result"] = first
            original_call = hooks.call

            def call(op, value):
                if op == "prepare":
                    window["permitted"] = False
                return original_call(op, value)
            hooks.call = call
            result = hooks.pre_llm_call(session_id="foreground", turn_id="1", user_message="请导出金额并排序")
            self.assertIsNone(result, "no context is invented for a failed recall")
            self.assertEqual(state["prepare_calls"], 1,
                             "the backoff re-reads the lifecycle boundary instead of issuing another call")
        finally:
            hooks.dispose()


class StopControlTests(unittest.TestCase):
    """The exact-stop control plane: intent before any wait, real bounds, per-session scope.

    Every case drives the product's real entry points (`request_stop`, `pre_llm_call`,
    `on_session_finalize`) against a scripted transport, so it can never pass because a helper was
    called in the test's own order.
    """

    WALL = 1800000000000.0

    def build(self, stop=None, pending=None, apply_ok=False):
        clock = HookLevelClock(wall_ms=self.WALL)
        state = {"stop_calls": 0, "writes": [], "enqueued": {}, "seq": 0}
        # A recovered row was acknowledged by an EARLIER process, so the core already knows its
        # handle: the fixture has to know it too, or the apply would look like an unknown key.
        for row in pending or []:
            state["enqueued"][row["key"]] = {"payloadHash": row["payloadHash"],
                                             "sessionHash": row.get("sessionHash")}

        def call(op, value):
            if op == "settlementStop":
                state["stop_calls"] += 1
                if stop is not None:
                    return stop(value, state)
                return {"ok": True, "generation": 2, "stopped": 0,
                        "sessionHash": module.session_identity(value.get("sessionId"))}
            if op == "settlementEnqueue":
                state["seq"] += 1
                key = str(value.get("_key") or value.get("turnId") or state["seq"])
                payload = core_payload(value)
                state["enqueued"][key] = {"payloadHash": "hash-" + key,
                                          "sessionHash": module.session_identity(payload.get("sessionId"))}
                return {"ok": True, "durable": True, "key": key, "payloadHash": "hash-" + key,
                        "deadline": self.WALL + 300_000.0}
            if op == "settlementApply":
                row = state["enqueued"].get(value.get("key"))
                if row is None:
                    return {"ok": True, "duplicate": True, "outcome": None, "attributed": 0}
                # Every business write is recorded with the session identity it belongs to, so a
                # test can prove a stopped session's write never happened while another one's did.
                state["writes"].append(row.get("sessionHash"))
                if not apply_ok:
                    return {"ok": False, "code": "lock_busy"}
                state["enqueued"].pop(value.get("key"), None)
                return {"ok": True, "outcome": "verified", "attributed": 0}
            if op == "settlementStatus":
                rows = pending if pending is not None else []
                return {"ok": True, "control": {"generation": 1, "userPaused": False, "stops": 0},
                        "pending": [dict(row) for row in rows], "counts": {"pending": len(rows)}}
            if op == "prepare":
                return {"ok": True, "context": "", "lessons": [], "receipt": None}
            return {"ok": False, "code": "lock_busy"}

        class StopHooks(module.Hooks):
            def __init__(inner_self, *args, **kwargs):
                inner_self.monotonic = clock.now
                inner_self.schedule = clock.schedule
                inner_self.cancel = clock.cancel
                inner_self.wall_ms = clock.wall_ms
                super().__init__(*args, **kwargs)

        hooks = StopHooks(config={"stateRoot": "/tmp/unused-fake-engine", "adapterId": "hermes",
                                  "maxContextBytes": 768}, call=call)
        return clock, state, hooks

    @staticmethod
    def entry(session):
        return {"key": (session, "1"), "sessionId": session, "sessionKey": None}

    def restored(self, digit, hash_digit, session):
        """One acknowledged row as the core's own status reports it, hash included."""
        return {"key": digit * 64, "payloadHash": hash_digit * 64, "deadline": self.WALL + 300_000.0,
                "sessionHash": module.session_identity(session)}

    def sessions(self, hooks):
        return {row["sessionKey"]: key for key, row in hooks.settlement.entries.items()}

    def test_the_stop_intent_is_published_before_any_waiting_lock(self):
        gate, release = threading.Event(), threading.Event()

        def stop(value, state):
            gate.set()
            release.wait(5)
            return {"ok": True, "generation": 2, "stopped": 0,
                    "sessionHash": module.session_identity(value.get("sessionId"))}

        clock, state, hooks = self.build(stop=stop)
        hooks.lock = ObservedLock()
        results, errors = [], []

        def worker():
            try:
                results.append(hooks.request_stop("old", "session_reset"))
            except Exception as error:  # noqa: BLE001 - surfaced as a failed check
                errors.append(repr(error))

        hooks.lock.raw.acquire()          # a foreground core call is inside the write boundary
        try:
            thread = threading.Thread(target=worker)
            thread.start()
            self.assertTrue(gate.wait(5), "the durable confirmation really started")
            self.assertEqual(sorted(hooks.local_control_pending), ["session:old"],
                             "the barrier is up while the confirmation is still in flight")
            self.assertEqual(hooks._permitted(self.entry("old")), module.SESSION_SCOPED_REFUSAL,
                             "this session may not write")
            self.assertIsNone(hooks._permitted(self.entry("other")), "another session is untouched")
            self.assertEqual(hooks.lock.acquisitions, 0,
                             "the stop path never waits on the boundary it must not wait on")
            self.assertEqual(state["stop_calls"], 1)
        finally:
            release.set()
            hooks.lock.raw.release()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(results[0]["confirmed"], "the core's own transaction is the confirmation")
        self.assertEqual(hooks.pending_stops, {}, "a confirmed stop leaves the active set")
        self.assertEqual(hooks.local_control_pending, set())
        self.assertEqual([row["state"] for row in hooks.stop_history], ["confirmed"])

    def test_a_repeated_stop_never_resets_attempts_or_the_original_deadline(self):
        clock, state, hooks = self.build(stop=lambda value, state: {"ok": False, "code": "lock_busy"})
        first = hooks.request_stop("old", "session_reset")
        deadline = first["deadline"]
        for _ in range(4):
            again = hooks.request_stop("old", "session_reset")
            self.assertEqual(again["deadline"], deadline, "a repeated event never extends the window")
        self.assertEqual(first["attempts"], 3, "three real submissions, then honest exhaustion")
        self.assertEqual(state["stop_calls"], 3, "no submission is attempted past the bound")
        self.assertEqual(hooks.pending_stops[("session", "old")]["state"], "exhausted")
        self.assertEqual(sorted(hooks.local_control_pending), ["session:old"],
                         "an unconfirmed stop keeps its barrier")
        self.assertEqual(hooks._permitted(self.entry("old")), module.SESSION_SCOPED_REFUSAL)
        # Later lifecycle moments do not keep calling the core for an exhausted stop.
        for turn in range(1, 4):
            hooks.pre_llm_call(session_id="other", turn_id=str(turn), user_message="请导出金额并排序")
        self.assertEqual(state["stop_calls"], 3)
        self.assertEqual(hooks.pending_stops[("session", "old")]["attempts"], 3)

    def test_a_confirmed_stop_leaves_the_active_set_and_history_is_bounded(self):
        clock, state, hooks = self.build()
        for index in range(65):
            record = hooks.request_stop("closed-%d" % index, "session_reset")
            self.assertTrue(record["confirmed"])
        self.assertEqual(hooks.pending_stops, {}, "65 confirmed stops hold no capacity")
        self.assertEqual(hooks.local_control_pending, set())
        self.assertLessEqual(len(hooks.stop_history), 32, "diagnostic history is bounded")
        self.assertEqual(state["stop_calls"], 65)

    def test_unconfirmed_stop_capacity_is_explicit_and_bounded(self):
        clock, state, hooks = self.build(stop=lambda value, state: {"ok": False, "code": "lock_busy"})
        for index in range(64):
            self.assertFalse(hooks.request_stop("busy-%d" % index, "session_reset")["confirmed"])
        self.assertEqual(len(hooks.pending_stops), 64)
        refused = hooks.request_stop("busy-overflow", "session_reset")
        self.assertEqual(refused["state"], "capacity")
        self.assertEqual(refused["code"], "stop_capacity")
        self.assertEqual(hooks.stop_capacity_refusals, 1)
        self.assertEqual(len(hooks.pending_stops), 64, "a refusal never silently drops a tracked stop")
        self.assertEqual(state["stop_calls"], 64, "a refused stop is never submitted")
        self.assertTrue(any(row["code"] == "stop_capacity" for row in hooks.control_errors))
        hooks.dispose()

    def test_an_unconfirmed_raw_id_stop_blocks_that_session_only(self):
        # The original defect: a raw-id stop whose confirmation failed left the restored entries
        # unblocked, so a recovered timer could still apply and credit A — or, when the barrier was
        # global, it froze B as well. Now the intent blocks exactly A, computed with the core's own
        # published identity rule, and B keeps its own timer.
        pending = [self.restored("a", "c", "blocked-session"), self.restored("b", "d", "other-session")]
        clock, state, hooks = self.build(stop=lambda value, state: {"ok": False, "code": "lock_busy"},
                                         pending=pending)
        hooks.pre_llm_call(session_id="current", turn_id="1", user_message="请导出金额并排序")
        keys = self.sessions(hooks)
        blocked_key = keys[module.session_identity("blocked-session")]
        other_key = keys[module.session_identity("other-session")]
        self.assertEqual(sorted(state["writes"]),
                         sorted([module.session_identity("blocked-session"), module.session_identity("other-session")]),
                         "both acknowledged rows were really re-driven once")
        record = hooks.request_stop("blocked-session", "session_reset")
        self.assertFalse(record["confirmed"], "the core never confirmed this stop")
        self.assertEqual(record["sessionHash"], module.session_identity("blocked-session"),
                         "the intent carries the identity the core itself would derive")
        blocked, other = hooks.settlement.entries[blocked_key], hooks.settlement.entries[other_key]
        self.assertEqual(hooks._permitted(blocked), module.SESSION_SCOPED_REFUSAL,
                         "the stopped session may not write before the confirmation lands")
        self.assertIsNone(hooks._permitted(other), "the other session keeps working")
        self.assertFalse(hooks.settlement.paused, "one session's failed stop never pauses the queue")
        self.assertIn(blocked_key, hooks.settlement.entries, "the entry stays visible, not retired")
        writes = len(state["writes"])
        self.assertEqual(hooks.settlement.attempt(blocked_key)["state"], "blocked")
        self.assertEqual(len(state["writes"]), writes, "no write may land for the stopped session")
        # The other session's own registered retry is what lands next.
        self.assertTrue(clock.jobs, "the other session keeps its scheduled retry")
        for due, callback in list(clock.jobs.values()):
            callback()
        self.assertEqual(state["writes"][-1], module.session_identity("other-session"),
                         "the other session still settles")
        self.assertEqual(state["writes"].count(module.session_identity("blocked-session")), 1,
                         "the stopped session's only write was the one before the stop")
        self.assertIn(blocked_key, hooks.settlement.entries)
        hooks.dispose()

    def test_a_confirmed_raw_id_stop_retires_exactly_the_matching_restored_entry(self):
        pending = [self.restored("a", "c", "blocked-session"), self.restored("b", "d", "other-session")]

        def stop(value, state):
            if isinstance(value.get("sessionId"), str):
                return {"ok": True, "generation": 2, "stopped": 1,
                        "sessionHash": module.session_identity(value["sessionId"])}
            entry = [row for row in pending if row["key"] == value.get("key")][0]
            return {"ok": True, "generation": 2, "stopped": 1, "sessionHash": entry["sessionHash"]}

        clock, state, hooks = self.build(stop=stop, pending=pending)
        hooks.pre_llm_call(session_id="current", turn_id="1", user_message="请导出金额并排序")
        self.assertEqual(len(hooks.settlement.entries), 2)
        record = hooks.request_stop("blocked-session", "session_reset")
        self.assertTrue(record["confirmed"])
        self.assertEqual([row["sessionKey"] for row in hooks.settlement.entries.values()],
                         [module.session_identity("other-session")],
                         "only the session the core named is retired; the other keeps retrying")
        self.assertEqual(sorted(hooks.local_control_pending), [])
        self.assertIsNone(hooks._permitted(list(hooks.settlement.entries.values())[0]))
        hooks.dispose()

    def test_a_handle_addressed_stop_is_precise_and_no_identity_stops_nothing(self):
        pending = [self.restored("a", "c", "synthetic-old"), self.restored("b", "d", "synthetic-other")]

        def stop(value, state):
            if isinstance(value.get("sessionId"), str):
                return {"ok": True, "generation": 2, "stopped": 0,
                        "sessionHash": module.session_identity(value["sessionId"])}
            entry = [row for row in pending if row["key"] == value.get("key")][0]
            return {"ok": True, "generation": 2, "stopped": 1, "sessionHash": entry["sessionHash"]}

        clock, state, hooks = self.build(stop=stop, pending=pending)
        hooks.pre_llm_call(session_id="current", turn_id="1", user_message="请导出金额并排序")
        keys = self.sessions(hooks)
        blocked_key = keys[module.session_identity("synthetic-old")]
        other_key = keys[module.session_identity("synthetic-other")]
        handle = {"key": blocked_key, "payloadHash": pending[0]["payloadHash"]}
        record = hooks.request_stop(None, "session_reset", handle=handle)
        self.assertTrue(record["confirmed"])
        self.assertEqual(list(hooks.settlement.entries), [other_key],
                         "the named entry is retired at once, the other keeps its place")
        # No identity at all names nothing: it must never be read as "every restored entry".
        self.assertEqual(hooks.settlement.stop_session(), [])
        self.assertEqual(hooks.settlement.hold_session(), [])
        self.assertEqual(list(hooks.settlement.entries), [other_key])
        hooks.dispose()

    def test_a_bounded_background_retry_confirms_without_a_new_turn(self):
        clock, state, hooks = self.build(
            stop=lambda value, state: {"ok": False, "code": "lock_busy"} if state["stop_calls"] == 1
            else {"ok": True, "generation": 2, "stopped": 0,
                  "sessionHash": module.session_identity(value.get("sessionId"))})
        record = hooks.request_stop("old", "session_reset")
        self.assertFalse(record["confirmed"])
        self.assertEqual(state["stop_calls"], 1)
        self.assertTrue(clock.jobs, "a bounded retry is scheduled without needing another turn")
        clock.advance(0.25)
        self.assertEqual(state["stop_calls"], 2)
        self.assertEqual(hooks.pending_stops, {}, "the retry's own confirmation clears the stop")
        self.assertEqual(hooks.local_control_pending, set())
        self.assertEqual([row["state"] for row in hooks.stop_history], ["confirmed"])
        hooks.dispose()


class IdentityMappingTests(unittest.TestCase):
    """The shared cross-language identity rule, checked against hashes the REAL core produced.

    `sessionHash` is the core's own public value: `src/index.mjs` hashes the UTF-8 bytes of the
    validated session id. The adapter must not guess it, so this test compares the adapter's rule
    with the value the real core actually wrote for the same id.
    """

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mse-hermes-identity-")
        self.addCleanup(self.directory.cleanup)
        self.environment = patch.dict(os.environ, {"MSE_LEARN_CLI": str(ROOT / "src/cli.mjs"),
                                    "MSE_NODE_EXECUTABLE": shutil.which("node"), "MSE_REFLECTION_ENABLED": "0"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = {"stateRoot": self.directory.name, "adapterId": "hermes", "maxContextBytes": 768}
        learner = module.Hooks(config=self.config)
        learner.pre_llm_call(session_id="seed", turn_id="1",
                             user_message="以后导出金额前先转换为数值，再按金额排序")
        learner.on_session_end(session_id="seed", turn_id="1", completed=True, failed=False, interrupted=False)

    def real_session_hash(self, session):
        """Run one real turn through the real CLI and read the core's own sessionHash back."""
        hooks = module.Hooks(config=self.config)
        prompt = "导出金额并排序"
        prepared = hooks.pre_llm_call(session_id=session, turn_id="1", user_message=prompt)
        self.assertIsNotNone(prepared, "the fixture turn must recall the seeded rule")
        hooks.pre_api_request(session_id=session, turn_id="1", api_request_id="req-1",
                              request_messages=[{"role": "user", "content": prompt + "\n\n" + prepared["context"]}])
        hooks.post_api_request(session_id=session, turn_id="1", api_request_id="req-1")
        row = hooks.turns[(session, "1")]
        lesson_id = row["lessons"][0]
        version = next(item["version"] for item in row["lesson_versions"] if item["id"] == lesson_id)
        self.assertTrue(hooks.verification(session, "1", "numeric-check", True, [lesson_id], version))
        hooks.post_llm_call(session_id=session, turn_id="1", completed=True, failed=False, interrupted=False,
                            assistant_response="金额排序完成，数值类型检查通过")
        status = hooks.durable_status()["core"]
        hooks.dispose()
        rows = list(status.get("pending") or []) + list(status.get("history") or [])
        hashes = [item.get("sessionHash") for item in rows]
        self.assertTrue(hashes, f"the core recorded no sessionHash for {session!r}: {status}")
        return set(hashes)

    def test_the_adapter_rule_reproduces_real_core_hashes(self):
        # A plain id, a CJK id with an astral character, and a decomposed accent. The core does not
        # normalise, so the composed and decomposed forms must stay different identities.
        composed = "caf\u00e9-session"
        decomposed = "cafe\u0301-session"
        for session in ("plain-session-1", "会话-📊-１", decomposed):
            hashes = self.real_session_hash(session)
            self.assertIn(module.session_identity(session), hashes,
                          f"adapter rule disagrees with the real core for {session!r}")
        self.assertNotEqual(module.session_identity(composed), module.session_identity(decomposed),
                            "the rule must not normalise what the core does not normalise")

    def test_a_non_identity_never_produces_a_hash(self):
        # The core's `identity()` refuses these before any hash exists, so the adapter must refuse
        # them too instead of inventing a mapping that could stop the wrong session.
        self.assertIsNone(module.session_identity(""))
        self.assertIsNone(module.session_identity(None))
        self.assertIsNone(module.session_identity(7))
        self.assertIsNone(module.session_identity("a" * 513))
        self.assertIsNone(module.session_identity("line\nbreak"))
        self.assertIsNone(module.session_identity("\u0000nul"))
        self.assertIsNotNone(module.session_identity("a" * 512))
