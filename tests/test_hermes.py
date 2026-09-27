import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mse_learning_bridge_test", ROOT / "adapters/hermes/bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


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
        self.assertEqual(self.hooks.call("status", {})["failed"], 1)
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
        def review(request, model):
            self.hooks.dispose()
            return json.dumps({"instruction": "导出金额时先检查数据类型，再按数值排序"})
        self.hooks.review = review
        self.hooks._reflect({"base": {"sessionId": "late", "turnId": "1"},
                             "task_summary": "根据金额列进行排序并导出", "result_summary": "金额列被错误地当成字符串进行排序", "model": "unused"}, "failed")
        self.assertEqual(self.hooks.call("status", {})["counts"]["candidate"], 0)


if __name__ == "__main__":
    unittest.main()
