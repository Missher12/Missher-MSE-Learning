"""Hermes native dispatcher integration for MSE package evidence (offline, isolated profile).

This runs the installed Hermes PluginManager, lifecycle hooks, model_tools dispatcher and real
write_file handler. The plugin source is copied into a temporary profile; no user profile, provider,
credential, or daily store is used.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def installed_workspace():
    for facts in sorted((Path.home() / ".hermes" / "installs").glob("*/facts.json")):
        try:
            venv = Path(json.loads(facts.read_text())["packages"]["venv"]["environment"])
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            continue
        workspace = venv.parent / "workspace"
        if (workspace / "model_tools.py").is_file() and (workspace / "hermes_cli" / "plugins.py").is_file():
            return workspace
    return None


WORKSPACE = installed_workspace()


@unittest.skipUnless(WORKSPACE is not None and NODE, "installed Hermes workspace and Node are required")
class NativeDispatcherEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mse-hermes-native-dispatch-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "hermes-home"
        self.project = self.root / "project"
        self.project.mkdir()
        self.plugin_root = self.root / "plugins" / "mse-learning"
        self.plugin_root.parent.mkdir()
        shutil.copytree(ROOT / "adapters" / "hermes", self.plugin_root)
        self.env = patch.dict(os.environ, {
            "HERMES_HOME": str(self.home),
            "TERMINAL_CWD": str(self.project),
            "TERMINAL_ENV": "local",
            "MSE_LEARN_CLI": str(ROOT / "src" / "cli.mjs"),
            "MSE_NODE_EXECUTABLE": NODE,
            "MSE_REFLECTION_ENABLED": "1",
            "MSE_EVALUATION_TOKENS_PER_DAY": "50000",
            "MSE_EVALUATION_CALLS_PER_DAY": "5",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        sys.path.insert(0, str(WORKSPACE))
        self.addCleanup(lambda: sys.path.remove(str(WORKSPACE)) if str(WORKSPACE) in sys.path else None)

        from hermes_cli import plugins
        from hermes_cli.plugins import PluginContext, PluginManager

        self.plugins = plugins
        self.previous_manager = plugins._plugin_manager
        self.previous_context_type = plugins.PluginContext
        self.contexts = []

        class CapturingPluginContext(PluginContext):
            def __init__(inner_self, manifest, manager):
                super().__init__(manifest, manager)
                self.contexts.append(inner_self)

        plugins.PluginContext = CapturingPluginContext
        self.addCleanup(self._restore_context_type)
        self.manager = PluginManager(scope_key=str(self.home))
        plugins._plugin_manager = self.manager
        self.addCleanup(self.manager.unload)
        self.addCleanup(self._restore_manager)
        manifest = self.manager._scan_directory(self.plugin_root.parent, source="user")[0]
        self.manager._load_plugin(manifest)
        self.loaded = self.manager._plugins[manifest.key or manifest.name]
        self.assertIsNone(self.loaded.error)
        self.plugin_context = self.contexts[-1]
        self.hooks = self.plugin_context.mse_learning

    def _restore_context_type(self):
        self.plugins.PluginContext = self.previous_context_type

    def _restore_manager(self):
        self.plugins._plugin_manager = self.previous_manager

    def _core(self, op, value):
        config = {"stateRoot": str(self.home / "mse-learning"), "adapterId": "hermes", "maxContextBytes": 768,
                  "evaluationTokensPerDay": self.hooks.config.get("evaluationTokensPerDay", 0),
                  "evaluationCallsPerDay": self.hooks.config.get("evaluationCallsPerDay", 2)}
        result = subprocess.run(
            [NODE, str(ROOT / "src" / "cli.mjs")],
            input=json.dumps({"config": config, "op": op, "input": value}),
            text=True, capture_output=True, timeout=20, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def _wait_for(self, predicate, timeout=45):
        import time
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.03)
        self.fail("timed out waiting for the isolated Hermes/core state")

    def test_real_model_tools_dispatch_drives_host_hooks_and_package_checker(self):
        from hermes_cli.lifecycle import invoke_hook
        import model_tools

        invoke_hook("pre_llm_call", session_id="native-session", turn_id="turn-1",
                    project_key=str(self.project), user_message="检查项目 package.json 的 scripts 字段类型")
        invoke_hook("pre_api_request", session_id="native-session", turn_id="turn-1", provider="openai",
                    model="offline-test-model", api_request_id="request-1",
                    request={"body": {"model": "offline-test-model", "reasoning_effort": "medium"}})

        raw = model_tools.handle_function_call(
            "write_file", {"path": "package.json", "content": '{"scripts":{"test":17}}'},
            task_id="offline-task", session_id="native-session", turn_id="turn-1",
            tool_call_id="tool-call-1", api_request_id="request-1",
        )
        host_result = json.loads(raw)
        self.assertTrue(host_result.get("verified"), host_result)
        self.assertEqual(Path(host_result["resolved_path"]), self.project / "package.json")
        self.assertEqual(json.loads((self.project / "package.json").read_text()), {"scripts": {"test": 17}})

        readback = model_tools.handle_function_call(
            "read_file", {"path": "package.json"}, task_id="offline-task", session_id="native-session",
            turn_id="turn-1", tool_call_id="tool-call-read", api_request_id="request-1",
        )
        self.assertIn('"test":17', json.loads(readback)["content"])
        control = model_tools.handle_function_call(
            "write_file", {"path": "package.json", "content": '{"scripts":{"test":"node --test"},"custom":true}'},
            task_id="offline-task", session_id="native-session", turn_id="turn-1",
            tool_call_id="tool-call-2", api_request_id="request-1",
        )
        self.assertTrue(json.loads(control).get("verified"), control)
        self.assertEqual(json.loads((self.project / "package.json").read_text()),
                         {"scripts": {"test": "node --test"}, "custom": True})

        status = self._core("taskEvidenceStatus", {})
        self.assertEqual(status["records"], 2, "real post_tool_call events recorded both checker facts")
        self.assertEqual(status["replayCases"], 1, "the real tool path produced a bad/control replay pair")

    def test_real_dispatch_reflection_registers_project_scoped_plans(self):
        import time
        import httpx
        from openai import AsyncOpenAI
        from hermes_cli.lifecycle import invoke_hook

        session = "native-auto-session"
        request_id = "native-auto-request"
        base_url = "https://native-auto.invalid/v1"
        provider = "deepseek-official"
        model = "deepseek-flash"
        effort = "max"
        cases_result = subprocess.run(
            [NODE, "--input-type=module", "-e",
             "import {packCases} from './src/domains.mjs'; console.log(JSON.stringify(packCases('package-json-structure-v1')))"],
            cwd=ROOT, text=True, capture_output=True, timeout=15, check=True,
        )
        cases = json.loads(cases_result.stdout)
        physical = []

        class FakeTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(inner_self, request):
                body = json.loads(request.content.decode("utf-8"))
                messages = body.get("messages") or [{}]
                system = messages[0].get("content", "") if isinstance(messages[0], dict) else ""
                prompt = messages[1].get("content", "") if len(messages) > 1 else ""
                physical.append(body)
                if "你是任务复盘器" in system:
                    content = json.dumps({"instruction": "修复 package.json 时只修改标准字段的错误类型，保留扩展字段并输出完整 JSON。"}, ensure_ascii=False)
                elif "独立的答案评审" in system:
                    content = json.dumps({"winner": "tie", "reason": "两侧输出满足冻结准则。",
                                          "criteria": [{"id": row["id"], "met": "both"}
                                                       for row in (cases[0].get("criteria") or [])]}, ensure_ascii=False)
                elif "Repair the package.json witness" in system:
                    try:
                        value = json.loads(prompt)
                    except Exception:
                        value = {"scripts": {"test": "node --test"}}
                    if isinstance(value, dict) and isinstance(value.get("scripts"), dict):
                        value["scripts"] = {key: "node --test" for key in value["scripts"]}
                    content = json.dumps(value, ensure_ascii=False)
                else:
                    selected = next((row for row in cases if row["prompt"] in prompt), None)
                    if selected and "冻结验证场景" in system:
                        content = json.dumps(selected["checker"]["expected"], ensure_ascii=False)
                    elif selected and "你是任务执行器" in system:
                        content = json.dumps(selected["checker"]["expected"] if "严格按下面这条方法作答" in system else {},
                                             ensure_ascii=False)
                    else:
                        content = "{}"
                return httpx.Response(200, json={"id": "chatcmpl-native", "object": "chat.completion",
                    "created": 0, "model": model,
                    "choices": [{"index": 0, "finish_reason": "stop",
                                 "message": {"role": "assistant", "content": content}}],
                    "usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}})

            async def aclose(inner_self):
                return None

        transport = FakeTransport()

        def resolver(requested_provider, requested_model):
            return {"provider": provider, "model": model, "api_mode": "chat_completions",
                    "base_url": base_url, "api_key": "isolated-fake-key"}

        def client_factory(identity, runtime):
            return AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                               http_client=httpx.AsyncClient(transport=transport, trust_env=False)), identity.model

        driver_module = __import__(self.loaded.module.__name__ + ".driver", fromlist=["ReflectionDriver"])
        self.hooks.set_plan_pass(None)
        self.hooks.set_driver_factory(lambda hooks: driver_module.ReflectionDriver(
            hooks, resolver=resolver, client_factory=client_factory, allow_direct_client=False))

        def begin_turn(turn, prompt):
            invoke_hook("pre_llm_call", session_id=session, turn_id=turn, project_key=str(self.project),
                        user_message=prompt)
            invoke_hook("pre_api_request", session_id=session, turn_id=turn, provider=provider, model=model,
                        base_url=base_url, api_mode="chat_completions", api_request_id=request_id + "-" + turn,
                        request={"body": {"model": model, "reasoning_effort": effort}})

        def tool(name, args, turn, call_id):
            result = model_tools.handle_function_call(name, args, task_id="native-auto-task", session_id=session,
                turn_id=turn, tool_call_id=call_id, api_request_id=request_id + "-" + turn)
            return json.loads(result)

        import model_tools
        begin_turn("1", "修复 package.json 的 scripts 字段类型并保留扩展字段。")
        first_bad = tool("write_file", {"path": "package.json",
            "content": '{"scripts":{"test":17},"extensionField":"keep"}'}, "1", "file-bad")
        self.assertTrue(first_bad.get("verified"), first_bad)
        read_content = tool("read_file", {"path": "package.json"}, "1", "file-read")["content"]
        self.assertIn('"test":17', read_content.split("|", 1)[-1])
        first_control = tool("write_file", {"path": "package.json",
            "content": '{"scripts":{"test":"node --test"},"extensionField":"keep"}'}, "1", "file-control")
        self.assertTrue(first_control.get("verified"), first_control)
        second_bad = tool("write_file", {"path": "package.json",
            "content": '{"scripts":{"test":17},"extensionField":"keep"}'}, "1", "file-bad-again")
        self.assertTrue(second_bad.get("verified"), second_bad)
        live_turn = self.hooks.turns.get((session, "1"), {})
        if live_turn.get("checker_recovery", {}).get("slot") != "ran":
            self.fail("checker failure did not reach the exact live-turn recovery path: " + json.dumps({
                "checkerProblem": live_turn.get("checker_problem"),
                "recovery": live_turn.get("checker_recovery"),
                "problemStatus": self._core("problemStatus", {"projectKey": str(self.project)}),
                "taskEvidence": self._core("taskEvidenceStatus", {}),
                "hookProblems": self.hooks.problems,
            }, ensure_ascii=False))
        invoke_hook("on_session_end", session_id=session, turn_id="1", completed=True,
                    assistant_response="package.json 检查两次失败，控制样本通过。")

        candidate = next((row for row in self._core("list", {"projectKey": str(self.project), "limit": 32}).get("lessons", [])
                          if row.get("kind") == "method" and "package.json" in row.get("instruction", "")), None)
        if candidate is None:
            driver = self.hooks.reflection_driver
            self.fail("checker recovery did not create a candidate: " + json.dumps({
                "recovery": live_turn.get("checker_recovery"), "hookProblems": self.hooks.problems,
                "driver": driver.status() if driver is not None else None,
                "problemStatus": self._core("problemStatus", {"projectKey": str(self.project)}),
                "sourceStatus": self._core("sourceStatus", {"limit": 32}),
                "wire": [{"system": (body.get("messages") or [{}])[0].get("content", "")[:100],
                          "reply": (body.get("messages") or [{}, {}])[1].get("content", "")[:100]}
                         for body in physical[-4:]],
            }, ensure_ascii=False))
        problem_rows = self._core("problemStatus", {"projectKey": str(self.project)}).get("rows", [])
        checker_problem = next((row for row in problem_rows if row.get("toolName") == "project_manifest_file"), None)
        self.assertIsNotNone(checker_problem, problem_rows)
        self.assertEqual(checker_problem.get("state"), "candidate_created")
        self.assertEqual(checker_problem.get("evidenceRevision"), 2)
        self.assertEqual(checker_problem.get("lessonId"), candidate["id"])
        task_status = self._core("taskEvidenceStatus", {})
        self.assertEqual(task_status["records"], 3)
        self.assertEqual(task_status["replayCases"], 1)

        # Exercise the shipped registration path without starting paid evaluation work. The route
        # and project identity must come from this host's observed session facts; the core resolves
        # the pack, case and criteria itself.
        from hermes_plugins.mse_learning import plan as plan_module

        auto_pass = plan_module.build_auto_pass(
            self.hooks, call=self.hooks.call, clock=time.monotonic, state=self.hooks.plan,
            schedule=lambda fn, delay: None, cancel=lambda handle: None)
        rows = self._core("autoCandidates", {"limit": 8})["rows"]
        audit = {"registered": 0}
        notes = []
        auto_pass._register(rows, audit, notes.append)

        plans = self._core("autoPlans", {})
        candidate_plans = [row for row in plans if row.get("lessonId") == candidate["id"]]
        self.assertEqual({row.get("track") for row in candidate_plans}, {"review", "objective"}, notes)
        self.assertEqual(audit["registered"], 2)
        for row in candidate_plans:
            self.assertEqual(row["source"].get("projectKey"), str(self.project))
            self.assertEqual(row.get("packId"), "package-json-structure-v1")
            self.assertTrue(row.get("caseId"))
        self.assertEqual(len(physical), 1, "only reflection used the fake transport; registration made no provider call")

    def test_real_checker_to_auto_validation_adoption_regression_and_cold_read(self):
        import time
        import httpx
        from openai import AsyncOpenAI
        from hermes_cli.lifecycle import invoke_hook
        from hermes_plugins.mse_learning import plan as plan_module
        from hermes_plugins.mse_learning import bridge as bridge_module
        import model_tools

        session, request_id = "native-full-session", "native-full-request"
        base_url, provider, model, effort = "https://native-full.invalid/v1", "deepseek-official", "deepseek-flash", "max"
        cases_result = subprocess.run(
            [NODE, "--input-type=module", "-e",
             "import {packCases} from './src/domains.mjs'; console.log(JSON.stringify(packCases('package-json-structure-v1')))"],
            cwd=ROOT, text=True, capture_output=True, timeout=15, check=True)
        cases = json.loads(cases_result.stdout)
        physical, cli_failures = [], []

        class FakeTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(inner_self, request):
                body = json.loads(request.content.decode("utf-8"))
                messages = body.get("messages") or [{}]
                system = messages[0].get("content", "") if isinstance(messages[0], dict) else ""
                prompt = messages[1].get("content", "") if len(messages) > 1 else ""
                physical.append({"system": system[:120], "prompt": prompt[:200],
                                 "promptChars": len(prompt), "maxTokens": body.get("max_tokens")})
                if "你是任务复盘器" in system:
                    content = json.dumps({"instruction": "修复 package.json 时只修改标准字段的错误类型，保留扩展字段并输出完整 JSON。"}, ensure_ascii=False)
                elif "独立的答案评审" in system:
                    content = json.dumps({"winner": "tie", "reason": "两份答案均满足冻结准则且保留输入字段。",
                        "criteria": [{"id": row["id"], "met": "both"}
                                     for row in (cases[0].get("criteria") or [])]}, ensure_ascii=False)
                elif "Repair the package.json witness" in system:
                    value = json.loads(prompt)
                    for key, item in list(value.items()):
                        if key == "scripts" and isinstance(item, dict):
                            value[key] = {name: ("node --test" if not isinstance(script, str) else script)
                                          for name, script in item.items()}
                        elif key == "private" and not isinstance(item, bool):
                            value[key] = True
                        elif key == "keywords" and isinstance(item, str):
                            value[key] = [part.strip() for part in item.split(",")]
                        elif key == "browser" and not isinstance(item, (str, dict)):
                            value[key] = "./browser.js"
                        elif key == "dependencies" and isinstance(item, dict):
                            value[key] = {name: ("^1.0.0" if not isinstance(dep, str) else dep)
                                          for name, dep in item.items()}
                        elif key == "devDependencies" and isinstance(item, dict):
                            value[key] = {name: ("^3.0.0" if not isinstance(dep, str) else dep)
                                          for name, dep in item.items()}
                        elif key == "bundleDependencies" and not isinstance(item, (bool, list)):
                            value[key] = True
                        elif key == "bundledDependencies" and not isinstance(item, (bool, list)):
                            value[key] = ["alpha"]
                        elif key == "contributors" and isinstance(item, list):
                            value[key] = ["Ada Lovelace" if not isinstance(person, (str, dict))
                                          and not (isinstance(person, dict) and isinstance(person.get("name"), str))
                                          else person for person in item]
                        elif key == "author" and isinstance(item, dict) and not isinstance(item.get("name"), str):
                            value[key] = {**item, "name": "Ada"}
                        elif key == "engines" and isinstance(item, dict):
                            value[key] = {name: (">=22" if not isinstance(version, str) else version)
                                          for name, version in item.items()}
                        elif key == "funding" and not isinstance(item, (str, dict, list)):
                            value[key] = "https://example.test/fund"
                    content = json.dumps(value, ensure_ascii=False)
                else:
                    selected = next((row for row in cases if row["prompt"] in prompt), None)
                    if selected is not None and ("冻结验证场景" in system or "严格按下面这条方法作答" in system):
                        content = json.dumps(selected["checker"]["expected"], ensure_ascii=False)
                    else:
                        content = "{}"
                return httpx.Response(200, json={"id": "chatcmpl-native-full", "object": "chat.completion",
                    "created": 0, "model": model,
                    "choices": [{"index": 0, "finish_reason": "stop",
                                 "message": {"role": "assistant", "content": content}}],
                    "usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}})

            async def aclose(inner_self):
                return None

        transport = FakeTransport()

        def resolver(requested_provider, requested_model):
            return {"provider": provider, "model": model, "api_mode": "chat_completions",
                    "base_url": base_url, "api_key": "isolated-fake-key"}

        def client_factory(identity, runtime):
            return (AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                                http_client=httpx.AsyncClient(transport=transport, trust_env=False)), identity.model)

        driver_module = __import__(self.loaded.module.__name__ + ".driver", fromlist=["ReflectionDriver"])
        self.hooks.set_driver_factory(lambda hooks: driver_module.ReflectionDriver(
            hooks, resolver=resolver, client_factory=client_factory, allow_direct_client=False))

        original_run = bridge_module.subprocess.run

        def traced_run(command, *args, **kwargs):
            result = original_run(command, *args, **kwargs)
            if isinstance(command, (list, tuple)) and str(ROOT / "src" / "cli.mjs") in command:
                try:
                    op = json.loads(kwargs.get("input", "{}")).get("op")
                    output = json.loads(result.stdout) if result.stdout else None
                    code = output.get("code") if isinstance(output, dict) else None
                    if len(result.stdout.encode("utf-8")) > 8192 or code is not None or not isinstance(output, dict):
                        cli_failures.append({"op": op, "code": code, "stdoutBytes": len(result.stdout.encode("utf-8")),
                                             "responseType": type(output).__name__,
                                             "responseKeys": sorted(output)[:16] if isinstance(output, dict) else []})
                        del cli_failures[:-24]
                except Exception:  # noqa: BLE001
                    pass
            return result

        bridge_module.subprocess.run = traced_run
        self.addCleanup(setattr, bridge_module.subprocess, "run", original_run)

        def begin_turn(turn, prompt, messages=None):
            invoke_hook("pre_llm_call", session_id=session, turn_id=turn, project_key=str(self.project),
                        user_message=prompt)
            invoke_hook("pre_api_request", session_id=session, turn_id=turn, provider=provider, model=model,
                        base_url=base_url, api_mode="chat_completions", api_request_id=request_id + "-" + turn,
                        request={"body": {"model": model, "reasoning_effort": effort}},
                        request_messages=messages or [{"role": "user", "content": prompt}])

        def tool(name, args, turn, call_id):
            raw = model_tools.handle_function_call(name, args, task_id="native-full-task", session_id=session,
                turn_id=turn, tool_call_id=call_id, api_request_id=request_id + "-" + turn)
            return json.loads(raw)

        def lesson(lesson_id):
            result = self._core("list", {"projectKey": str(self.project), "limit": 100})
            return next((row for row in result.get("lessons", []) if row.get("id") == lesson_id), None)

        begin_turn("1", "修复 package.json 的 scripts 字段类型并保留扩展字段。")
        bad = '{"scripts":{"test":17},"extensionField":"keep"}'
        control = '{"scripts":{"test":"node --test"},"extensionField":"keep"}'
        self.assertTrue(tool("write_file", {"path": "package.json", "content": bad}, "1", "bad-1").get("verified"))
        self.assertTrue(tool("write_file", {"path": "package.json", "content": control}, "1", "control").get("verified"))
        self.assertTrue(tool("write_file", {"path": "package.json", "content": bad}, "1", "bad-2").get("verified"))
        first_turn = self.hooks.turns[(session, "1")]
        self.assertEqual(first_turn.get("checker_recovery", {}).get("slot"), "ran", first_turn.get("checker_recovery"))
        invoke_hook("on_session_end", session_id=session, turn_id="1", completed=True,
                    assistant_response="package.json 检查两次失败，控制样本通过。")
        candidate = self._wait_for(lambda: next((row for row in self._core("list", {
            "projectKey": str(self.project), "limit": 32}).get("lessons", [])
            if row.get("kind") == "method" and "package.json" in row.get("instruction", "")), None), timeout=10)
        problem = next((row for row in self._core("problemStatus", {"projectKey": str(self.project)}).get("rows", [])
                        if row.get("toolName") == "project_manifest_file"), None)
        self.assertEqual(problem.get("state"), "candidate_created")
        self.assertEqual(problem.get("lessonId"), candidate["id"])
        self.assertEqual(self._core("taskEvidenceStatus", {})["records"], 3)
        self.assertEqual(self._core("taskEvidenceStatus", {})["replayCases"], 1)

        self.hooks.set_plan_pass(lambda hooks: plan_module.build_auto_pass(
            hooks, call=hooks.call, clock=time.monotonic, state=hooks.plan,
            schedule=lambda fn, delay: None, cancel=lambda handle: None))
        self.hooks.start_auto_pass("native-full-start")
        deadline = time.monotonic() + 180
        validated = None
        last_plans = []
        while time.monotonic() < deadline:
            self.hooks.auto_pass("native-full-step")
            current = lesson(candidate["id"])
            validated = current if current and current.get("status") == "validated" else None
            if validated is not None:
                break
            last_plans = self._core("autoPlans", {})
            failed_plan = next((row for row in last_plans if row.get("lessonId") == candidate["id"]
                                and row.get("stage") == "blocked"), None)
            if failed_plan is not None:
                self.fail("automatic trajectory stopped at a blocked plan: " + json.dumps({
                    "plan": failed_plan, "cliFailures": cli_failures[-12:], "wire": physical[-12:],
                    "pass": self.hooks.auto_pass_status(),
                }, ensure_ascii=False))
            time.sleep(0.2)
        if validated is None:
            self.fail("automatic package-json validation timed out: " + json.dumps({
                "plans": last_plans, "cliFailures": cli_failures[-12:], "wire": physical[-12:],
                "pass": self.hooks.auto_pass_status(),
            }, ensure_ascii=False))
        self.assertEqual(validated.get("validation", {}).get("decision"), "accepted")
        self.assertEqual(validated.get("validation", {}).get("domain", {}).get("packId"), "package-json-structure-v1")

        context = self.hooks.pre_llm_call(session_id=session, turn_id="2", project_key=str(self.project),
            user_message=candidate["instruction"])
        recall = self.hooks.turns[(session, "2")]
        self.assertIn(candidate["id"], recall.get("lessons", []), context)
        recalled_context = recall.get("context", "")
        prompt = candidate["instruction"] + "\n\n" + recalled_context
        invoke_hook("pre_api_request", session_id=session, turn_id="2", provider=provider, model=model,
            base_url=base_url, api_mode="chat_completions", api_request_id=request_id + "-2",
            request={"body": {"model": model, "reasoning_effort": effort}},
            request_messages=[{"role": "user", "content": prompt}])
        invoke_hook("post_api_request", session_id=session, turn_id="2", api_request_id=request_id + "-2")
        adopted = tool("write_file", {"path": "package.json",
            "content": '{"scripts":{"test":17},"extensionField":"counterexample"}'}, "2", "counterexample")
        self.assertTrue(adopted.get("verified"), adopted)
        invoke_hook("on_session_end", session_id=session, turn_id="2", completed=True,
                    assistant_response="package.json 文件已更新。")
        withdrawn = lesson(candidate["id"])
        self.assertEqual(withdrawn.get("status"), "suspended", withdrawn)
        self.assertEqual(withdrawn.get("suspensionReason"), "regression")
        self.assertEqual(self._core("taskEvidenceStatus", {})["records"], 4)
        ledger = json.loads((self.home / "mse-learning" / "lessons-v1.json").read_text())
        self.assertEqual(len(ledger.get("taskEvidence", {}).get("adoptionAttributions", [])), 1)
        self.manager.unload()
        cold_row = lesson(candidate["id"])
        self.assertEqual(cold_row.get("status"), "suspended")
        self.assertEqual(cold_row.get("suspensionReason"), "regression")
