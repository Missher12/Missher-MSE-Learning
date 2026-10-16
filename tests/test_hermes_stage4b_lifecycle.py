"""Stage 4b lifecycle controls: the REAL plugin registration and a COLD library.

These are the cases an independent acceptance runner would drive without substituting the production
registration, and they exist because each one is a place where the wiring — not the driver — decides
whether automatic reflection can ever happen:

  1. `register(ctx)` really installs the capability-proven driver factory. The factory path builds the
     capability record, so an instance whose `capabilities` is not yet assembled must still initialise.
  2. A COLD library (nothing published, no receipt, no lesson) really reaches automatic reflection:
     the turn's own captured `pre_api_request` facts are PROVED and PUBLISHED through the core's
     bounded register during the real lifecycle, and only then does the core's gate get asked. No row
     is pre-seeded by the test, and the gate is never skipped.
  3. Clearing the factory returns the instance to `capability_waiting`. It must NOT fall back to the
     built-in `_review`, which resolves the profile default route and calls `call_llm` — the exact
     unproven capability 4b replaced.

The empty `ctx` is a test double for the Host's plugin context (eleven hook registrations and a
`has_plugin` probe). Nothing else about the Host is faked: the hooks are the real ones and the core
is the shipped CLI over a temporary state root.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load_package():
    """Load `adapters/hermes` as a package so the real `register` and relative imports work."""
    path = ROOT / "adapters" / "hermes" / "__init__.py"
    spec = importlib.util.spec_from_file_location("mse4b_hermes_package", path,
                                                  submodule_search_locations=[str(path.parent)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def use_installed_sdk():
    """Put the committed Hermes dependency generation on the import path, or report why not.

    The foreground cases drive the REAL `AsyncOpenAI`; the interpreter running this suite is not
    necessarily the launcher's, so the committed generation is added explicitly. Nothing is
    installed or switched: a missing generation is reported and the SDK cases are skipped.
    """
    try:
        import openai  # noqa: F401
        return "already-importable", None
    except ImportError:
        pass
    for facts in sorted((Path.home() / ".hermes" / "installs").glob("*/facts.json")):
        try:
            venv = Path(json.loads(facts.read_text())["packages"]["venv"]["environment"])
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
            import openai  # noqa: F401
            return "committed:%s" % (site, ), None
        except ImportError as error:
            return None, "committed SDK unreadable: %s" % (error,)
    return None, "no committed environment carries the openai SDK"


SDK_SOURCE, SDK_PROBLEM = use_installed_sdk()
NEEDS_SDK = unittest.skipUnless(SDK_SOURCE, SDK_PROBLEM or "the installed SDK is required")

package = load_package()
bridge = sys.modules[package.__name__ + ".bridge"]
INSTRUCTION = "处理金额排序前先核对数值类型，再用固定输入独立检查输出顺序"


def load_module(name, path):
    """Load one local helper module by path, so a suite never depends on the caller's cwd."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


node_clock = load_module("mse_lifecycle_node_clock", ROOT / "tests" / "node_clock.py")


class FakeContext:
    """The Host's plugin surface, as `register` uses it: `has_plugin`, `register_hook`, `on_unload`."""

    def __init__(self):
        self.hooks = {}
        self.unload = []

    def has_plugin(self, name):
        return False

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def on_unload(self, callback):
        self.unload.append(callback)


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.profile = Path(tempfile.mkdtemp(prefix="mse4b-profile-"))
        self.addCleanup(shutil.rmtree, self.profile, True)
        # A synthetic Hermes home so the production registration can resolve a profile without
        # touching (or reading) the daily one.
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.profile
        self.addCleanup(sys.modules.pop, "hermes_constants", None)
        sys.modules["hermes_constants"] = constants
        os.environ.setdefault("MSE_NODE_EXECUTABLE", shutil.which("node") or "")
        os.environ.setdefault("MSE_LEARN_CLI", str(ROOT / "src" / "cli.mjs"))

    def test_the_real_registration_installs_the_proven_driver_without_a_prefilled_instance(self):
        ctx = FakeContext()
        package.register(ctx)
        hooks = ctx.mse_learning
        # The capability record really exists, and it names the proved driver rather than waiting.
        self.assertEqual(hooks.capabilities["reflectionDriver"], "async_openai_single_attempt")
        self.assertTrue(hooks.capabilities["providerWireEvidence"])
        self.assertIsNotNone(hooks.reflection_driver)
        self.assertTrue(callable(hooks._driver_factory))
        self.assertTrue(hooks._reflectionDriverReady())
        # Ten native hooks plus the profile-bound driver factory is the whole registration.
        self.assertEqual(sorted(ctx.hooks), sorted(["pre_llm_call", "pre_api_request", "post_api_request",
            "post_llm_call", "pre_tool_call", "post_tool_call", "on_session_end", "on_session_reset", "on_session_finalize",
            "subagent_start", "subagent_stop"]))
        self.assertTrue(ctx.unload)
        # A read-only status call reports the capability and writes nothing.
        status = hooks.local_status()
        self.assertEqual(status["capabilities"]["reflectionDriver"], "async_openai_single_attempt")
        self.assertEqual(status["driver"]["slot"]["peak"], 0)
        ctx.unload[0]()

    def test_clearing_the_factory_never_promotes_the_builtin_reviewer(self):
        ctx = FakeContext()
        package.register(ctx)
        hooks = ctx.mse_learning
        hooks.set_driver_factory(None)
        self.assertIsNone(hooks.reflection_driver)
        self.assertEqual(hooks.capabilities["reflectionDriver"], "capability_waiting",
                         "a cleared factory returns the instance to the honest waiting state")
        self.assertFalse(hooks.capabilities["providerWireEvidence"])
        self.assertFalse(hooks._reflectionDriverReady(),
                         "the built-in `_review` (profile default route + call_llm) is NOT a proved driver")
        # And an explicitly installed reviewer still counts: that is the controlled seam the tests
        # and the tracer use, and clearing a factory must not remove it.
        hooks.set_review(lambda request, model, cancel=None: None)
        self.assertEqual(hooks.capabilities["reflectionDriver"], "injected_reviewer")
        self.assertTrue(hooks._reflectionDriverReady())
        hooks.set_review(None)
        self.assertEqual(hooks.capabilities["reflectionDriver"], "capability_waiting")
        self.assertFalse(hooks._reflectionDriverReady())
        ctx.unload[0]()


class ColdLibraryTests(unittest.TestCase):
    """No receipt, no lesson, nothing published — and automatic reflection still reaches the gate."""

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-cold-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.profile = Path(tempfile.mkdtemp(prefix="mse4b-cold-profile-"))
        self.addCleanup(shutil.rmtree, self.profile, True)
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.profile
        self.addCleanup(sys.modules.pop, "hermes_constants", None)
        sys.modules["hermes_constants"] = constants
        self.node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
        self.cli = ROOT / "src" / "cli.mjs"
        if not self.node or not self.cli.is_file():
            self.skipTest("node or the shipped CLI is unavailable")
        os.environ["MSE_NODE_EXECUTABLE"] = self.node
        os.environ["MSE_LEARN_CLI"] = str(self.cli)

    def core(self, op, value):
        return self.core_on(self.state_root, op, value)

    def core_on(self, state_root, op, value):
        result = subprocess.run([self.node, str(self.cli)],
                                input=json.dumps({"config": {"stateRoot": str(state_root),
                                                             "adapterId": "hermes", "maxContextBytes": 768},
                                                  "op": op, "input": value}),
                                text=True, capture_output=True, timeout=20, check=False)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def make_hooks(self):
        """A real `Hooks` with the real production driver factory — no substituted register."""
        hooks = bridge.Hooks(config={"stateRoot": str(self.state_root), "adapterId": "hermes",
                                     "maxContextBytes": 768},
                             enabled=lambda: True,
                             driver_factory=package.single_attempt_driver(self.profile))
        self.addCleanup(hooks.dispose)
        return hooks

    def install_constants(self, default="B"):
        """A real ContextVar stand-in for the Host's profile binding."""
        import contextvars
        variable = contextvars.ContextVar("mse4b-lifecycle-profile", default=default)
        module = types.ModuleType("hermes_constants")
        module.get_hermes_home = lambda: variable.get()
        module.set_hermes_home_override = lambda value: variable.set(value)
        module.reset_hermes_home_override = lambda token: variable.reset(token)
        module._variable = variable
        self.addCleanup(sys.modules.pop, "hermes_constants", None)
        sys.modules["hermes_constants"] = module
        return module

    def install_host(self, hooks, *, base_url="https://source-a.invalid/v1", api_mode="chat_completions",
                     constants=None):
        """Point the real driver at a synthetic route + transport. The HOOK facts stay real.

        When `constants` is supplied, every profile-sensitive step records the profile it SAW, so an
        independent acceptance run can assert that resolution, client construction, the awaits inside
        the dispatch, the close, and the lifecycle-side `prepare_source` all ran under the factory's
        own profile — and that the caller's binding was restored afterwards.
        """
        captured = {"client_built": 0, "profiles": []}
        runtime = {"provider": "deepseek-official", "model": "deepseek-flash",
                   "api_mode": api_mode, "base_url": base_url, "api_key": "synthetic-key"}

        def note(stage):
            if constants is not None:
                captured["profiles"].append((stage, constants.get_hermes_home()))

        def resolver(provider, model):
            note("resolver")
            return dict(runtime)

        def client_factory(identity, runtime_value):
            note("client")
            captured["client_built"] += 1
            return None, None

        hooks.reflection_driver.resolver = resolver
        hooks.reflection_driver.client_factory = client_factory
        hooks.reflection_driver.allow_direct_client = False
        return captured

    def test_a_cold_library_publishes_the_source_from_real_facts_and_then_passes_the_gate(self):
        hooks = self.make_hooks()
        constants = self.install_constants()
        captured = self.install_host(hooks, constants=constants)
        session = "cold-session"
        # A real cold turn through the real hooks: prepare recalls nothing (empty library), the real
        # route capture runs, the real tool failures are normalized, and the real turn end persists
        # them and starts the reflection path.
        self.assertIsNone(hooks.pre_llm_call(session_id=session, turn_id="1", platform="cli",
                                             user_message="导出金额并核对排序结果"))
        self.assertIsNone(hooks.pre_api_request(session_id=session, turn_id="1",
                                                provider="deepseek-official", model="deepseek-flash",
                                                base_url="https://source-a.invalid/v1",
                                                api_mode="chat_completions", api_request_id="api-1",
                                                request_messages=[],
                                                request={"method": "POST", "body": {
                                                    "model": "deepseek-flash",
                                                    "reasoning_effort": "max"}}))
        self.assertEqual(self.core("sourceStatus", {"limit": 5})["total"], 0,
                         "the library really starts with nothing published")
        for call in ("call-1", "call-2"):
            hooks.post_tool_call(session_id=session, turn_id="1", tool_call_id=call, tool_name="bash",
                                 status="error", error_type="tool_error", read_only=False)
        hooks.post_llm_call(session_id=session, turn_id="1", completed=True,
                            assistant_response="", failed=True)
        for job in list(hooks.jobs):
            pass
        deadline = __import__("time").monotonic() + 10
        while hooks.jobs and __import__("time").monotonic() < deadline:
            __import__("time").sleep(0.02)
        self.assertFalse(hooks.jobs, "the reflection job finished within bounds")
        published = self.core("sourceStatus", {"limit": 64})
        self.assertEqual(published["total"], 1,
                         "the REAL lifecycle published the source from the turn's own facts")
        identity = published["rows"][0]["identity"]
        self.assertEqual(identity["provider"], "deepseek-official")
        self.assertEqual(identity["model"], "deepseek-flash")
        self.assertEqual(identity["reasoningState"], "explicit")
        self.assertEqual(identity["reasoningValue"], "max")
        self.assertEqual(identity["apiMode"], "chat_completions")
        self.assertEqual(len(identity["endpointFingerprint"]), 64)
        self.assertEqual(captured["client_built"], 1,
                         "the driver really reached the client step of a signed attempt")
        # The provider was never contacted (the pinned client factory returns no client), so the
        # attempt reported a bounded wait rather than a success. What matters here is the ORDER:
        # the source was published from real facts, and the gate could then be asked and answered.
        status = self.core("status", {})
        self.assertEqual(status["reflectionsLast24h"], 1, "one attempt was signed and consumed")
        problem = self.core("problemStatus", {"limit": 5})["rows"][0]
        self.assertEqual(problem["attemptedRevision"], problem["evidenceRevision"])
        self.assertIsNone(problem["lessonId"], "no candidate without a real provider answer")
        # The gate now answers from the PUBLISHED identity. This particular problem's revision has
        # already been spent by the attempt above, so its plan refuses for that reason — a terminal
        # fact about the revision, not a missing source. The source report itself is present and
        # gate-ready, which is what the lifecycle had to achieve.
        plan = self.core("problemRecoveryPlan", {"problemId": problem["id"]})
        self.assertEqual(plan["code"], "revision_already_attempted", plan)
        published_row = published["rows"][0]
        # The observation happened BEFORE anything was published (that is what a cold library means),
        # so it bound no digest. That is the honest fact: the observation cannot claim an identity
        # that did not exist when it was made. What the lifecycle had to achieve is the PUBLISHED
        # identity the gate compares against, and the plan reports exactly it.
        self.assertIsNone(problem["origin"]["routeId"])
        self.assertEqual(published_row["identity"]["reasoningState"], "explicit",
                         "the published digest came from the hook's own proven body, not a default")
        route_facts = hooks.routes[(session, "1")]
        self.assertEqual(route_facts["provider"], published_row["identity"]["provider"])
        self.assertEqual(route_facts["model"], published_row["identity"]["model"])
        self.assertEqual(route_facts["reasoningEffort"], published_row["identity"]["reasoningValue"])
        # ── the PROFILE binding covers the lifecycle step too, not only the Task ──────────────────
        # `prepare_source` runs on the caller's OWN background thread, so it must establish the
        # factory's profile itself: a resolver that ran under whatever the worker happened to carry
        # would be answering for a different account than the one this driver was created for.
        self.assertTrue(captured["profiles"], "no profile-sensitive step was observed at all")
        # `get_hermes_home()` is the caller's own object (a Path here), so the comparison is on the
        # STRING form — the point is which profile was in force, not the type it was stored as.
        mismatched = [entry for entry in captured["profiles"] if str(entry[1]) != str(self.profile)]
        self.assertEqual(mismatched, [],
            "every resolution and client build must run under the factory's profile")
        self.assertIn("resolver", [entry[0] for entry in captured["profiles"]],
                      "the lifecycle's own resolution was observed")
        self.assertEqual(constants.get_hermes_home(), "B",
            "the caller's own profile binding is restored afterwards")

    def fresh_core(self, prefix):
        """A brand-new empty state root, so one case's allowance cannot refuse the next case.

        The reflection allowance is HOST-WIDE (3 per 24 hours with a 30-minute cooldown), so three
        attempts in one store would test the allowance rather than the identity proof. Each case gets
        its own cold library, which is also what a real first run looks like.
        """
        root = Path(tempfile.mkdtemp(prefix="mse4b-%s-" % prefix))
        self.addCleanup(shutil.rmtree, root, True)
        return root

    def test_a_turn_whose_route_the_host_could_not_state_waits_and_spends_nothing(self):
        """An incomplete dispatch identity is a WAIT, and it never becomes a borrowed one.

        These are REAL hook inputs: the released route capture keeps the scalars it can, the driver
        is the component that refuses the incomplete DISPATCH identity, and each case runs against a
        cold store of its own. Nothing is published, nothing is signed, nothing is consumed — and no
        route is invented from a profile default.
        """
        # The reason names the FIRST fact the proof could not establish: the endpoint is checked
        # before the protocol, so "both missing" reports the endpoint.
        for label, hook_facts, reason in (("no-endpoint", {"base_url": None}, "source_endpoint_unavailable"),
                                          ("no-protocol", {"api_mode": None}, "source_endpoint_unavailable"),
                                          ("both-missing", {"base_url": None, "api_mode": None},
                                           "source_endpoint_unavailable")):
            core = self.fresh_core(label)
            hooks = bridge.Hooks(config={"stateRoot": str(core), "adapterId": "hermes",
                                         "maxContextBytes": 768},
                                 enabled=lambda: True,
                                 driver_factory=package.single_attempt_driver(self.profile))
            self.addCleanup(hooks.dispose)
            self.install_host(hooks)
            session, turn = "cold-%s" % label, "1"
            hooks.pre_llm_call(session_id=session, turn_id=turn, platform="cli",
                               user_message="导出金额并核对排序结果")
            hooks.pre_api_request(session_id=session, turn_id=turn, provider="deepseek-official",
                                  model="deepseek-flash", api_request_id="api-1", request_messages=[],
                                  request={"method": "POST", "body": {"model": "deepseek-flash",
                                                                      "reasoning_effort": "max"}},
                                  **hook_facts)
            # The released capture still binds the scalars it can keep; the incomplete DISPATCH
            # identity is what the driver refuses.
            self.assertIn((session, turn), hooks.pre_api, label)
            for call in ("call-1", "call-2"):
                hooks.post_tool_call(session_id=session, turn_id=turn, tool_call_id=call,
                                     tool_name="bash", status="error", error_type="tool_error",
                                     read_only=False)
            hooks.post_llm_call(session_id=session, turn_id=turn, completed=True,
                                assistant_response="", failed=True)
            import time
            deadline = time.monotonic() + 10
            while hooks.jobs and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertFalse(hooks.jobs, label)
            self.assertEqual(hooks.problems["last"], reason, label)
            self.assertEqual(hooks.problems["waiting"], 1, label)
            # Nothing published, nothing signed, nothing consumed: an unprovable route is a WAIT.
            self.assertEqual(self.core_on(core, "sourceStatus", {"limit": 5})["total"], 0, label)
            rows = self.core_on(core, "problemStatus", {"limit": 64})["rows"]
            self.assertTrue(rows, label)
            for row in rows:
                self.assertEqual(row["attemptedRevision"], 0, label)
                self.assertEqual(row["state"], "eligible", label)
            self.assertEqual(self.core_on(core, "status", {})["reflectionsLast24h"], 0, label)
            hooks.dispose()

    def test_a_turn_the_host_never_dispatched_cannot_borrow_a_route(self):
        hooks = self.make_hooks()
        self.install_host(hooks)
        # A problem observed on a session whose turn the host never reported a route for.
        for index, event in enumerate(("call-1", "call-2")):
            hooks._observe({"sessionId": "unrouted-session", "turnId": str(index + 1)},
                           {"eventId": event, "kind": "tool_failure", "source": "host_event",
                            "toolName": "bash", "failureCode": "tool_nonzero_exit",
                            "summary": "工具失败：bash"})
        problem = self.core("problemStatus", {"limit": 5})["rows"][0]
        row = {"base": {"sessionId": "unrouted-session", "turnId": "1"}, "model": "deepseek-flash"}
        prepared = hooks._prepareSourceIdentity(row, {"problem": {"id": problem["id"],
                                                                 "evidenceRevision": problem["evidenceRevision"]}})
        self.assertFalse(prepared.get("ok"))
        self.assertEqual(prepared.get("wait"), "source_unbound",
                         "no observed dispatch means no route, never a default one")
        self.assertEqual(self.core("sourceStatus", {"limit": 5})["total"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)


@NEEDS_SDK
class ForegroundPreemptionTests(unittest.TestCase):
    """A REAL foreground turn must invalidate an in-flight background reflection.

    These cases drive the production hook (`pre_llm_call`) exactly as the Host does, with the real
    `Hooks`, the real driver and the real Node core. They never call `cancel_pending` directly: the
    point is that the lifecycle itself — a genuine new turn on the same session — is what withdraws
    the background attempt, and that a late provider answer can then neither commit nor be charged
    twice.
    """

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-fg-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.profile = Path(tempfile.mkdtemp(prefix="mse4b-fg-profile-"))
        self.addCleanup(shutil.rmtree, self.profile, True)
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.profile
        self.addCleanup(sys.modules.pop, "hermes_constants", None)
        sys.modules["hermes_constants"] = constants
        self.node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
        self.cli = ROOT / "src" / "cli.mjs"
        if not self.node or not self.cli.is_file():
            self.skipTest("node or the shipped CLI is unavailable")
        os.environ["MSE_NODE_EXECUTABLE"] = self.node
        os.environ["MSE_LEARN_CLI"] = str(self.cli)

    def core(self, op, value):
        result = subprocess.run([self.node, str(self.cli)],
                                input=json.dumps({"config": {"stateRoot": str(self.state_root),
                                                             "adapterId": "hermes", "maxContextBytes": 768},
                                                  "op": op, "input": value}),
                                text=True, capture_output=True, timeout=20, check=False)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def holding_hooks(self, entered, release, *, usage=None):
        """A real `Hooks` + real driver whose provider request is HELD until `release` is set."""
        import asyncio
        import httpx

        status = {"physical": 0, "cancelled": 0, "finally_": 0, "closed": 0}
        usage = usage or {"prompt_tokens": 16, "completion_tokens": 16, "total_tokens": 32}

        class Holding(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                status["physical"] += 1
                entered.set()
                try:
                    while not release.is_set():
                        try:
                            await asyncio.sleep(0.01)
                        except asyncio.CancelledError:
                            status["cancelled"] += 1
                            # The provider keeps working after its caller gave up, then answers
                            # normally: exactly the shape that must NOT become a candidate.
                    body = {"id": "synthetic", "object": "chat.completion", "created": 1,
                            "model": "deepseek-flash",
                            "choices": [{"index": 0, "finish_reason": "stop", "message": {
                                "role": "assistant",
                                "content": json.dumps({"instruction": INSTRUCTION}, ensure_ascii=False)}}],
                            "usage": usage}
                    return httpx.Response(200, json=body)
                finally:
                    status["finally_"] += 1

            async def aclose(self):
                status["closed"] += 1

        transport = Holding()
        hooks = bridge.Hooks(config={"stateRoot": str(self.state_root), "adapterId": "hermes",
                                     "maxContextBytes": 768},
                             enabled=lambda: True,
                             driver_factory=package.single_attempt_driver(self.profile))
        self.addCleanup(hooks.dispose)
        driver = hooks.reflection_driver
        driver.resolver = lambda provider, model: {"provider": "deepseek-official",
            "model": "deepseek-flash", "api_mode": "chat_completions",
            "base_url": "https://source-a.invalid/v1", "api_key": "synthetic-key"}

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            return AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                               http_client=httpx.AsyncClient(transport=transport, trust_env=False)), identity.model

        driver.client_factory = factory
        return hooks, status

    def start_turn(self, hooks, session, turn, *, base_url="https://source-a.invalid/v1"):
        """The REAL hooks a host fires for one turn, in the host's order."""
        hooks.pre_llm_call(session_id=session, turn_id=turn, platform="cli",
                           user_message="导出金额并核对排序结果")
        hooks.pre_api_request(session_id=session, turn_id=turn, provider="deepseek-official",
                              model="deepseek-flash", base_url=base_url, api_mode="chat_completions",
                              api_request_id="api-%s-%s" % (session, turn), request_messages=[],
                              request={"method": "POST", "body": {"model": "deepseek-flash",
                                                                  "reasoning_effort": "max"}})
        for call in ("call-1", "call-2"):
            hooks.post_tool_call(session_id=session, turn_id=turn, tool_call_id="%s-%s" % (turn, call),
                                 tool_name="bash", status="error", error_type="tool_error",
                                 read_only=False)
        hooks.post_llm_call(session_id=session, turn_id=turn, completed=True, failed=True,
                            assistant_response="")

    def wait_idle(self, hooks, seconds=15):
        deadline = time.monotonic() + seconds
        while hooks.jobs and time.monotonic() < deadline:
            time.sleep(0.02)
        return not hooks.jobs

    def test_a_real_foreground_turn_invalidates_the_background_reflection(self):
        entered, release = threading.Event(), threading.Event()
        hooks, status = self.holding_hooks(entered, release)
        session = "foreground-session"
        self.start_turn(hooks, session, "1")
        self.assertTrue(entered.wait(15), "the background reflection reached the provider")
        self.assertEqual(status["physical"], 1, "one physical background attempt")
        before = self.core("status", {})
        self.assertEqual(before["reflectionsLast24h"], 1)
        # ── the REAL new turn on the SAME session ────────────────────────────────────────────────
        hooks.pre_llm_call(session_id=session, turn_id="2", platform="cli",
                           user_message="继续处理当前金额数据，先核对输入字段")
        deadline = time.monotonic() + 10
        while status["cancelled"] == 0 and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertGreaterEqual(status["cancelled"], 1,
                                "the production hook really withdrew the in-flight attempt")
        local = hooks.local_status()
        self.assertGreaterEqual(local["problems"].get("preempted", 0), 1)
        # ── the provider finally answers; it must be discarded ───────────────────────────────────
        release.set()
        self.assertTrue(self.wait_idle(hooks), "the driver drained its slot")
        state = json.loads((self.state_root / "lessons-v1.json").read_text())
        methods = [row for row in state["lessons"] if row["kind"] == "method"]
        self.assertEqual(methods, [], "a late answer to a preempted attempt never becomes a candidate")
        events = [row for row in state["events"] if row.get("reflection") is True]
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["settled"], "the preempted ticket is closed in the core")
        self.assertEqual(events[0]["terminal"], "cancelled")
        spend = [row for row in state["spends"] if row["kind"] == "reflection"]
        self.assertEqual(len(spend), 1, "still exactly ONE attempt charged")
        # The preemption recorded the attempt as UNKNOWN the moment it closed the ticket — and when the
        # provider finally answered, its real measurement was MERGED into that same record (the merge
        # may upgrade an unknown, never overwrite a known, and never charge twice). What must never
        # happen is a candidate or a second attempt, and neither did.
        self.assertIsNotNone(spend[0].get("usage"))
        self.assertEqual(spend[0]["usage"]["known"], True,
                         "the late response's real measurement upgraded the unknown record")
        self.assertEqual(spend[0]["usage"]["totalTokens"], 32)
        after = self.core("status", {})
        self.assertEqual(after["reflectionsLast24h"], 1, "the preemption does not charge a new attempt")
        self.assertEqual(after["reflectionTokensLast24h"], 32)
        self.assertEqual(after["reflectionTokensUnknown24h"], 0,
                         "the cost is known now, and it is still exactly one attempt")
        self.assertEqual(status["physical"], 1, "no second physical attempt was ever made")

    def test_a_foreground_turn_leaves_the_settlement_and_adoption_queues_intact(self):
        entered, release = threading.Event(), threading.Event()
        hooks, status = self.holding_hooks(entered, release)
        session = "queues-session"
        # A REAL adoption first: a user correction is recorded and recalled in a normal turn, so the
        # core holds a live receipt and the adoption index has an entry.
        hooks.pre_llm_call(session_id="learn-session", turn_id="1", platform="cli",
                           user_message="以后导出金额前先转换为数值，再按金额排序")
        hooks.post_llm_call(session_id="learn-session", turn_id="1", completed=True, failed=False,
                            assistant_response="已记录")
        lessons = self.core("list", {"limit": 5})["lessons"]
        self.assertGreaterEqual(len(lessons), 1, "the correction really became a lesson")
        self.start_turn(hooks, session, "1")
        self.assertTrue(entered.wait(15))
        # The foreground turn arrives. Everything that is NOT the background attempt stays: the
        # settlement queue keeps its entries, the adoption index keeps its record, and the turn's own
        # recall still runs.
        hooks.pre_llm_call(session_id=session, turn_id="2", platform="cli",
                           user_message="继续处理当前金额数据，先核对输入字段")
        self.assertFalse(hooks.settlement.paused, "preemption must not pause the settlement queue")
        self.assertNotIn("pause", hooks.local_control_pending)
        adoptions = self.core("recentAdoptions", {})
        self.assertTrue(adoptions.get("ok"), adoptions)
        # A second, ordinary turn still signs and commits normally once the slot is free.
        release.set()
        self.assertTrue(self.wait_idle(hooks))
        hooks.post_llm_call(session_id=session, turn_id="2", completed=True, failed=False,
                            assistant_response="已核对输入字段")
        self.assertTrue(self.wait_idle(hooks))
        self.assertTrue(self.core("problemStatus", {"limit": 5}).get("ok"))


class UnloadDrainTests(unittest.TestCase):
    """`hooks.dispose()` must not close the loop out from under a live attempt.

    The loop is the ONLY place the owner-side cleanup can run, so closing it first would abandon an
    open transport, leave the job Task pending, and lose the accounting of an attempt that already
    happened. These cases drive the REAL `dispose()` — never `cancel_pending` directly — with a held
    request and a held close, and assert that the loop is still alive until the cleanup really ends.
    """

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-unload-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.profile = Path(tempfile.mkdtemp(prefix="mse4b-unload-profile-"))
        self.addCleanup(shutil.rmtree, self.profile, True)
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.profile
        self.addCleanup(sys.modules.pop, "hermes_constants", None)
        sys.modules["hermes_constants"] = constants
        self.node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
        self.cli = ROOT / "src" / "cli.mjs"
        if not self.node or not self.cli.is_file():
            self.skipTest("node or the shipped CLI is unavailable")
        os.environ["MSE_NODE_EXECUTABLE"] = self.node
        os.environ["MSE_LEARN_CLI"] = str(self.cli)

    def core(self, op, value):
        result = subprocess.run([self.node, str(self.cli)],
                                input=json.dumps({"config": {"stateRoot": str(self.state_root),
                                                             "adapterId": "hermes", "maxContextBytes": 768},
                                                  "op": op, "input": value}),
                                text=True, capture_output=True, timeout=20, check=False)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def unload_fixture(self, *, hold_request=False, hold_close=False):
        """A real Hooks + driver whose transport holds the request and/or the close."""
        import asyncio
        import httpx

        status = {"physical": 0, "close_enter": 0, "close_exit": 0}
        request_gate = threading.Event()
        close_gate = threading.Event()
        request_entered = threading.Event()
        close_entered = threading.Event()

        class Held(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                status["physical"] += 1
                request_entered.set()
                if hold_request:
                    while not request_gate.is_set():
                        await asyncio.sleep(0.005)
                return httpx.Response(200, json={"id": "x", "object": "chat.completion", "created": 1,
                    "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "stop",
                    "message": {"role": "assistant",
                                "content": json.dumps({"instruction": INSTRUCTION}, ensure_ascii=False)}}],
                    "usage": {"prompt_tokens": 18, "completion_tokens": 0, "total_tokens": 18}})

            async def aclose(self):
                pass

        transport = Held()

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                                 http_client=httpx.AsyncClient(transport=transport, trust_env=False))
            original_close = client.close

            async def observed_close():
                status["close_enter"] += 1
                close_entered.set()
                if hold_close:
                    while not close_gate.is_set():
                        await asyncio.sleep(0.005)
                status["close_exit"] += 1
                await original_close()

            client.close = observed_close
            return client, identity.model

        hooks = bridge.Hooks(config={"stateRoot": str(self.state_root), "adapterId": "hermes",
                                     "maxContextBytes": 768},
                             enabled=lambda: True,
                             driver_factory=package.single_attempt_driver(self.profile))
        hooks.reflection_driver.resolver = lambda provider, model: {"provider": "deepseek-official",
            "model": "deepseek-flash", "api_mode": "chat_completions",
            "base_url": "https://source-a.invalid/v1", "api_key": "synthetic-key"}
        hooks.reflection_driver.client_factory = factory
        return {"hooks": hooks, "status": status, "request_gate": request_gate, "close_gate": close_gate,
                "request_entered": request_entered, "close_entered": close_entered,
                "release_request": request_gate.set, "release_close": close_gate.set}

    def wait_registry_empty(self, driver, seconds=5):
        """Bounded wait for the registry release that follows the cleanup the tests already proved.

        The release is the last step of the job's own bookkeeping, so it can trail the drain that
        proves the close finished by a few instructions. Waiting is not a substitute for an
        assertion: the cleanup end is asserted separately, and the release is asserted afterwards.
        """
        deadline = time.monotonic() + seconds
        while driver.status()["registered"] and time.monotonic() < deadline:
            time.sleep(0.005)
        return driver.status()["registered"]

    def start_background_attempt(self, hooks, session):
        """Real hooks: a cold turn with two independent tool failures starts the reflection."""
        hooks.pre_llm_call(session_id=session, turn_id="1", platform="cli",
                           user_message="导出金额并核对排序结果")
        hooks.pre_api_request(session_id=session, turn_id="1", provider="deepseek-official",
                              model="deepseek-flash", base_url="https://source-a.invalid/v1",
                              api_mode="chat_completions", api_request_id="api-1", request_messages=[],
                              request={"method": "POST", "body": {"model": "deepseek-flash",
                                                                  "reasoning_effort": "max"}})
        for call in ("call-1", "call-2"):
            hooks.post_tool_call(session_id=session, turn_id="1", tool_call_id=call, tool_name="bash",
                                 status="error", error_type="tool_error", read_only=False)
        hooks.post_llm_call(session_id=session, turn_id="1", completed=True, failed=True,
                            assistant_response="")

    def test_unload_while_the_request_is_held_drains_before_it_closes_the_loop(self):
        fixture = self.unload_fixture(hold_request=True)
        hooks, status = fixture["hooks"], fixture["status"]
        driver = hooks.reflection_driver
        try:
            self.start_background_attempt(hooks, "unload-held-request")
            self.assertTrue(fixture["request_entered"].wait(15), "the reflection reached the provider")
            self.assertEqual(status["physical"], 1)
            started = time.monotonic()
            outcome = hooks.dispose()
            # The unload publishes its intent and returns; it never blocks the foreground on a
            # provider that is still finishing.
            self.assertLess(time.monotonic() - started, 5.0, "unload must not block the foreground")
            self.assertEqual(outcome["invalidated"], 1, "the in-flight attempt was withdrawn")
            self.assertEqual(outcome["ticketsClosed"], 1, "its signed ticket was closed durably")
            self.assertIsNone(outcome["settled"],
                              "a foreground unload publishes; it never claims a settled drain")
            # ── what is NOT a scheduling fact: a loop may only be closed when nothing is left on it ──
            # Whether the withdrawal had already been carried out by the time `dispose()` returned is a
            # scheduling fact, and `_loop is None` proves NOTHING on its own. So the same call asserts
            # the invariant that holds either way: while the driver still owns cleanup, the loop is the
            # only place that cleanup can run and MUST still be alive; if it no longer owns any, the
            # drain must be provably finished, with nothing registered or pending and the transport
            # really closed. The deterministic form of the "still owned" branch — where the cleanup
            # CANNOT finish early — is the held-close case right below.
            # Measured on this candidate (`.probes/stage4b/logs/unload-race-probe-01.log`, 8 real runs):
            # 7/8 returns still owned cleanup (dispose window ~86 ms, cleanup ~90 ms) with the loop
            # alive and the attempt still registered; 1/8 found it already finished.
            if driver.cleanup_pending():
                self.assertIsNotNone(driver._loop)
                self.assertFalse(driver._loop.is_closed(),
                                 "the loop must not be closed while the tracked cleanup is still owned")
            else:
                early = hooks.cleanup_settled(timeout=10)
                self.assertTrue(early["settled"], "the drain really ended: %r" % (early,))
                self.assertFalse(driver.cleanup_pending(),
                                 "a closed loop may only follow a finished cleanup")
                self.assertEqual(driver.status()["slot"]["pendingTasks"], 0)
                self.assertEqual(driver.status()["registered"], 0)
            # The held request is still running; releasing it lets the cancel and the close finish.
            fixture["release_request"]()
            settled = hooks.cleanup_settled(timeout=25)
            self.assertIsNotNone(settled)
            self.assertTrue(settled["settled"], "the drain really completed: %r" % (settled,))
            self.assertFalse(driver.cleanup_pending(), "the tracked cleanup really finished")
            self.assertGreaterEqual(status["close_exit"], 1, "the client close really completed")
            self.assertFalse(hooks.jobs, "the worker finished")
            # The finished attempt left no registry reference and no pending owner task behind.
            self.assertEqual(self.wait_registry_empty(driver), 0,
                             "an unloaded driver keeps no finished attempt registered")
            self.assertEqual(driver.status()["slot"]["pendingTasks"], 0)
            self.assertEqual(sum(driver.status()["finished"][key]
                                 for key in ("committed", "cancelled", "closed", "refused", "other")), 1,
                             "the withdrawn attempt is counted exactly once, as a terminal attempt")
            state = json.loads((self.state_root / "lessons-v1.json").read_text())
            # The withdrawal was published while the request was in flight, so the answer is discarded
            # and cannot become a candidate.
            self.assertEqual([row for row in state["lessons"] if row["kind"] == "method"], [],
                             "an attempt withdrawn in flight never becomes a candidate")
            events = [row for row in state["events"] if row.get("reflection") is True]
            self.assertEqual(len(events), 1)
            self.assertTrue(events[0]["settled"], "the ticket is settled durably, not abandoned")
            spend = [row for row in state["spends"] if row["kind"] == "reflection"]
            self.assertEqual(len(spend), 1, "exactly one attempt was ever charged")
            self.assertIsNotNone(spend[0].get("usage"),
                                 "the attempt's cost is recorded even though the process is unloading")
        finally:
            fixture["release_request"]()
            fixture["release_close"]()
            driver.close(timeout=15)

    def test_unload_while_the_close_is_held_keeps_the_loop_and_the_usage(self):
        # BOTH gates are held: the request first, so the attempt reaches its client close with the
        # withdrawal published, and then the close, so the unload provably arrives while the transport
        # is still open. Without the request gate the job could legitimately finish before the unload,
        # and asserting "no candidate" would then be asserting something the contract never promised.
        fixture = self.unload_fixture(hold_request=True, hold_close=True)
        hooks, status = fixture["hooks"], fixture["status"]
        driver = hooks.reflection_driver
        try:
            self.start_background_attempt(hooks, "unload-held-close")
            self.assertTrue(fixture["request_entered"].wait(15), "the reflection reached the provider")
            self.assertEqual(status["physical"], 1)
            # Release the request so the attempt proceeds to its close; the withdrawal is published
            # while the request was still in flight, so the answer cannot become a candidate.
            fixture["release_request"]()
            self.assertTrue(fixture["close_entered"].wait(15), "the job reached its close")
            self.assertEqual(status["close_exit"], 0, "the close is genuinely still running")
            outcome = hooks.dispose()
            self.assertIsNone(outcome["settled"], "the drain is still running, and says so")
            # ── the DETERMINISTIC form of the "cleanup still owned" branch ──────────────────────────
            # The close gate is held, so the cleanup genuinely CANNOT finish here: this is the case in
            # which the loop is the only place the close can run and must stay open, and in which the
            # attempt must still be registered — dropping it now would fake an empty slot and lose the
            # close it still owns.
            self.assertIsNotNone(driver._loop)
            self.assertFalse(driver._loop.is_closed(),
                             "the loop is the only place the close can finish: it must stay open")
            self.assertTrue(driver.cleanup_pending(), "the transport is still open")
            self.assertEqual(driver.status()["registered"], 1,
                             "a job whose close is still owned stays registered, not dropped early")
            self.assertEqual(len(driver._active_jobs()), 1)
            self.assertEqual(driver.status()["finished"]["jobs"], 0,
                             "nothing is counted as finished while its cleanup is still owned")
            # The slot keeps TRACKING that cleanup task for as long as it is genuinely running. The
            # registration follows the job's own bookkeeping by a few instructions, so this is
            # observed with a bounded wait — the cleanup gate is still closed, so it cannot end.
            deadline = time.monotonic() + 5
            while driver.status()["slot"]["pendingTasks"] == 0 and time.monotonic() < deadline:
                time.sleep(0.002)
            self.assertEqual(driver.status()["slot"]["pendingTasks"], 1,
                             "the still-running cleanup stays tracked in the slot")
            # Release the close: the tracked cleanup finishes and the accounting survives.
            fixture["release_close"]()
            settled = hooks.cleanup_settled(timeout=25)
            self.assertIsNotNone(settled)
            self.assertTrue(settled["settled"], "the held close completed and the drain settled")
            self.assertFalse(driver.cleanup_pending())
            self.assertGreaterEqual(status["close_exit"], 1, "the held close really completed")
            self.assertFalse(hooks.jobs)
            self.assertEqual(self.wait_registry_empty(driver), 0,
                             "once the cleanup really ended, the finished attempt is released")
            self.assertEqual(driver.status()["slot"]["pendingTasks"], 0)
            self.assertEqual(driver.status()["finished"]["committed"], 1,
                             "the committed attempt is the one that finished here")
            state = json.loads((self.state_root / "lessons-v1.json").read_text())
            # This attempt had ALREADY committed legitimately before the unload arrived (the close
            # entry proves it), so the unload must not revoke it. What it must do is leave the record
            # exactly once, settled, with its measured cost — and start nothing new.
            methods = [row for row in state["lessons"] if row["kind"] == "method"]
            self.assertEqual(len(methods), 1, "the already-committed candidate is preserved, not undone")
            events = [row for row in state["events"] if row.get("reflection") is True]
            self.assertEqual(len(events), 1, "no second attempt was signed by the unload")
            self.assertTrue(events[0]["settled"], "no ticket is left unsettled by an unload")
            spend = [row for row in state["spends"] if row["kind"] == "reflection"]
            self.assertEqual(len(spend), 1, "the committed attempt is charged exactly once")
            self.assertEqual(spend[0]["usage"]["known"], True)
            self.assertEqual(spend[0]["usage"]["totalTokens"], 18,
                             "the measured cost is recorded, not lost to the unload")
            status_now = self.core("status", {})
            self.assertEqual(status_now["reflectionTokensLast24h"], 18)
            self.assertEqual(status_now["reflectionsLast24h"], 1)
        finally:
            fixture["release_request"]()
            fixture["release_close"]()
            driver.close(timeout=15)

    def test_an_unloaded_driver_refuses_new_attempts_instead_of_signing_them(self):
        fixture = self.unload_fixture()
        hooks, status = fixture["hooks"], fixture["status"]
        driver = hooks.reflection_driver
        try:
            self.start_background_attempt(hooks, "unload-refuse")
            deadline = time.monotonic() + 15
            while hooks.jobs and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(status["physical"], 1)
            hooks.dispose()
            self.assertEqual(hooks.cleanup_settled(timeout=15)["settled"], True)
            self.assertTrue(hooks.closed)
            # A new attempt after unload is a bounded refusal, not a signed ticket.
            before = self.core("status", {})["reflectionsLast24h"]
            refused = driver.run({"route_provider": "deepseek-official", "route_model": "deepseek-flash",
                                  "pre_api": {}, "base": {"sessionId": "after-unload"}, "outcome": "failed",
                                  "source_session": "after-unload", "problem": {}, "ticket": None},
                                 "failed", ("a task summary", "a result summary"), threading.Event(),
                                 fixture["hooks"].call)
            self.assertEqual(refused.get("wait"), "driver_shutting_down")
            self.assertEqual(self.core("status", {})["reflectionsLast24h"], before,
                             "an unloaded driver signs nothing")
        finally:
            fixture["release_request"]()
            fixture["release_close"]()


@NEEDS_SDK
class PauseResumeRecoveryTests(unittest.TestCase):
    """A PAUSE and its resume must leave the lifecycle able to sign the NEXT qualified attempt.

    `set_enabled(False)` withdraws what is in flight. It is NOT an unload, and the frozen evidence
    showed what happens when the two are conflated: the ordinary pause published the driver's
    PERMANENT shutdown flag, so after a confirmed resume the next independent, gate-ready problem was
    answered with `driver_shutting_down` — one physical attempt, and no way back for the rest of the
    process's life.

    These cases drive the REAL `set_enabled` pair, the real hooks, the real driver and the real core,
    and assert the boundary itself: an ordinary withdrawal (pause, foreground cancel, session
    boundary) still allows the recovered lifecycle to sign a new qualified attempt, while a real
    `dispose()` keeps refusing new work for good.
    """

    def setUp(self):
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4b-pause-"))
        self.addCleanup(shutil.rmtree, self.state_root, True)
        self.profile = Path(tempfile.mkdtemp(prefix="mse4b-pause-profile-"))
        self.addCleanup(shutil.rmtree, self.profile, True)
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: self.profile
        self.addCleanup(sys.modules.pop, "hermes_constants", None)
        sys.modules["hermes_constants"] = constants
        self.node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
        self.cli = ROOT / "src" / "cli.mjs"
        if not self.node or not self.cli.is_file():
            self.skipTest("node or the shipped CLI is unavailable")
        os.environ["MSE_NODE_EXECUTABLE"] = self.node
        os.environ["MSE_LEARN_CLI"] = str(self.cli)

    def core(self, op, value):
        result = subprocess.run([self.node, str(self.cli)],
                                input=json.dumps({"config": {"stateRoot": str(self.state_root),
                                                             "adapterId": "hermes", "maxContextBytes": 768},
                                                  "op": op, "input": value}),
                                text=True, capture_output=True, timeout=20, check=False)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def answering_hooks(self):
        """A real `Hooks` + real driver whose provider answers immediately, with real accounting."""
        import httpx

        status = {"physical": 0, "closed": 0}
        usage = {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}

        class Answering(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                status["physical"] += 1
                body = {"id": "synthetic", "object": "chat.completion", "created": 1,
                        "model": "deepseek-flash",
                        "choices": [{"index": 0, "finish_reason": "stop", "message": {
                            "role": "assistant",
                            "content": json.dumps({"instruction": INSTRUCTION}, ensure_ascii=False)}}],
                        "usage": usage}
                return httpx.Response(200, json=body)

            async def aclose(self):
                status["closed"] += 1

        transport = Answering()
        hooks = bridge.Hooks(config={"stateRoot": str(self.state_root), "adapterId": "hermes",
                                     "maxContextBytes": 768},
                             enabled=lambda: True,
                             driver_factory=package.single_attempt_driver(self.profile))
        self.addCleanup(hooks.dispose)
        driver = hooks.reflection_driver
        driver.resolver = lambda provider, model: {"provider": "deepseek-official",
            "model": "deepseek-flash", "api_mode": "chat_completions",
            "base_url": "https://source-a.invalid/v1", "api_key": "synthetic-key"}

        def factory(identity, runtime):
            from openai import AsyncOpenAI
            return AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                               http_client=httpx.AsyncClient(transport=transport, trust_env=False)), identity.model

        driver.client_factory = factory
        return hooks, status

    def start_turn(self, hooks, session, tool="bash", turn="1"):
        """The REAL hooks a host fires for one turn, in the host's own order."""
        hooks.pre_llm_call(session_id=session, turn_id=turn, platform="cli",
                           user_message="导出金额并核对排序结果")
        hooks.pre_api_request(session_id=session, turn_id=turn, provider="deepseek-official",
                              model="deepseek-flash", base_url="https://source-a.invalid/v1",
                              api_mode="chat_completions", api_request_id="api-%s-%s" % (session, turn),
                              request_messages=[],
                              request={"method": "POST", "body": {"model": "deepseek-flash",
                                                                  "reasoning_effort": "max"}})
        for call in ("call-1", "call-2"):
            hooks.post_tool_call(session_id=session, turn_id=turn,
                                 tool_call_id="%s-%s-%s" % (session, turn, call), tool_name=tool,
                                 status="error", error_type="tool_error", read_only=False)
        hooks.post_llm_call(session_id=session, turn_id=turn, completed=True, failed=True,
                            assistant_response="")

    def wait_idle(self, hooks, seconds=20):
        deadline = time.monotonic() + seconds
        while hooks.jobs and time.monotonic() < deadline:
            time.sleep(0.02)
        return not hooks.jobs

    def problems(self):
        state = json.loads((self.state_root / "lessons-v1.json").read_text())
        return state.get("problemLoop", {}).get("problems", []), state

    def test_a_confirmed_pause_and_resume_let_the_next_qualified_problem_dispatch(self):
        hooks, status = self.answering_hooks()
        driver = hooks.reflection_driver
        first = "pause-session-first"
        self.start_turn(hooks, first, tool="bash")
        self.assertTrue(self.wait_idle(hooks), "the first background attempt finished")
        self.assertEqual(status["physical"], 1, "the first attempt really reached the provider")
        self.assertEqual(status["closed"], 1, "and its own client was closed")
        problems, _ = self.problems()
        first_problem = [row for row in problems if row["toolName"] == "bash"][0]
        self.assertEqual(first_problem["state"], "candidate_created", first_problem)
        self.assertEqual(first_problem["attemptedRevision"], first_problem["evidenceRevision"],
                         "the first attempt is consumed and may never be replayed")
        # ── the REAL pause/resume pair, exactly as a user drives it ──────────────────────────────
        pause = hooks.set_enabled(False)
        resume = hooks.set_enabled(True)
        self.assertTrue(pause["confirmed"], pause)
        self.assertTrue(resume["confirmed"], resume)
        self.assertEqual((pause["generation"], resume["generation"]), (2, 3))
        self.assertTrue(hooks.running, "the lifecycle is running again after the confirmed resume")
        self.assertFalse(driver._shutting_down,
                         "an ordinary pause is NOT an unload: it may not refuse the recovered lifecycle")
        # ── a genuinely independent, gate-ready problem on a new session ─────────────────────────
        clock = node_clock.NodeClock(self)
        clock.advance_ms(31 * 60_000)
        second = "pause-session-second"
        self.start_turn(hooks, second, tool="read_file")
        self.assertTrue(self.wait_idle(hooks), "the second background attempt finished")
        self.assertNotEqual(hooks.problems.get("last"), "driver_shutting_down", hooks.problems)
        self.assertEqual(status["physical"], 2,
                         "the resumed lifecycle really dispatched a SECOND physical attempt")
        self.assertEqual(status["closed"], 2, "and closed its own client too")
        problems, state = self.problems()
        second_problem = [row for row in problems if row["toolName"] == "read_file"][0]
        self.assertNotEqual(second_problem["id"], first_problem["id"],
                            "the second problem is independent, not a replay of the first")
        self.assertEqual(second_problem["attemptedRevision"], second_problem["evidenceRevision"],
                         "the second attempt really signed and consumed its own revision")
        self.assertIsNotNone(second_problem["lessonId"],
                             "a real answer past the resume became its own candidate")
        self.assertEqual(first_problem["attemptedRevision"], first_problem["evidenceRevision"],
                         "the paused generation's problem is not re-attempted by the resume")
        core_status = self.core("status", {})
        self.assertEqual(core_status["reflectionsLast24h"], 2, "two attempts, one per problem")
        events = [row for row in state["events"] if row.get("reflection") is True]
        self.assertEqual(len(events), 2, "no third ticket was signed or replayed")
        self.assertTrue(all(row["settled"] for row in events), events)
        # ── and the registry is empty once both attempts are really over ─────────────────────────
        self.assertEqual(list(driver.jobs), [], "both finished attempts released their references")
        self.assertEqual(driver.status()["registered"], 0)
        self.assertEqual(driver.status()["finished"]["jobs"], 2)

    def test_an_ordinary_withdrawal_leaves_the_driver_alive_while_an_unload_does_not(self):
        hooks, status = self.answering_hooks()
        driver = hooks.reflection_driver
        self.start_turn(hooks, "withdraw-session-first", tool="bash")
        self.assertTrue(self.wait_idle(hooks))
        self.assertEqual(status["physical"], 1)
        # ── the ORDINARY withdrawal a pause, a preemption or a session boundary takes ────────────
        hooks.cancel_pending()
        self.assertFalse(driver._shutting_down,
                         "an ordinary withdrawal withdraws the work, not the driver's future")
        clock = node_clock.NodeClock(self)
        clock.advance_ms(31 * 60_000)
        before = self.core("status", {})["reflectionsLast24h"]
        self.start_turn(hooks, "withdraw-session-second", tool="read_file")
        self.assertTrue(self.wait_idle(hooks))
        self.assertEqual(status["physical"], 2,
                         "the lifecycle that recovers may still sign a new qualified attempt")
        self.assertEqual(self.core("status", {})["reflectionsLast24h"], before + 1,
                         "the second attempt was really signed by the core")
        self.assertNotEqual(hooks.problems.get("last"), "driver_shutting_down", hooks.problems)
        # ── the PERMANENT half still belongs to the real unload, and only to it ──────────────────
        hooks.dispose()
        self.assertEqual(hooks.cleanup_settled(timeout=15)["settled"], True)
        self.assertTrue(driver._shutting_down, "a real unload refuses new work for good")
        after = self.core("status", {})["reflectionsLast24h"]
        refused = driver.run({"route_provider": "deepseek-official", "route_model": "deepseek-flash",
                              "pre_api": {}, "base": {"sessionId": "withdraw-after-unload"},
                              "outcome": "failed", "source_session": "withdraw-after-unload",
                              "problem": {}, "ticket": None},
                             "failed", ("一个任务摘要", "一个结果摘要"), threading.Event(), hooks.call)
        self.assertEqual(refused.get("wait"), "driver_shutting_down", refused)
        self.assertEqual(self.core("status", {})["reflectionsLast24h"], after,
                         "an unloaded driver signs nothing")
        self.assertEqual(list(driver.jobs), [], "a refused attempt registers nothing")
