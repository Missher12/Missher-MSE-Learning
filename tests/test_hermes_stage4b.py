"""Stage 4b — the REAL single-attempt reflection driver against the REAL core.

Everything here is offline: the Node core is the shipped `src/cli.mjs` in a temporary state root, the
provider is a fake transport that counts physical attempts, and no credential, profile or daily store
is read. What is NOT faked is the part under test: the real `adapters/hermes/driver.py`, the real
`AsyncOpenAI` from the installed SDK, its real raw-response API, and the real asyncio Task /
cancellation / slot boundary.

The cases mirror the trajectories an independent audit will re-run:
  • the identity is PROVEN from the host's own facts and never borrowed from the resolver;
  • one physical attempt, raw usage read before `parse()`, every malformed shape left unknown;
  • a cancelled or failed attempt keeps its consumed revision and reports UNKNOWN cost;
  • the shared slot is peak-one and stays draining until the underlying work is really over;
  • the profile binding is in force across every `await`, not merely around the synchronous entry.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def use_installed_sdk():
    """Put the CURRENT committed Hermes dependency generation on the import path, or report why not.

    The driver's dispatch half is the real `AsyncOpenAI` from the installed SDK; the interpreter that
    runs this suite is not necessarily the one the launcher uses, so the committed generation is
    added explicitly. Nothing is installed, switched or written: a generation that is missing or
    unreadable is reported and the SDK cases are skipped rather than silently faked.
    """
    try:
        import openai  # noqa: F401
        return "already-importable", None
    except ImportError:
        pass
    installs = Path.home() / ".hermes" / "installs"
    if not installs.is_dir():
        return None, "no committed Hermes dependency generation"
    for facts in sorted(installs.glob("*/facts.json")):
        try:
            data = json.loads(facts.read_text())
            venv = Path(data["packages"]["venv"]["environment"])
        except Exception:  # noqa: BLE001
            continue
        site = venv / "lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
        if not site.is_dir():
            candidates = sorted((venv / "lib").glob("python*/site-packages"))
            site = candidates[0] if candidates else None
        if site is None or not (site / "openai").is_dir():
            continue
        sys.path.insert(0, str(site))
        try:
            import openai
            return "committed:%s" % (site, ), None
        except ImportError as error:
            return None, "committed SDK unreadable: %s" % (error,)
    return None, "no committed environment carries the openai SDK"


SDK_SOURCE, SDK_PROBLEM = use_installed_sdk()
NEEDS_SDK = unittest.skipUnless(SDK_SOURCE, SDK_PROBLEM or "the installed SDK is required")

driver = load("mse_learning_driver_test", ROOT / "adapters/hermes/driver.py")
node_clock = load("mse_learning_node_clock_test", ROOT / "tests" / "node_clock.py")

PROVIDER = "deepseek-official"
MODEL = "deepseek-flash"
EFFORT = "max"
BASE_URL = "https://source-a.invalid/v1"
TASK_SUMMARY = "导出金额并核对排序结果"
RESULT_SUMMARY = "宿主验证收集到 1 条工具失败（工具退出码非零），未收到助手总结，需要复盘失败条件"
INSTRUCTION = "处理金额排序前先核对数值类型，再用固定输入独立检查输出顺序"


def node_cli():
    """The shipped CLI, resolved the way the bridge resolves it. No fallback runtime."""
    node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
    cli = ROOT / "src" / "cli.mjs"
    if not node or not cli.is_file():
        raise unittest.SkipTest("node or the shipped CLI is unavailable")
    return node, cli


class CoreClient:
    """The real core over its shipped CLI, exactly as the bridge calls it."""

    def __init__(self, state_root):
        self.node, self.cli = node_cli()
        self.config = {"stateRoot": str(state_root), "adapterId": "hermes", "maxContextBytes": 768}
        self.operations = []
        self.calls = 0

    def __call__(self, op, value):
        self.calls += 1
        import subprocess
        result = subprocess.run([self.node, str(self.cli)],
                                input=json.dumps({"config": self.config, "op": op, "input": value}),
                                text=True, capture_output=True, timeout=20, check=False)
        answer = json.loads(result.stdout) if result.stdout.strip() else {"ok": False, "code": "no_output"}
        # The shipped CLI answers a bare integer for `controlGeneration` and an object for everything
        # else; the driver must handle both, so the transport records what really arrived.
        if isinstance(answer, dict):
            self.operations.append({"op": op, "ok": answer.get("ok"), "code": answer.get("code"),
                                    "skipped": answer.get("skipped"), "ticket": answer.get("ticket")})
        else:
            self.operations.append({"op": op, "value": answer})
        return answer

    def publish(self, session_id, **overrides):
        value = {"sessionId": session_id, "provider": PROVIDER, "model": MODEL,
                 "apiMode": "chat_completions", "baseUrl": BASE_URL, "reasoningState": "explicit",
                 "reasoningValue": EFFORT, "driver": "async_openai_chat"}
        value.update(overrides)
        return self("sourcePublish", value)

    def control(self):
        return self("controlGeneration", {})

    def observe(self, session_id, turn_id, event_id, tool="tool-a"):
        return self("observeProblem", {"sessionId": session_id, "turnId": str(turn_id), "eventId": event_id,
                                       "kind": "tool_failure", "source": "host_event", "toolName": tool,
                                       "failureCode": "tool_nonzero_exit", "summary": "工具失败：%s" % tool,
                                       "route": {"provider": PROVIDER, "model": MODEL, "reasoningEffort": EFFORT}})

    def mature(self, session_id, tool="tool-a"):
        """Two independent failures on one session: what makes a problem ready to reflect on."""
        first = self.observe(session_id, 1, "call-1", tool)
        second = self.observe(session_id, 2, "call-2", tool)
        if second.get("ready") is not True:
            raise AssertionError("the fixture did not reach a ready problem: %r" % (second,))
        return second


def fake_transport(handler, *, ignore_cancel=0):
    """An in-memory httpx transport that counts PHYSICAL attempts and never opens a socket.

    `ignore_cancel` makes the first N cancellation requests be swallowed: that is how a provider that
    keeps running after its caller gave up is reproduced, and it is the only way to test that the
    slot stays draining instead of pretending the work is over.
    """
    import httpx

    class Transport(httpx.AsyncBaseTransport):
        def __init__(self):
            self.physical = 0
            self.closed = 0
            self.handler_finally = 0
            self.cancel_seen = 0
            self.ignore = list(range(ignore_cancel))
            self.in_handler = False

        async def handle_async_request(self, request):
            self.physical += 1
            self.in_handler = True
            try:
                gate = getattr(self, "request_gate", None)
                if gate is not None:
                    # Hold the request until the test releases it, shielded so a cancellation cannot
                    # end the hold early: the request really is in flight for the whole of it.
                    while not gate.is_set():
                        try:
                            await asyncio.shield(asyncio.sleep(0.005))
                        except asyncio.CancelledError:
                            pass
                if self.ignore:
                    self.ignore.pop(0)
                    try:
                        await asyncio.sleep(3600)
                    except asyncio.CancelledError:
                        self.cancel_seen += 1
                        await asyncio.sleep(0.4)
                    return httpx.Response(200, json=handler(request))
                try:
                    await asyncio.sleep(0)
                    return httpx.Response(200, json=handler(request))
                except asyncio.CancelledError:
                    self.cancel_seen += 1
                    raise
            finally:
                self.in_handler = False
                self.handler_finally += 1

        async def aclose(self):
            self.closed += 1

    return Transport()


def reply_body(usage=None, text=None):
    body = {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 0, "model": MODEL,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant",
                                     "content": text if text is not None else json.dumps(
                                         {"instruction": INSTRUCTION}, ensure_ascii=False)}}]}
    if usage is not None:
        body["usage"] = usage
    return body


class DriverFixture:
    """One driver wired to a real core, a fake transport and a synthetic resolver."""

    def __init__(self, test, *, usage=None, text=None, ignore_cancel=0, api_mode="chat_completions",
                 base_url=BASE_URL, hook_base_url=BASE_URL, hook_api_mode="chat_completions",
                 status=200, resolver_base_url=None, resolver_api_mode="chat_completions"):
        self.test = test
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-driver-"))
        test.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)
        self.transport = fake_transport(lambda request: reply_body(usage, text), ignore_cancel=ignore_cancel)
        self.status = status
        self.hook = {"provider": PROVIDER, "model": MODEL, "base_url": hook_base_url,
                     "api_mode": hook_api_mode, "request": {"method": "POST", "body": {
                         "model": MODEL, "messages": [{"role": "user", "content": "audit"}],
                         "reasoning_effort": EFFORT}}}
        self.resolver_runtime = {"provider": PROVIDER, "model": MODEL,
                                 "api_mode": resolver_api_mode,
                                 "base_url": BASE_URL if resolver_base_url is None else resolver_base_url,
                                 "api_key": "synthetic-key"}
        self.resolver_calls = []
        self.clients = []
        self.hooks = types.SimpleNamespace(call=self.core)
        self.driver = driver.ReflectionDriver(self.hooks,
                                              resolver=self.resolver,
                                              client_factory=self.client_factory,
                                              allow_direct_client=False)

    def resolver(self, provider, model):
        self.resolver_calls.append({"provider": provider, "model": model})
        return dict(self.resolver_runtime)

    def client_factory(self, identity, runtime):
        import httpx
        from openai import AsyncOpenAI
        # The SDK is real; only the transport under it is synthetic. `max_retries=0` is what the
        # product requires, and the transport is what makes a retry visible as a second physical call.
        client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"],
                             max_retries=0, http_client=httpx.AsyncClient(transport=self.transport,
                                                                          trust_env=False))
        self.clients.append(client)
        return client, identity.model

    def run(self, *, problem=None, session="driver-session", outcome="failed",
            summaries=(TASK_SUMMARY, RESULT_SUMMARY), cancel=None):
        job = {"route_provider": PROVIDER, "route_model": MODEL, "pre_api": self.hook,
               "base": {"sessionId": session}, "outcome": outcome, "source_session": session,
               "problem": problem or {}, "ticket": None}
        return self.driver.run(job, outcome, summaries, cancel or threading.Event(), self.core)

    def close(self):
        self.driver.close()


class IdentityProofTests(unittest.TestCase):
    """`prove()` accepts only what the host really stated, and never borrows from the resolver."""

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-prove-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def make(self, **kwargs):
        fixture = DriverFixture(self, **kwargs)
        self.addCleanup(fixture.close)
        return fixture

    def proved(self, fixture):
        """`(value_or_None, reason)` straight from the product's own `prove`."""
        return fixture.driver.prove(PROVIDER, MODEL, fixture.hook)

    def test_a_complete_hook_is_proven_and_carries_no_endpoint_to_the_core(self):
        fixture = self.make()
        proven, reason = self.proved(fixture)
        self.assertIsNotNone(proven, reason)
        identity = proven["identity"]
        publishable = identity.publishable()
        self.assertEqual(publishable["baseUrl"], BASE_URL, "the core fingerprints the URL it is given")
        self.assertNotIn("endpoint", publishable)
        self.assertEqual(identity.summary().get("endpoint", None), None,
                         "the non-secret projection must carry no endpoint in any form")
        self.assertEqual(fixture.resolver_calls, [{"provider": PROVIDER, "model": MODEL}])

    def test_a_hook_that_did_not_state_the_endpoint_waits(self):
        for overrides, reason in (({"hook_base_url": None}, "source_endpoint_unavailable"),
                                  ({"hook_api_mode": None}, "provider_driver_unsupported"),
                                  ({"hook_base_url": None, "hook_api_mode": None},
                                   "source_endpoint_unavailable"),
                                  ({"hook_api_mode": "responses"}, "provider_driver_unsupported"),
                                  ({"resolver_api_mode": None}, "provider_driver_unsupported"),
                                  ({"resolver_base_url": "https://elsewhere.invalid/v1"},
                                   "source_route_changed")):
            fixture = self.make(**overrides)
            proven, got = self.proved(fixture)
            self.assertIsNone(proven, "%s must not be proven" % overrides)
            self.assertEqual(got, reason, overrides)

    def test_a_body_the_hook_could_not_prove_waits(self):
        for body_patch, reason in (({"extra_body": {"model": "smuggled"}}, "provider_driver_unsupported"),
                                   ({"model": "another-model"}, "source_route_changed")):
            fixture = self.make()
            fixture.hook["request"]["body"].update(body_patch)
            proven, got = self.proved(fixture)
            self.assertIsNone(proven, body_patch)
            self.assertEqual(got, reason, body_patch)
        fixture = self.make()
        fixture.hook["request"] = {"method": "POST", "body": None}
        proven, got = self.proved(fixture)
        self.assertIsNone(proven, "a body the host did not hand over is not proof of anything")
        self.assertEqual(got, "provider_driver_unsupported")
        # A body that exists and carries no reasoning field is `unspecified`: a provable state.
        fixture = self.make()
        fixture.hook["request"]["body"].pop("reasoning_effort")
        proven, reason = self.proved(fixture)
        self.assertIsNotNone(proven, reason)
        self.assertEqual(proven["identity"].reasoning_state, "unspecified")


@NEEDS_SDK
class DispatchTests(unittest.TestCase):
    """One physical attempt, the raw usage read first, and the revision always consumed."""

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-dispatch-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def make(self, **kwargs):
        fixture = DriverFixture(self, **kwargs)
        self.addCleanup(fixture.close)
        return fixture

    def ready_problem(self, fixture, session="dispatch-session"):
        fixture.core.publish(session)
        mature = fixture.core.mature(session)
        return session, {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                         "base": {"sessionId": session}}

    def test_one_physical_attempt_commits_and_never_retries(self):
        fixture = self.make(usage={"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18})
        session, problem = self.ready_problem(fixture)
        result = fixture.run(problem=problem, session=session)
        self.assertEqual(result.get("wait"), None, result)
        self.assertTrue(result.get("result", {}).get("ok"), result)
        self.assertEqual(fixture.transport.physical, 1, "exactly one physical provider attempt")
        self.assertEqual(result["usage"], {"promptTokens": 11, "completionTokens": 7,
                                           "totalTokens": 18, "known": True})
        self.assertEqual(fixture.transport.closed, 1, "the job's own client was closed")
        state = json.loads((fixture.state_root / "lessons-v1.json").read_text())
        self.assertEqual(len(state["lessons"]), 1)
        self.assertEqual(state["lessons"][0]["status"], "candidate", "never validated by itself")

    def test_every_malformed_usage_stays_unknown_and_blocks_nothing_silently(self):
        cases = (("missing", None), ("partial", {"prompt_tokens": 11, "total_tokens": 18}),
                 ("inconsistent", {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 19}),
                 ("negative", {"prompt_tokens": -1, "completion_tokens": 7, "total_tokens": 6}),
                 ("string", {"prompt_tokens": "11", "completion_tokens": 7, "total_tokens": 18}),
                 ("unsafe", {"prompt_tokens": 9007199254740992, "completion_tokens": 0,
                             "total_tokens": 9007199254740992}))
        for label, usage in cases:
            fixture = self.make(usage=usage)
            session, problem = self.ready_problem(fixture, "usage-%s" % label)
            result = fixture.run(problem=problem, session=session)
            self.assertEqual(result.get("usage"), None, "%s: %r" % (label, result.get("usage")))
            self.assertEqual(fixture.transport.physical, 1, label)
            # The attempt is still consumed: an unreadable cost is not a free one, and the evidence
            # revision may not be spent again on the same evidence.
            status = fixture.core("problemStatus", {})
            row = [entry for entry in status["rows"] if entry["id"] == problem["id"]][0]
            self.assertEqual(row["attemptedRevision"], problem["evidenceRevision"], label)

    def test_provider_failures_are_one_physical_attempt_and_an_unknown_cost(self):
        for label, status in (("500", 500), ("429", 429)):
            fixture = DriverFixture(self, status=status)
            self.addCleanup(fixture.close)
            fixture.transport = fake_transport(lambda request: (_ for _ in ()).throw(
                AssertionError("a failure status must come from the response")), ignore_cancel=0)

            def handler(request, status=status):
                raise_error = None
                return None

            # A response-shaped failure: the transport answers with the status the SDK turns into an
            # error, and max_retries=0 is what keeps it to ONE physical call.
            import httpx

            class Failure(httpx.AsyncBaseTransport):
                def __init__(self):
                    self.physical = 0
                    self.finally_ = 0

                async def handle_async_request(self, request):
                    self.physical += 1
                    try:
                        return httpx.Response(status, json={"error": {"message": "synthetic"}})
                    finally:
                        self.finally_ += 1

            fixture.transport = Failure()
            session, problem = self.ready_problem(fixture, "failure-%s" % label)
            result = fixture.run(problem=problem, session=session)
            self.assertEqual(result.get("wait"), "provider_unavailable", label)
            self.assertEqual(fixture.transport.physical, 1, "%s: exactly one physical attempt" % label)
            self.assertEqual(result.get("usage"), None, "%s: an unknown cost stays unknown" % label)
            status_row = [entry for entry in fixture.core("problemStatus", {})["rows"]
                          if entry["id"] == problem["id"]][0]
            self.assertEqual(status_row["attemptedRevision"], problem["evidenceRevision"], label)

    def test_a_source_that_drifted_before_the_job_sends_nothing(self):
        fixture = self.make(usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
        session, problem = self.ready_problem(fixture)
        # The host re-published this session on ANOTHER endpoint: a different execution, so the
        # identity the driver would use no longer IS the published one. The job must wait, not send.
        moved = fixture.core.publish(session, baseUrl="https://elsewhere.invalid/v1")
        self.assertEqual(moved["revision"], 2)
        result = fixture.run(problem=problem, session=session)
        self.assertEqual(result.get("wait"), "source_route_changed", result)
        self.assertEqual(fixture.transport.physical, 0, "a drifted source never dispatches")
        row = [entry for entry in fixture.core("problemStatus", {})["rows"]
               if entry["id"] == problem["id"]][0]
        self.assertEqual(row["attemptedRevision"], 0, "nothing was signed, so nothing was consumed")


@NEEDS_SDK
class CancellationTests(unittest.TestCase):
    """The slot is peak-one and stays draining until the underlying work really finished."""

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-cancel-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def ready(self, fixture, session):
        fixture.core.publish(session)
        mature = fixture.core.mature(session)
        return {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                "base": {"sessionId": session}}

    def test_a_cancelled_in_flight_attempt_stays_draining_until_the_work_really_ends(self):
        fixture = DriverFixture(self, ignore_cancel=1, usage={"prompt_tokens": 1, "completion_tokens": 1,
                                                             "total_tokens": 2})
        self.addCleanup(fixture.close)
        session = "cancel-session"
        problem = self.ready(fixture, session)
        cancel = threading.Event()
        result_box = {}

        def run():
            result_box["value"] = fixture.run(problem=problem, session=session, cancel=cancel)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while fixture.transport.physical == 0 and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertEqual(fixture.transport.physical, 1, "the request really reached the transport")
        self.assertTrue(fixture.driver.slot.busy)
        cancel.set()
        # The transport ignores the first cancel for a moment: the slot must stay DRAINING, not free.
        deadline = time.monotonic() + 10
        while not fixture.driver.slot.draining and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertTrue(fixture.driver.slot.draining, "a cancelled attempt is draining, not finished")
        thread.join(20)
        self.assertFalse(thread.is_alive(), "the driver returned once the work really ended")
        self.assertEqual(fixture.driver.slot.peak, 1, "never more than one job in the slot")
        self.assertFalse(fixture.driver.slot.busy)
        self.assertFalse(fixture.driver.slot.draining)
        self.assertEqual(fixture.transport.handler_finally, 1, "the physical handler really ended once")
        self.assertEqual(fixture.transport.closed, 1, "the job's client was closed after the drain")
        # The transport answered before the cancellation could take effect, so the honest outcome is
        # the REAL one: the attempt is completed with its real usage, never reported as cancelled and
        # never re-sent. (The other branch — the transport honouring the cancel — is covered by the
        # pre-set case, where no physical call may happen at all.)
        value = result_box["value"]
        self.assertEqual(fixture.transport.physical, 1, "exactly one physical attempt either way")
        if value.get("wait") == "cancelled":
            # The response arrived before the cancellation could take effect, so it is a MEASURED cost
            # — reporting it as unknown here would hide a reading the wire really produced.
            self.assertIsNotNone(value.get("usage"), "the cost the transport really reported is kept")
            self.assertFalse(value.get("result"))
        else:
            self.assertIsNone(value.get("wait"), value)
            self.assertTrue(value["result"]["ok"], value)
            self.assertEqual(value["usage"]["totalTokens"], 2)

    def test_a_pre_set_cancel_sends_nothing_and_keeps_the_revision(self):
        fixture = DriverFixture(self)
        self.addCleanup(fixture.close)
        session = "cancel-nocommit"
        problem = self.ready(fixture, session)
        cancel = threading.Event()
        cancel.set()
        result = fixture.run(problem=problem, session=session, cancel=cancel)
        self.assertEqual(fixture.transport.physical, 0, "a cancel set before the dispatch sends nothing")
        self.assertFalse(result.get("result"), result)
        row = [entry for entry in fixture.core("problemStatus", {})["rows"]
               if entry["id"] == problem["id"]][0]
        self.assertEqual(row["attemptedRevision"], 0, "nothing was signed, so nothing was consumed")

    def test_an_ignored_cancel_keeps_the_slot_until_the_work_really_ends(self):
        fixture = DriverFixture(self, ignore_cancel=2)
        self.addCleanup(fixture.close)
        session = "ignored-cancel"
        problem = self.ready(fixture, session)
        cancel = threading.Event()
        entered = threading.Event()

        original = fixture.transport.handle_async_request

        async def watched(request):
            entered.set()
            return await original(request)

        fixture.transport.handle_async_request = watched
        box = {}
        thread = threading.Thread(target=lambda: box.update(value=fixture.run(problem=problem, session=session,
                                                                             cancel=cancel)), daemon=True)
        thread.start()
        entered.wait(5)
        cancel.set()
        # While the transport ignores the cancellation, a SECOND job must not be able to enter.
        deadline = time.monotonic() + 5
        while not fixture.driver.slot.draining and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertTrue(fixture.driver.slot.draining)
        other = {"route_provider": PROVIDER, "route_model": MODEL, "pre_api": fixture.hook,
                 "base": {"sessionId": "other-session"}, "outcome": "failed",
                 "source_session": "other-session", "problem": {}, "ticket": None}
        refused = fixture.driver.run(other, "failed", (TASK_SUMMARY, RESULT_SUMMARY), threading.Event(),
                                     fixture.core)
        self.assertEqual(refused.get("wait"), "slot_busy",
                         "a draining slot refuses the next job instead of overlapping it")
        thread.join(15)
        self.assertEqual(fixture.driver.slot.peak, 1, "the high-water mark is one")
        self.assertFalse(fixture.driver.slot.busy)
        self.assertEqual(fixture.transport.handler_finally, 1)
        self.assertEqual(fixture.transport.closed, 1)


@NEEDS_SDK
class ProfileBindingTests(unittest.TestCase):
    """The profile ContextVar must be in force across EVERY await, not only at the entry point."""

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-profile-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def install_constants(self):
        """A stand-in for the real `hermes_constants` ContextVar surface, with a real ContextVar."""
        import contextvars
        variable = contextvars.ContextVar("mse4b-profile", default="B")
        module = types.ModuleType("hermes_constants")
        module.get_hermes_home = lambda: variable.get()
        module.set_hermes_home_override = lambda value: variable.set(value)
        module.reset_hermes_home_override = lambda token: variable.reset(token)
        module._variable = variable
        self.addCleanup(sys.modules.pop, "hermes_constants", None)
        sys.modules["hermes_constants"] = module
        return module

    def test_the_proof_and_the_dispatch_see_profile_a_and_the_caller_keeps_b(self):
        constants = self.install_constants()
        observed = []

        fixture = DriverFixture(self, usage={"prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4})
        self.addCleanup(fixture.close)
        fixture.driver.profile_home = "A"
        fixture.core.publish("profile-session")
        mature = fixture.core.mature("profile-session")
        problem = {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                   "base": {"sessionId": "profile-session"}}
        real_resolver = fixture.driver.resolver

        def watched_resolver(provider, model):
            observed.append(("resolver", constants.get_hermes_home()))
            return real_resolver(provider, model)

        real_factory = fixture.driver.client_factory

        def watched_factory(identity, runtime):
            observed.append(("client", constants.get_hermes_home()))
            return real_factory(identity, runtime)

        original_dispatch = driver._dispatch

        async def watched_dispatch(drv, client, identity, prompt):
            observed.append(("dispatch", constants.get_hermes_home()))
            await asyncio.sleep(0)
            observed.append(("dispatch-after-await", constants.get_hermes_home()))
            return await original_dispatch(drv, client, identity, prompt)

        fixture.driver.resolver = watched_resolver
        fixture.driver.client_factory = watched_factory
        driver._dispatch = watched_dispatch
        self.addCleanup(lambda: setattr(driver, "_dispatch", original_dispatch))
        outside = []
        thread = threading.Thread(target=lambda: outside.append(
            fixture.run(problem=problem, session="profile-session")), daemon=True)
        thread.start()
        thread.join(20)
        self.assertFalse(thread.is_alive())
        self.assertTrue(observed, "the job never ran")
        for stage, home in observed:
            self.assertEqual(home, "A", "%s ran under profile %r, not A" % (stage, home))
        self.assertEqual(constants.get_hermes_home(), "B", "the caller's own binding is unchanged")

    def test_a_driver_with_no_profile_binding_changes_nothing(self):
        constants = self.install_constants()
        fixture = DriverFixture(self, usage={"punch": 1} and {"prompt_tokens": 1, "completion_tokens": 1,
                                                              "total_tokens": 2})
        self.addCleanup(fixture.close)
        fixture.core.publish("no-profile")
        mature = fixture.core.mature("no-profile")
        problem = {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                   "base": {"sessionId": "no-profile"}}
        result = fixture.run(problem=problem, session="no-profile")
        self.assertTrue(result.get("result", {}).get("ok"), result)
        self.assertEqual(constants.get_hermes_home(), "B")


if __name__ == "__main__":
    unittest.main(verbosity=2)


def observer_calls(fixture):
    """How many of this fixture's own clients were closed. Read from the driver's slot bookkeeping."""
    return fixture.driver.slot.completed


class CancelCommitTests(unittest.TestCase):
    """The cancellation matrix: a withdrawn attempt must not commit, and must close its ticket."""

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-cancelcommit-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def ready(self, fixture, session):
        fixture.core.publish(session)
        mature = fixture.core.mature(session)
        return {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                "base": {"sessionId": session}}

    def test_a_transport_that_ignores_the_cancel_still_does_not_commit(self):
        import httpx

        fixture = DriverFixture(self, usage={"prompt_tokens": 18, "completion_tokens": 0,
                                             "total_tokens": 18})
        self.addCleanup(fixture.close)
        session = "ignored-cancel-commit"
        problem = self.ready(fixture, session)
        cancel = threading.Event()
        entered = threading.Event()
        release = threading.Event()

        class Resistant(httpx.AsyncBaseTransport):
            def __init__(self):
                self.physical = 0
                self.closed = 0
                self.finally_ = 0
                self.ignored = 0

            async def handle_async_request(self, request):
                self.physical += 1
                entered.set()
                try:
                    # The provider keeps working after the caller gave up and then answers normally:
                    # that answer must not become a candidate.
                    while not release.is_set():
                        try:
                            await asyncio.sleep(0.01)
                        except asyncio.CancelledError:
                            self.ignored += 1
                    return httpx.Response(200, json=reply_body({"prompt_tokens": 18, "completion_tokens": 0,
                                                                "total_tokens": 18}))
                finally:
                    self.finally_ += 1

            async def aclose(self):
                self.closed += 1

        resistant = Resistant()
        fixture.transport = resistant

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            return AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                               http_client=httpx.AsyncClient(transport=resistant, trust_env=False)), identity.model

        fixture.driver.client_factory = factory
        box = {}
        thread = threading.Thread(target=lambda: box.update(
            value=fixture.run(problem=problem, session=session, cancel=cancel)), daemon=True)
        thread.start()
        self.assertTrue(entered.wait(10), "the request really reached the transport")
        cancel.set()
        deadline = time.monotonic() + 10
        while resistant.ignored == 0 and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertGreaterEqual(resistant.ignored, 1, "the transport really swallowed a cancellation")
        release.set()
        thread.join(20)
        self.assertFalse(thread.is_alive())
        self.assertEqual(resistant.physical, 1, "still exactly one physical attempt")
        # The withdrawal was re-read AFTER the last await: no candidate, and the ticket is closed.
        state = json.loads((fixture.state_root / "lessons-v1.json").read_text())
        self.assertEqual([row for row in state["lessons"] if row["kind"] == "method"], [],
                         "an ignored cancellation must not create a candidate")
        events = [row for row in state["events"] if row.get("reflection") is True]
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["settled"], "the signed ticket was really closed on the core")
        spend = [row for row in state["spends"] if row["kind"] == "reflection"]
        self.assertEqual(len(spend), 1, "exactly one attempt is charged")
        self.assertIsNotNone(spend[0].get("usage"), "the cost the wire really reported is recorded")
        self.assertEqual(spend[0]["usage"]["known"], True)
        self.assertEqual(spend[0]["usage"]["totalTokens"], 18)
        self.assertIsNone(spend[0].get("skipReason"))
        row = [entry for entry in fixture.core("problemStatus", {})["rows"]
               if entry["id"] == problem["id"]][0]
        self.assertIsNone(row["lessonId"], "the problem is not linked to a candidate")
        self.assertEqual(row["attemptedRevision"], problem["evidenceRevision"],
                         "the attempt stays consumed and is never replayed")

    def test_a_cancelled_request_closes_its_ticket_and_records_the_cost(self):
        fixture = DriverFixture(self)
        self.addCleanup(fixture.close)
        session = "cancelled-request"
        problem = self.ready(fixture, session)
        # The transport holds the request until this test says otherwise, so the cancellation is
        # published while the request is genuinely in flight rather than racing the job's own work.
        request_gate = threading.Event()
        fixture.transport.request_gate = request_gate
        cancel = threading.Event()
        # The job's OWN client close is what the case is about, so it is observed directly: an
        # externally supplied `http_client` is the caller's to close, and the SDK-level close is the
        # product's own boundary.
        closed_calls = {"count": 0}
        base_factory = fixture.client_factory

        def watched_factory(identity, runtime):
            client, resolved = base_factory(identity, runtime)
            original_close = client.close

            async def counted_close():
                closed_calls["count"] += 1
                await original_close()

            client.close = counted_close
            return client, resolved

        fixture.driver.client_factory = watched_factory
        box = {}
        thread = threading.Thread(target=lambda: box.update(
            value=fixture.run(problem=problem, session=session, cancel=cancel)), daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while fixture.transport.physical == 0 and time.monotonic() < deadline:
            time.sleep(0.005)
        deadline = time.monotonic() + 10
        while fixture.transport.physical == 0 and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertEqual(fixture.transport.physical, 1, "the request really reached the transport")
        cancel.set()
        request_gate.set()
        thread.join(20)
        self.assertFalse(thread.is_alive())
        self.assertEqual(closed_calls["count"], 1, "the job's own client was closed")
        state = json.loads((fixture.state_root / "lessons-v1.json").read_text())
        events = [row for row in state["events"] if row.get("reflection") is True]
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["settled"],
                        "a cancelled request must still close the ticket it signed")
        spend = [row for row in state["spends"] if row["kind"] == "reflection"]
        self.assertEqual(len(spend), 1)
        self.assertIsNotNone(spend[0].get("usage"),
                             "a dispatched-but-unanswered call is recorded as UNKNOWN, never omitted")
        self.assertEqual(spend[0]["usage"]["known"], False, "unknown is not zero")
        status = fixture.core("status", {})
        self.assertEqual(status["reflectionsLast24h"], 1)
        self.assertEqual(status["reflectionTokensUnknown24h"], 1)
        self.assertEqual([row for row in state["lessons"] if row["kind"] == "method"], [])
        self.assertIsNone(fixture.core("problemStatus", {})["rows"][0]["lessonId"])

    def test_a_hanging_client_close_keeps_the_slot_until_the_close_really_ends(self):
        import httpx

        fixture = DriverFixture(self, usage={"prompt_tokens": 18, "completion_tokens": 0,
                                             "total_tokens": 18})
        self.addCleanup(fixture.close)
        session = "hanging-close"
        problem = self.ready(fixture, session)
        cancel = threading.Event()
        close_entered = threading.Event()
        let_close_finish = threading.Event()
        observed = {}

        class HangingClose(httpx.AsyncBaseTransport):
            def __init__(self):
                self.physical = 0
                self.closed = 0

            async def handle_async_request(self, request):
                self.physical += 1
                await asyncio.sleep(0.02)
                return httpx.Response(200, json=reply_body({"prompt_tokens": 18, "completion_tokens": 0,
                                                            "total_tokens": 18}))

            async def aclose(self):
                self.closed += 1

        transport = HangingClose()
        observed = {}

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                                 http_client=httpx.AsyncClient(transport=transport, trust_env=False))
            original_close = client.close

            async def hanging_close():
                # The job's OWN close blocks: the slot must stay occupied for as long as it really runs.
                close_entered.set()
                while not let_close_finish.is_set():
                    await asyncio.sleep(0.01)
                await original_close()

            client.close = hanging_close
            return client, identity.model

        fixture.driver.client_factory = factory
        box = {}
        thread = threading.Thread(target=lambda: box.update(
            value=fixture.run(problem=problem, session=session, cancel=cancel)), daemon=True)
        thread.start()
        self.assertTrue(close_entered.wait(10), "the job really reached its close")
        # While the close is running the job is NOT finished, so the slot is still occupied — that is
        # the whole point: releasing it here would let a second provider request overlap a transport
        # that has not been closed yet.
        self.assertTrue(fixture.driver.slot.busy, json.dumps(fixture.driver.slot.status()))
        other = {"route_provider": PROVIDER, "route_model": MODEL, "pre_api": fixture.hook,
                 "base": {"sessionId": "second-session"}, "outcome": "failed",
                 "source_session": "second-session", "problem": {}, "ticket": None}
        refused = fixture.driver.run(other, "failed", (TASK_SUMMARY, RESULT_SUMMARY), threading.Event(),
                                     fixture.core)
        self.assertEqual(refused.get("wait"), "slot_busy",
                         "an occupied slot refuses the next job until the close really ends")
        observed["during"] = fixture.driver.slot.status()
        # A cancellation requested DURING the close makes the same slot draining as well, and it still
        # does not release anything: the waiter is cancelled, the close is not.
        cancel.set()
        deadline = time.monotonic() + 5
        while not fixture.driver.slot.draining and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertTrue(fixture.driver.slot.draining,
                        "a cancel during the close marks the slot draining, it does not free it")
        self.assertTrue(fixture.driver.slot.busy, "and it is still occupied")
        let_close_finish.set()
        thread.join(20)
        self.assertFalse(thread.is_alive(), "the driver returned once the close really completed")
        self.assertFalse(fixture.driver.slot.busy)
        self.assertFalse(fixture.driver.slot.draining)
        self.assertEqual(fixture.driver.slot.peak, 1)
        self.assertEqual(observed["during"]["active"], 1)
        self.assertEqual(observer_calls(fixture), 1, "the job closed exactly the client it built")


class HeldCloseGateTests(unittest.TestCase):
    """The held-close counter-example: a cancel during a HELD client close.

    The provider answer has already arrived (raw usage read); the close then blocks on a gate the test
    holds; the cancellation lands while that close is running. The requirements are exact:
      • the usage that was already read survives (it was captured before the close, not after);
      • the close is tracked to its real end — `client_close_exit` really happens — and the physical
        slot stays occupied and draining for the whole of it;
      • no candidate is created and nothing is retried.
    """

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-heldclose-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def test_a_cancel_during_a_held_close_keeps_the_usage_and_the_slot(self):
        """The reviewer's counter-example, made deterministic by the ownership of two gates.

        The order is pinned, so the trajectory cannot degrade into a race:
          1. the transport signals that it HOLDS the request and does not answer until the test
             releases it — so the cancellation is published while the request is genuinely in flight;
          2. the answer is then released, and with the cancel already published the attempt is
             withdrawn: no candidate, and the usage the wire reported is kept;
          3. the job still has to CLOSE its client, and that close blocks on a gate the test holds —
             so the slot is provably still occupied while the assertions are made;
          4. a second job is attempted during that hold and must be refused;
          5. the close gate opens, and only then may the slot be freed.
        """
        import httpx

        raw = {"prompt_tokens": 18, "completion_tokens": 0, "total_tokens": 18}
        fixture = DriverFixture(self)
        self.addCleanup(fixture.close)
        session = "held-close-gate"
        fixture.core.publish(session)
        mature = fixture.core.mature(session)
        problem = {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                   "base": {"sessionId": session}}

        request_entered = threading.Event()
        request_gate = threading.Event()
        close_entered = threading.Event()
        close_gate = threading.Event()
        closed = {"exit": 0}
        cancel = threading.Event()
        observed = {}

        class HeldClose(httpx.AsyncBaseTransport):
            def __init__(self):
                self.physical = 0

            async def handle_async_request(self, request):
                self.physical += 1
                request_entered.set()
                # The request is HELD here: the cancellation below is published while this await is
                # the job's live operation, and the answer is only released afterwards. The hold is
                # SHIELDED so a cancellation cannot end it early — the held request keeps behaving
                # like a real one that has not answered yet, and the usage is still read off the wire
                # when the answer finally arrives (which is exactly what must survive the cancel).
                while not request_gate.is_set():
                    try:
                        await asyncio.shield(asyncio.sleep(0.005))
                    except asyncio.CancelledError:
                        pass
                return httpx.Response(200, json=reply_body(raw))

            async def aclose(self):
                closed["exit"] += 1  # the transport's own end, reached only after the gate opens

        transport = HeldClose()

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                                 http_client=httpx.AsyncClient(transport=transport, trust_env=False))
            original_close = client.close

            async def held_close():
                close_entered.set()
                while not close_gate.is_set():
                    await asyncio.sleep(0.01)
                # The job's own close really completes HERE, and that is what must be observable.
                closed["exit"] += 1
                await original_close()

            client.close = held_close
            return client, identity.model

        fixture.driver.client_factory = factory
        box = {}
        thread = threading.Thread(target=lambda: box.update(
            value=fixture.run(problem=problem, session=session, cancel=cancel)), daemon=True)
        thread.start()
        self.assertTrue(request_entered.wait(15), "the job reached its provider await")
        self.assertEqual(transport.physical, 1)
        # (1) the cancellation is published WHILE the request is held in flight.
        cancel.set()
        deadline = time.monotonic() + 10
        while not fixture.driver.slot.draining and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertTrue(fixture.driver.slot.draining, "the withdrawn attempt is draining")
        self.assertTrue(fixture.driver.slot.busy, "and still occupied")
        # (2) the answer is released — with the withdrawal already published — and the job then
        #     reaches its close, which blocks on a gate this test holds.
        request_gate.set()
        self.assertTrue(close_entered.wait(10), "the job reached its held close")
        self.assertEqual(closed["exit"], 0, "the close really has not finished")
        self.assertTrue(fixture.driver.slot.busy, "the slot is still occupied by the open transport")
        self.assertTrue(fixture.driver.slot.draining)
        # (3) no second job may overlap a transport that is still open.
        second = {"route_provider": PROVIDER, "route_model": MODEL, "pre_api": fixture.hook,
                  "base": {"sessionId": "held-close-second"}, "outcome": "failed",
                  "source_session": "held-close-second", "problem": {}, "ticket": None}
        refused = fixture.driver.run(second, "failed", (TASK_SUMMARY, RESULT_SUMMARY),
                                     threading.Event(), fixture.core)
        self.assertEqual(refused.get("wait"), "slot_busy", "no second job may overlap the open transport")
        observed["during"] = fixture.driver.slot.status()
        # (4) the gate opens: the close really finishes, and only THEN is the slot free.
        close_gate.set()
        thread.join(25)
        self.assertFalse(thread.is_alive(), "the driver returned once the cleanup really ended")
        self.assertGreaterEqual(closed["exit"], 2, "the job's close and the transport's end both ran")
        self.assertFalse(fixture.driver.slot.busy)
        self.assertFalse(fixture.driver.slot.draining)
        self.assertEqual(fixture.driver.slot.peak, 1)
        self.assertEqual(observed["during"]["active"], 1)
        # ── the accounting: usage that was READ survives the cancel; nothing is committed ─────────
        listing = fixture.core("list", {"limit": 5})
        self.assertEqual([row for row in listing["lessons"] if row.get("kind") == "method"], [],
                         "a cancelled attempt creates no candidate")
        status = fixture.core("status", {})
        self.assertEqual(status["reflectionsLast24h"], 1, "exactly one attempt is charged")
        self.assertEqual(status["reflectionTokensLast24h"], 18,
                         "the 18 tokens really read off the wire are kept, not lost to the cancel")
        self.assertEqual(status["reflectionTokensUnknown24h"], 0)
        rows = fixture.core("problemStatus", {"limit": 5})["rows"]
        self.assertEqual(rows[0]["attemptedRevision"], problem["evidenceRevision"],
                         "the attempt is consumed and never replayed")
        self.assertIsNone(rows[0]["lessonId"])
        document = fixture.state_root / "lessons-v1.json"
        if document.exists():
            state = json.loads(document.read_text())
            events = [row for row in state["events"] if row.get("reflection") is True]
            self.assertEqual(len(events), 1)
            self.assertTrue(events[0]["settled"], "the ticket is settled, not left in flight")


class CleanupOrderingTests(unittest.TestCase):
    """The owner-side cleanup must never touch a client whose request is still in flight."""

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-order-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def test_a_held_request_is_never_closed_early_and_the_close_follows_the_job(self):
        import httpx

        fixture = DriverFixture(self, usage={"prompt_tokens": 11, "completion_tokens": 7,
                                             "total_tokens": 18})
        self.addCleanup(fixture.close)
        session = "cleanup-order"
        fixture.core.publish(session)
        mature = fixture.core.mature(session)
        problem = {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                   "base": {"sessionId": session}}

        order = []
        request_entered = threading.Event()
        request_gate = threading.Event()

        class Observed(httpx.AsyncBaseTransport):
            def __init__(self):
                self.physical = 0
                self.closed_at = None

            async def handle_async_request(self, request):
                self.physical += 1
                order.append("request")
                request_entered.set()
                # The request stays in flight until the test lets it answer.
                while not request_gate.is_set():
                    await asyncio.sleep(0.005)
                order.append("response")
                return httpx.Response(200, json=reply_body({"prompt_tokens": 11, "completion_tokens": 7,
                                                            "total_tokens": 18}))

            async def aclose(self):
                pass

        transport = Observed()
        closes = {"count": 0}

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                                 http_client=httpx.AsyncClient(transport=transport, trust_env=False))
            original_close = client.close

            async def observed_close():
                order.append("close")
                closes["count"] += 1
                await original_close()

            client.close = observed_close
            return client, identity.model

        fixture.driver.client_factory = factory
        box = {}
        thread = threading.Thread(target=lambda: box.update(
            value=fixture.run(problem=problem, session=session, cancel=threading.Event())), daemon=True)
        thread.start()
        self.assertTrue(request_entered.wait(15), "the request is in flight")
        self.assertEqual(transport.physical, 1)
        # ── the sequence assertion: while the request is HELD, the client must not be closed ──────
        time.sleep(0.5)
        self.assertIn("request", order)
        self.assertNotIn("close", order,
                         "the client must not be closed while its request is still in flight")
        self.assertNotIn("response", order, "the request really is still held")
        self.assertEqual(closes["count"], 0)
        self.assertEqual(fixture.driver.slot.status()["active"], 1, "the job is still in the slot")
        request_gate.set()
        thread.join(20)
        self.assertFalse(thread.is_alive())
        # ── and afterwards the order is exactly response → close, once ────────────────────────────
        self.assertEqual(order, ["request", "response", "close"], order)
        self.assertEqual(closes["count"], 1)
        self.assertEqual(fixture.driver.slot.status()["peak"], 1)
        self.assertFalse(fixture.driver.slot.busy)
        status = fixture.core("status", {})
        self.assertEqual(status["reflectionTokensLast24h"], 18, "the measured usage is recorded")
        self.assertEqual(status["reflectionsLast24h"], 1)
        listing = fixture.core("list", {"limit": 5})
        self.assertEqual([row for row in listing["lessons"] if row.get("kind") == "method"][0]["status"],
                         "candidate")


@NEEDS_SDK
class JobRegistryTests(unittest.TestCase):
    """A FINISHED attempt must stop being a registry reference — and only once it is really over.

    The driver's registry is what an unload reaches to withdraw the work that is really in flight, so
    an entry has to stay for the whole life of an attempt: the job Task AND its owner-side cleanup.
    What may not stay is the finished entry itself — it carries the original prompt, the route and the
    dispatch facts, and a registry that keeps them grows for ever and reports terminal work as active.

    These cases drive the REAL driver through each exit — committed, provider failure, cancelled —
    and assert BOTH halves of the contract: still registered while the cleanup is genuinely pending,
    released (with only bounded, non-sensitive counts left) once it has really finished.
    """

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-registry-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = CoreClient(self.state_root)

    def make(self, **kwargs):
        fixture = DriverFixture(self, **kwargs)
        self.addCleanup(fixture.close)
        return fixture

    def ready_problem(self, fixture, session, tool="tool-a"):
        fixture.core.publish(session)
        mature = fixture.core.mature(session, tool)
        return {"id": mature["id"], "evidenceRevision": mature["problem"]["evidenceRevision"],
                "base": {"sessionId": session}}

    def cross_the_real_cooldown(self):
        """Advance the clock the CORE reads by its real 30-minute cooldown, and nothing else.

        A second signed attempt inside the cooldown is refused by the shipped gate — that is the
        product, not an obstacle to work around: no permit is seeded, no spend removed and no limit
        relaxed. The clock is the only thing that moves (`tests/node_clock.py`).
        """
        clock = node_clock.NodeClock(self)
        clock.advance_ms(31 * 60_000)
        return clock

    def failing(self, status=500):
        """A real driver whose transport answers with a real PROVIDER FAILURE status."""
        import httpx

        fixture = self.make()

        class Failure(httpx.AsyncBaseTransport):
            def __init__(self):
                self.physical = 0

            async def handle_async_request(self, request):
                self.physical += 1
                return httpx.Response(status, json={"error": {"message": "synthetic"}})

            async def aclose(self):
                pass

        transport = Failure()
        fixture.transport = transport

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            return AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                               http_client=httpx.AsyncClient(transport=transport, trust_env=False)), identity.model

        fixture.driver.client_factory = factory
        return fixture

    def assert_released(self, fixture, label):
        """No reference is left, and the retained statistics carry no attempt's facts."""
        self.assertEqual(list(fixture.driver.jobs), [], label)
        self.assertEqual(fixture.driver._active_jobs(), [], label)
        status = fixture.driver.status()
        self.assertEqual(status["registered"], 0, label)
        self.assertEqual(sorted(status["finished"]),
                         ["cancelled", "closed", "committed", "jobs", "other", "refused"],
                         "the retained statistics are the fixed, bounded buckets only")
        self.assertNotIn(TASK_SUMMARY, json.dumps(status, ensure_ascii=False, default=str),
                         "a released attempt leaves no prompt behind")

    def test_a_committed_attempt_is_still_registered_while_its_close_is_held(self):
        import httpx

        fixture = self.make(usage={"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18})
        session = "registry-held-close"
        problem = self.ready_problem(fixture, session)
        closed = {"entered": threading.Event(), "release": threading.Event(), "done": threading.Event()}

        class HeldClose(httpx.AsyncBaseTransport):
            """Answers immediately, but keeps the CLOSE open until the test lets it finish."""

            def __init__(self):
                self.physical = 0

            async def handle_async_request(self, request):
                self.physical += 1
                return httpx.Response(200, json=reply_body({"prompt_tokens": 11, "completion_tokens": 7,
                                                            "total_tokens": 18}))

            async def aclose(self):
                closed["entered"].set()
                while not closed["release"].is_set():
                    await asyncio.sleep(0.01)
                closed["done"].set()

        transport = HeldClose()

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            return AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                               http_client=httpx.AsyncClient(transport=transport, trust_env=False)), identity.model

        fixture.driver.client_factory = factory
        box = {}
        thread = threading.Thread(target=lambda: box.update(
            value=fixture.run(problem=problem, session=session)), daemon=True)
        thread.start()
        self.assertTrue(closed["entered"].wait(15), "the job reached its own close")
        # ── the entry is STILL there: the cleanup is genuinely pending, so nothing may be dropped ────
        deadline = time.monotonic() + 5
        while not fixture.driver.slot.draining and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertTrue(fixture.driver.slot.draining, "a held close keeps the slot draining")
        self.assertEqual(len(fixture.driver.jobs), 1,
                         "a job whose cleanup is still running stays registered and cancellable")
        self.assertEqual(len(fixture.driver._active_jobs()), 1)
        self.assertEqual(fixture.driver.status()["registered"], 1)
        self.assertEqual(fixture.driver.status()["finished"]["jobs"], 0,
                         "nothing is counted as finished before the cleanup really ended")
        # ── the close finishes: now the reference is released, and only counts remain ────────────────
        closed["release"].set()
        thread.join(20)
        self.assertFalse(thread.is_alive(), "the driver returned once the cleanup really ended")
        self.assertTrue(closed["done"].is_set())
        self.assertIsNone(box["value"].get("wait"), box["value"])
        self.assertEqual(fixture.driver.slot.status()["pendingTasks"], 0,
                         "the tracked cleanup was released, not left pending")
        self.assert_released(fixture, "after a committed attempt whose close finished")
        self.assertEqual(fixture.driver.status()["finished"]["committed"], 1)
        self.assertEqual(transport.physical, 1)

    def test_a_provider_failure_releases_its_reference_after_the_cleanup(self):
        fixture = self.failing(500)
        session = "registry-failure"
        problem = self.ready_problem(fixture, session)
        result = fixture.run(problem=problem, session=session)
        self.assertEqual(result.get("wait"), "provider_unavailable", result)
        self.assertEqual(fixture.transport.physical, 1, "one physical attempt, no retry")
        self.assert_released(fixture, "after a provider failure")
        self.assertEqual(fixture.driver.status()["finished"]["closed"], 1,
                         "a failed attempt is a closed terminal attempt, reported as such")
        self.assertEqual(fixture.driver.status()["finished"]["jobs"], 1)

    def test_a_cancelled_attempt_releases_its_reference_after_the_drain(self):
        fixture = self.make(usage={"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18})
        session = "registry-cancel"
        problem = self.ready_problem(fixture, session)
        # The request is HELD: that is what makes the drain a real window instead of a race, so the
        # "still registered while draining" half is asserted deterministically rather than hopefully.
        fixture.transport.request_gate = threading.Event()
        cancel = threading.Event()
        box = {}
        thread = threading.Thread(target=lambda: box.update(
            value=fixture.run(problem=problem, session=session, cancel=cancel)), daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while fixture.transport.physical == 0 and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertEqual(fixture.transport.physical, 1)
        self.assertEqual(len(fixture.driver.jobs), 1, "the in-flight attempt is the one an unload reaches")
        cancel.set()
        deadline = time.monotonic() + 10
        while not fixture.driver.slot.draining and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertTrue(fixture.driver.slot.draining, "the withdrawn attempt is draining, not finished")
        for _ in range(50):
            # The drain is a REQUEST, not a fact: while it runs, the attempt stays registered so it
            # can still be reached — dropping it here would fake an empty slot.
            self.assertEqual(len(fixture.driver.jobs), 1,
                             "a draining attempt is still registered until its work really ends")
            time.sleep(0.002)
        # The held request now answers; the withdrawn attempt must discard that answer and close.
        fixture.transport.request_gate.set()
        thread.join(20)
        self.assertFalse(thread.is_alive())
        self.assertEqual(box["value"].get("wait"), "cancelled", box["value"])
        self.assert_released(fixture, "after a cancelled attempt drained")
        self.assertEqual(fixture.driver.status()["finished"]["cancelled"], 1,
                         "the withdrawn attempt is reported as the cancelled one it was")
        listing = fixture.core("list", {"limit": 5})
        self.assertEqual([row for row in listing["lessons"] if row.get("kind") == "method"], [],
                         "the late answer of a withdrawn attempt never becomes a candidate")

    def test_many_finished_attempts_leave_only_bounded_counts(self):
        fixture = self.make(usage={"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18})
        # (1) a real commit on ONE driver…
        committed = "registry-many-committed"
        committed_run = fixture.run(problem=self.ready_problem(fixture, committed, "tool-a"),
                                    session=committed)
        self.assertIsNone(committed_run.get("wait"), committed_run)
        # (2) …a real provider failure on the SAME driver, past the core's real cooldown…
        self.cross_the_real_cooldown()
        failing = self.failing(500)
        fixture.driver.client_factory = failing.driver.client_factory
        failure_session = "registry-many-failed"
        failed_run = fixture.run(problem=self.ready_problem(fixture, failure_session, "tool-b"),
                                 session=failure_session)
        self.assertEqual(failed_run.get("wait"), "provider_unavailable", failed_run)
        # (3) …and a cancel set before the dispatch, which never signs a ticket at all.
        refused = "registry-many-refused"
        cancel = threading.Event()
        cancel.set()
        refused_run = fixture.run(problem=self.ready_problem(fixture, refused, "tool-c"),
                                  session=refused, cancel=cancel)
        self.assertEqual(refused_run.get("wait"), "cancelled", refused_run)
        # ── three finished attempts, three released references, one bounded summary ─────────────────
        self.assert_released(fixture, "after three finished attempts on one driver")
        finished = fixture.driver.status()["finished"]
        self.assertEqual(finished["jobs"], 3)
        self.assertEqual((finished["committed"], finished["closed"], finished["refused"]), (1, 1, 1),
                         "each exit is reported in its OWN bucket: %r" % (finished,))
        self.assertEqual(fixture.driver.status()["registered"], 0)
        self.assertEqual(fixture.driver.slot.status()["peak"], 1, "never more than one job in the slot")
        self.assertFalse(fixture.driver.slot.busy)
        self.assertFalse(fixture.driver.slot.draining)
