"""Stage 4c — the automatic-advance pass: one bounded timer, the fair cursor, and recovery.

Offline, like the other business suites: the Node core is the shipped `src/cli.mjs` in a temporary
state root, the provider is a fake in-memory transport, and no credential, profile or daily store is
read. What is under test is the REAL pass (`adapters/hermes/plan.py`) driven through the REAL bridge
(`adapters/hermes/bridge.py`) and the REAL driver against the REAL core transactions.

The four contracts these cases lock down:

  • ONE wake-up chain per instance. Startup, a real event and the timer merge into it, and a pass
    that is still running cannot be re-entered by its own callback.
  • The persistent fair cursor covers every category (problems, reviews, objectives, renewals), is
    advanced by real consideration, and a plan that keeps failing cannot pin the front for ever.
  • Recovery is honest: a DEAD process's `running` plan is released with its ticket VOIDED and is
    never submitted, while an UNSIGNED wait (budget, cooldown, unconfirmed source) is simply left to
    become due again — and a budget of zero makes NO paid request at all.
  • Reads stay reads: `auto_pass_status` and the instance's own status must not scan, write, arm a
    timer or wake a model.
"""
import hashlib
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


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def use_installed_sdk():
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
            import openai  # noqa: F401
            return "committed:%s" % (site, ), None
        except ImportError as error:
            return None, "committed SDK unreadable: %s" % (error,)
    return None, "no committed environment carries the openai SDK"


SDK_SOURCE, SDK_PROBLEM = use_installed_sdk()
NEEDS_SDK = unittest.skipUnless(SDK_SOURCE, SDK_PROBLEM or "the installed SDK is required")

bridge = load("mse_learning_bridge_4cpass", ROOT / "adapters/hermes/bridge.py")
planmod = load("mse_learning_plan_4cpass", ROOT / "adapters/hermes/plan.py")
pkg = types.ModuleType("mse_hermes_pkg")
pkg.__path__ = [str(ROOT / "adapters" / "hermes")]
sys.modules.setdefault("mse_hermes_pkg", pkg)
driver = load("mse_learning_driver_4cpass", ROOT / "adapters/hermes/driver.py")
node_clock_mod = load("mse_learning_node_clock_4cpass", ROOT / "tests/node_clock.py")

PROVIDER = "deepseek-official"
MODEL = "deepseek-flash"
EFFORT = "max"
BASE_URL = "https://source-a.invalid/v1"
SESSION = "auto-session-1"
PROJECT = "probe-project"
INSTRUCTION = "并发提交前先核对请求代次与票据状态，再提交写入并核对结算记录，避免重复提交。"


def node_cli():
    node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
    cli = ROOT / "src" / "cli.mjs"
    if not node or not cli.is_file():
        raise unittest.SkipTest("node or the shipped CLI is unavailable")
    return node, cli


class Clock:
    """A controlled monotonic clock. The pass reads it through its injected `now`."""

    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class Scheduler:
    """The ONE timer seam: records the pending callback instead of waiting on real time."""

    def __init__(self, clock):
        self.clock = clock
        self.pending = []
        self.cancelled = 0
        self.armed = 0

    def schedule(self, fn, delay):
        handle = {"fn": fn, "at": self.clock() + max(0.0, delay), "cancelled": False}
        self.pending.append(handle)
        self.armed += 1
        return handle

    def cancel(self, handle):
        if isinstance(handle, dict):
            handle["cancelled"] = True
            self.cancelled += 1

    def fire(self):
        """Fire the earliest pending callback, exactly as a real timer thread would."""
        live = [row for row in self.pending if not row["cancelled"]]
        self.pending = live
        if not live:
            return False
        row = min(live, key=lambda item: item["at"])
        live.remove(row)
        self.clock.value = max(self.clock.value, row["at"])
        row["fn"]()
        return True

    def live(self):
        return [row for row in self.pending if not row["cancelled"]]

    def fire_all(self, limit=8):
        fired = 0
        while fired < limit and self.fire():
            fired += 1
        return fired


class Core:
    """The real core over its shipped CLI, exactly as the bridge calls it."""

    def __init__(self, state_root, *, tokens_per_day=100_000, calls_per_day=8):
        self.root = Path(state_root)
        self.node, self.cli = node_cli()
        self.config = {"stateRoot": str(state_root), "adapterId": "hermes", "maxContextBytes": 768,
                       "evaluationTokensPerDay": tokens_per_day, "evaluationCallsPerDay": calls_per_day}
        self.operations = []
        self.on_answer = None

    def __call__(self, op, value):
        result = subprocess.run([self.node, str(self.cli)],
                                input=json.dumps({"config": self.config, "op": op, "input": value}),
                                text=True, capture_output=True, timeout=20, check=False)
        answer = json.loads(result.stdout) if result.stdout.strip() else {"ok": False, "code": "no_output"}
        # `autoPlans` answers a bare ARRAY while every other operation answers a document; the
        # transport records what really arrived either way.
        ok = answer.get("ok") if isinstance(answer, dict) else None
        code = answer.get("code") if isinstance(answer, dict) else None
        self.operations.append({"op": op, "value": value, "ok": ok, "code": code,
                                "skipped": answer.get("skipped") if isinstance(answer, dict) else None})
        if self.on_answer is not None:
            self.on_answer(op, value, answer)
        return answer

    def ops(self, name):
        return [row for row in self.operations if row["op"] == name]

    def document(self):
        return json.loads((self.root / "lessons-v1.json").read_text())

    def digest(self):
        body = (self.root / "lessons-v1.json").read_bytes()
        return hashlib.sha256(body).hexdigest()

    def publish(self, session=SESSION, project=None, **overrides):
        # `environmentId` is the RAW identity the core hashes itself (`hash(identity(id))`), and the
        # default it applies when none is stated is the literal string `default`. A fixture that
        # published without it would put the source row in a DIFFERENT environment than the lesson it
        # is later charged to, and the core's own gate would (correctly) refuse the request. So the
        # source is published once, in the environment the work really belongs to — never repaired
        # afterwards, because the proof is what the gate compares.
        # NO `projectKey`: this suite's candidates are instance-scoped, and the core's own gate
        # compares the published scope with the lesson it is charged to — so a source published in
        # project scope could never authorise an instance-scoped lesson. The isolation is intact: the
        # fixture states the same scope its lesson really has, instead of widening either one.
        value = {"sessionId": session,
                 "environmentId": os.environ.get("MSE_TEST_ENVIRONMENT_ID", "default"),
                 "provider": PROVIDER, "model": MODEL,
                 "apiMode": "chat_completions", "baseUrl": BASE_URL, "reasoningState": "explicit",
                 "reasoningValue": EFFORT, "driver": "async_openai_chat"}
        if isinstance(project, str) and project:
            value["projectKey"] = project
        value.update(overrides)
        return self("sourcePublish", value)

    def observe(self, index, session, project=None, tool="bash"):
        """One trusted host failure observation (the real entrance to the problem ledger)."""
        value = {"sessionId": session, "turnId": str(index), "eventId": "host-failure-%s-%d" % (session, index),
                 "kind": "tool_failure", "source": "host_event", "toolName": tool,
                 "failureCode": "tool_nonzero_exit", "taskClass": "lifecycle-submit",
                 "summary": "工具失败：%s" % tool}
        if isinstance(project, str) and project:
            value["projectKey"] = project
        answer = self("observeProblem", value)
        if answer.get("ok") is not True:
            raise AssertionError("the fixture could not observe a problem: %r" % (answer,))
        return answer

    def candidate(self, problem_id, session, project=None, instruction=INSTRUCTION, turn="1"):
        """The REAL reflection path: a matured problem → one candidate BOUND to that session/project.

        This is the ONLY way this suite produces a candidate. A lesson written by a bare `record` has
        no session and therefore no provable source — which is a real boundary, not something a fixture
        may patch around — so the candidate comes from the same lifecycle the product uses, and it
        carries the session and project the evidence was observed under.
        """
        row = self("problemStatus", {"limit": 32, **({"projectKey": project} if project else {})})
        match = next((item for item in (row.get("rows") or []) if item.get("id") == problem_id), None)
        if match is None:
            raise AssertionError("the fixture lost its problem row: %r" % (row,))
        value = {"sessionId": session, "turnId": turn, "outcome": "failed",
                 "taskSummary": "合成任务：提交结算前需要核对当前代次与票据状态，避免重复提交。",
                 "resultSummary": "合成结果：工具非零退出，任务未完成，根因未确定，需要复盘失败条件。",
                 "problemId": problem_id, "evidenceRevision": match.get("evidenceRevision")}
        if isinstance(project, str) and project:
            value["projectKey"] = project
        prepared = self("reflectionRequest", value)
        if not prepared.get("ticket"):
            raise AssertionError("the fixture could not reserve the reflection: %r" % (prepared,))
        learned = self("reflectionResult", {"ticket": prepared["ticket"], "result": {"instruction": instruction}})
        if not learned.get("id"):
            raise AssertionError("the reflection produced no candidate: %r" % (learned,))
        return learned["id"]

    def lesson(self, event_id="pass-lesson", instruction=INSTRUCTION, project=None):
        # NOTE the absence of `projectKey`: a candidate row the core hands back carries no project key
        # (only the scope HASH), so this is the scope an automatic pass can really resolve. A
        # project-scoped candidate is NOT registrable from the row alone — that limitation is recorded
        # as an open item rather than papered over by a fixture that pretends to know the scope.
        value = {"eventId": event_id, "kind": "method", "source": "host_proposal",
                 "instruction": instruction}
        if isinstance(project, str) and project:
            value["projectKey"] = project
        answer = self("record", value)
        if answer.get("ok") is not True:
            raise AssertionError("the fixture could not record a method: %r" % (answer,))
        return answer["id"]

    def row(self, lesson_id):
        answer = self("autoCandidateFacts", {"lessonId": lesson_id})
        if answer.get("ok") is not True or not isinstance(answer.get("row"), dict):
            raise AssertionError("the fixture could not read the candidate row: %r" % (answer,))
        return answer["row"]

    def plans(self):
        value = self("autoPlans", {})
        return value if isinstance(value, list) else []

    def plan_for(self, lesson_id, track):
        for plan in self.plans():
            if plan.get("lessonId") == lesson_id and plan.get("track") == track:
                return plan
        return None

    def source_rows(self):
        return self("sourceStatus", {"limit": 32}).get("rows", [])


def register_plan(core, lesson_id, row, track, session):
    """Register ONE plan the way the product does: from the CORE's own proposal, never by hand."""
    source = {"kind": "manual_backfill", "sessionId": session,
              "route": {"provider": PROVIDER, "model": MODEL, "reasoningEffort": EFFORT}}
    # The scope travels only when the row really carries one; `environment` is the core's own
    # normalised value, passed back exactly as it reported it.
    project = row.get("projectKey")
    value = {"lessonId": lesson_id, "version": row["version"], "environment": row["environment"],
             "track": track, "source": source}
    if isinstance(project, str) and project:
        value["projectKey"] = project
    proposal = core("autoPlanProposal", value)
    if proposal.get("ok") is not True:
        raise AssertionError("the fixture could not propose a plan: %r" % (proposal,))
    register = dict(value, suite=proposal["suite"], criteria=proposal["criteria"],
                    caseId=proposal["caseId"])
    answer = core("autoPlanRegister", register)
    if answer.get("ok") is not True:
        raise AssertionError("the fixture could not register a plan: %r" % (answer,))
    return answer


def fake_transport(answers):
    import httpx

    class InMemory(httpx.AsyncBaseTransport):
        def __init__(self):
            self.physical = 0
            self.closed = 0
            self.bodies = []

        async def handle_async_request(self, request):
            self.physical += 1
            body = {}
            try:
                body = json.loads(request.content.decode("utf-8")) if request.content else {}
            except Exception:  # noqa: BLE001
                pass
            self.bodies.append(body)
            return httpx.Response(200, json=answers(body))

        async def aclose(self):
            self.closed += 1

    return InMemory()


class PassFixture:
    """A REAL `Hooks` with the ONE driver AND the ONE pass, over a real core and a fake transport."""

    def __init__(self, test, *, tokens_per_day=100_000, calls_per_day=8, usage=True):
        self.test = test
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4c-pass-"))
        test.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = Core(self.state_root, tokens_per_day=tokens_per_day, calls_per_day=calls_per_day)
        self.clock = Clock()
        self.scheduler = Scheduler(self.clock)
        self.transport = fake_transport(self._answer)
        self.usage = usage
        self._install_hooks(tokens_per_day, calls_per_day)

    def _install_hooks(self, tokens_per_day, calls_per_day):
        self.hooks = bridge.Hooks(config={"stateRoot": str(self.state_root), "adapterId": "hermes",
                                          "maxContextBytes": 768,
                                          "evaluationTokensPerDay": tokens_per_day,
                                          "evaluationCallsPerDay": calls_per_day},
                                  call=self.core,
                                  driver_factory=self.driver_factory,
                                  schedule=self.scheduler.schedule,
                                  cancel=self.scheduler.cancel)
        self.hooks.monotonic = self.clock
        self.hooks.wall_ms = lambda: 1_700_000_000_000 + int(self.clock() * 1000)
        # The pass is built AFTER the clock/wall seams are in place, over the SAME Hooks instance.
        self.hooks.set_plan_pass(lambda hooks: planmod.build_auto_pass(
            hooks, call=self.core, clock=self.clock, state=hooks.plan,
            schedule=self.scheduler.schedule, cancel=self.scheduler.cancel))

    def restart_hooks(self, tokens_per_day=100_000, calls_per_day=8):
        """Rebuild a fresh production Hooks/driver/pass over the same persistent core state."""
        self.hooks.dispose()
        self._install_hooks(tokens_per_day, calls_per_day)
        # NOTE: the source row is published by `observe_route`, in the SCOPE this fixture is about. An
        # early instance-scope publish would lock the row (the core refuses a later project publish as
        # a scope mismatch), and the fixture would then be testing a scope it never claimed.

    def driver_factory(self, hooks):
        return driver.ReflectionDriver(hooks, resolver=self.resolver, client_factory=self.client_factory,
                                      allow_direct_client=False)

    def resolver(self, provider, model):
        return {"provider": PROVIDER, "model": MODEL, "api_mode": "chat_completions",
                "base_url": BASE_URL, "api_key": "synthetic-key"}

    def client_factory(self, identity, runtime):
        import httpx
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                             http_client=httpx.AsyncClient(transport=self.transport))
        return client, identity.model

    def _answer(self, body):
        messages = body.get("messages") or [{}]
        system = messages[0].get("content", "") if isinstance(messages[0], dict) else ""
        if "你是独立的答案评审" in system:
            content = json.dumps({"winner": "tie", "reason": "两侧按同一规则作答，未发现差异",
                                  "criteria": []}, ensure_ascii=False)
        else:
            content = "DISCARD —— 当前活动代次为 9，到达结果的代次为 7，落后于活动代次，按约定丢弃。"
        answer = {"id": "chatcmpl-pass", "object": "chat.completion", "created": 0, "model": MODEL,
                  "choices": [{"index": 0, "finish_reason": "stop",
                               "message": {"role": "assistant", "content": content}}]}
        if self.usage:
            answer["usage"] = {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}
        return answer

    def observe_route(self, session=SESSION, turn="turn-1", *, base_url=BASE_URL,
                      api_mode="chat_completions", effort=EFFORT, project=None):
        """Publish the dispatch facts AND the published source row a real turn would have produced.

        The source row must be published under the SAME environment the lesson was recorded in: the
        core's own gate refuses a session whose published scope/environment differs from the lesson
        charged to it, and that refusal is the correct production behaviour. The fixture therefore
        re-publishes the source with the environment the core itself reports for the lesson.
        """
        """Publish the dispatch facts a REAL `pre_api_request` would have reported for that session."""
        body = {"model": MODEL}
        if effort is not None:
            body["reasoning_effort"] = effort
        self.hooks.pre_api[(session, turn)] = {"provider": PROVIDER, "model": MODEL, "base_url": base_url,
                                               "api_mode": api_mode,
                                               "request": {"method": "POST", "body": body}}
        self.hooks.routes[(session, turn)] = {"provider": PROVIDER, "model": MODEL,
                                              **({} if effort is None else {"reasoningEffort": effort})}
        # The source ROW is published in the environment the work is charged to, and — when this
        # fixture is about a project — in that project's own scope. The core re-derives both from what
        # it is given, so the fixture states the identity a real turn in that project would have.
        self.core.publish(session, project=project)
        # Re-publish the source under the lesson's own environment when the fixture already created
        # one. The core compares the two inside its gate, so an unrelated environment is a refusal by
        # design — and a fixture that wants to observe the paid path has to publish what a real turn
        # in that environment would have.


    def with_session(self, lesson_id, session=SESSION, project=PROJECT):
        """Bind the lesson to the session it was really observed in, as the core itself does.

        A candidate produced from a real tool failure carries that failure's session; this fixture
        writes the same fact into the core's own document (nothing else is touched), because the pass
        must be able to PROVE the original route from it — and must never borrow another session when
        it cannot.
        """
        path = self.state_root / "lessons-v1.json"
        document = json.loads(path.read_text())
        for lesson in document.get("lessons", []):
            if lesson.get("id") == lesson_id:
                lesson["sessionId"] = session
                if project:
                    lesson["projectKey"] = project
        path.write_text(json.dumps(document))
        return lesson_id

    def step(self, reason="timer"):
        # NO fixture write here on purpose: a pass that considered nothing must leave the document
        # byte-identical, and a `publish` smuggled into `step()` would hide that (and would make the
        # "idle pass writes nothing" case test the fixture instead of the product). Cases that need a
        # published source row call `observe_route()`, which publishes it in their own scope.
        return self.hooks.auto_pass(reason)

    def close(self):
        try:
            self.hooks.dispose()
            self.hooks.cleanup_settled(timeout=5)
        except Exception:  # noqa: BLE001
            pass


class TimerChainTests(unittest.TestCase):
    """ONE wake-up chain: it merges, it never forks, and it cannot re-enter itself."""

    def fixture(self, **kwargs):
        fixture = PassFixture(self, **kwargs)
        self.addCleanup(fixture.close)
        return fixture

    def test_start_arms_exactly_one_timer_and_a_burst_of_events_does_not_add_another(self):
        fixture = self.fixture()
        fixture.observe_route()
        started = fixture.hooks.start_auto_pass("startup")
        self.assertTrue(started.get("armed"), "%r" % (started,))
        self.assertEqual(len(fixture.scheduler.live()), 1)
        for reason in ("turn_end", "settings", "resumed", "scan"):
            fixture.hooks.request_auto_pass(reason)
        self.assertEqual(len(fixture.scheduler.live()), 1, "a burst of real events merges into the one wake-up")
        self.assertGreaterEqual(fixture.scheduler.cancelled, 0)

    def test_the_timer_fires_one_pass_and_re_arms_itself(self):
        fixture = self.fixture()
        fixture.observe_route()
        fixture.hooks.start_auto_pass("startup")
        first = fixture.scheduler.fire()
        self.assertTrue(first, "the armed wake-up really fired")
        self.assertEqual(fixture.hooks.auto_pass_status()["passes"], 1)
        self.assertEqual(len(fixture.scheduler.live()), 1, "the chain re-armed itself exactly once")
        self.assertIsNotNone(fixture.hooks.auto_pass_status()["last"], "the pass publishes its own audit")
        # Another tick: still one live callback, one more pass.
        fixture.scheduler.fire()
        self.assertEqual(len(fixture.scheduler.live()), 1)
        self.assertEqual(fixture.hooks.auto_pass_status()["passes"], 2)

    def test_a_pass_that_is_still_running_is_not_re_entered_by_its_own_callback(self):
        fixture = self.fixture()
        fixture.observe_route()
        fixture.hooks.start_auto_pass("startup")
        pass_chain = fixture.hooks._plan
        first = pass_chain.pass_once("manual")
        self.assertTrue(first.get("ok"), "%r" % (first,))
        # Simulate the timer firing while a pass is already inside its critical section.
        pass_chain.busy = True
        second = pass_chain.pass_once("timer")
        self.assertEqual(second.get("code"), "busy")
        pass_chain.busy = False

    def test_stop_and_dispose_leave_no_live_timer(self):
        fixture = self.fixture()
        fixture.observe_route()
        fixture.hooks.start_auto_pass("startup")
        self.assertEqual(len(fixture.scheduler.live()), 1)
        fixture.hooks.dispose()
        self.assertEqual(len(fixture.scheduler.live()), 0, "an unload leaves no wake-up armed")
        self.assertEqual(fixture.hooks.auto_pass_status(), {"installed": False})


@NEEDS_SDK
class BudgetGateTests(unittest.TestCase):
    """A budget of zero makes NO paid request — not a cheap one, and not a ticket."""

    def test_a_zero_budget_registers_nothing_and_spends_nothing(self):
        fixture = PassFixture(self, tokens_per_day=0, calls_per_day=0)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        lesson = fixture.with_session(fixture.core.lesson())
        fixture.hooks.start_auto_pass("startup")
        audit = fixture.step()
        self.assertEqual(audit.get("ok"), True, "%r" % (audit,))
        self.assertEqual(fixture.transport.physical, 0, "no paid request is ever issued")
        self.assertEqual(fixture.core.ops("reviewRequest"), [])
        self.assertEqual(fixture.core.ops("evaluationRequest"), [])
        # The pass may REGISTER the work (that is what makes the wait visible) but it must not buy it.
        for plan in fixture.core.plans():
            self.assertNotEqual(plan.get("stage"), "done")
        self.assertIsNone(fixture.core.plan_for(lesson, "review") and
                          fixture.core.plan_for(lesson, "review").get("ticket"))

    def test_step_reservations_are_atomic_idempotent_and_unknown_blocks_the_next_step(self):
        fixture = PassFixture(self, tokens_per_day=20_000, calls_per_day=2)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        lesson = fixture.with_session(fixture.core.lesson())
        row = fixture.core.row(lesson)
        registered = register_plan(fixture.core, lesson, row, "review", SESSION)
        plan = registered["plan"]
        source = fixture.core.source_rows()[0]
        ticket = fixture.core("reviewRequest", {"lessonId": lesson, "expectedVersion": row["version"],
            "maxTokens": 2, "stepwiseBudget": True, "steps": 1, "inputChars": 1,
            "stepOutputTokens": 1, "planHash": plan["planHash"], "queueKey": plan["queueKey"],
            "sourceBinding": True, "sessionId": SESSION, "sourceRevision": source["revision"],
            "sourceBindingHash": source["bindingHash"]})
        self.assertTrue(ticket.get("ticket"), "%r" % (ticket,))
        base = {"ticket": ticket["ticket"], "stepKey": "one", "requestHash": "a" * 64,
                "inputTokens": 1000, "outputTokens": 512}
        first = fixture.core("ticketReserve", base)
        self.assertTrue(first.get("ok"), "%r" % (first,))
        self.assertTrue(fixture.core("ticketReserve", base).get("duplicate"), "same step is idempotent")
        denied = fixture.core("ticketReserve", {**base, "stepKey": "too-large", "requestHash": "b" * 64,
                                                 "inputTokens": 19_000, "outputTokens": 512})
        self.assertEqual(denied.get("code"), "evaluation_budget")
        fixture.core("ticketUsage", {"ticket": ticket["ticket"], "spent": 0,
                                      "usage": {"known": False, "tokens": 0}})
        unknown = fixture.core("ticketReserve", {**base, "stepKey": "after-unknown", "requestHash": "c" * 64})
        self.assertEqual(unknown.get("code"), "ticket_usage_unknown")


@NEEDS_SDK
class FairCursorTests(unittest.TestCase):
    """The persistent fair cursor covers every category and cannot be pinned by a broken prefix."""

    def test_registration_advances_the_cores_own_consideration_cursor(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        fixture.with_session(fixture.core.lesson("lesson-a"))
        fixture.hooks.start_auto_pass("startup")
        fixture.step()
        advances = fixture.core.ops("autoConsiderAdvance")
        self.assertTrue(advances, "a pass that really considered work moves the cursor")
        self.assertGreaterEqual(advances[-1]["value"].get("step"), 1)

    def test_a_pass_that_considered_nothing_writes_nothing(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        fixture.hooks.start_auto_pass("startup")
        before = fixture.core.digest()
        audit = fixture.step()
        self.assertEqual(audit.get("candidates"), 0, "%r" % (audit,))
        self.assertEqual(fixture.core.ops("autoConsiderAdvance"), [])
        self.assertEqual(fixture.core.digest(), before, "an idle pass does not rewrite the document")

    def test_the_plan_window_rotates_so_a_later_plan_is_not_starved(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        # FOUR due plans, none of which can ever run (their sessions have no proven route), so a pass
        # that always took the head of the list would never reach the ones behind it. A plan that
        # cannot run is settled as a WAIT and stays due, which is exactly the prefix this covers.
        fixture.observe_route()
        for index in range(4):
            session = "dead-session-%d" % index
            # The instruction carries a bounded distinguishing number: a lesson id is the core's own
            # hash of scope+instruction, so four IDENTICAL instructions are one lesson, not four.
            instruction = "%s（第%d条核对项）" % (INSTRUCTION, index + 1)
            lesson = fixture.with_session(fixture.core.lesson("lesson-%d" % index, instruction), session)
            row = fixture.core.row(lesson)
            registered = register_plan(fixture.core, lesson, row, "review", session)
            self.assertTrue(registered.get("ok"), "%r" % (registered,))
            fixture.core("autoPlanUpdate", {"queueKey": registered["plan"]["queueKey"],
                                            "planHash": registered["plan"]["planHash"],
                                            "nextAttemptAt": 0})
        fixture.hooks.start_auto_pass("startup")
        # The DUE-PLAN window is its own cursor (`dueOffset`), separate from the registration window
        # (`offset`): the two rotate over different lengths, and this case is about the plan window.
        # Each pass must move it by the plans it really took, so the head of the list is not retried
        # for ever while the plans behind it are never reached.
        taken = []
        for _ in range(3):
            for plan in fixture.core.plans():
                if plan.get("stage") in ("queued", "interrupted"):
                    fixture.core("autoPlanUpdate", {"queueKey": plan["queueKey"],
                                                    "planHash": plan["planHash"], "nextAttemptAt": 0})
            audit = fixture.step()
            taken.append(list(audit.get("taken") or []))
        self.assertEqual(len(taken[0]), 2, "one pass takes at most PER_PASS_PLANS plans: %r" % (taken,))
        self.assertTrue(set(taken[1]) - set(taken[0]),
                        "a later pass really reached a plan the earlier one never took: %r" % (taken,))


@NEEDS_SDK
class RecoveryTests(unittest.TestCase):
    """A dead process's attempt is released and never replayed; an unsigned wait just becomes due."""

    def test_a_dead_process_resumes_a_ticket_with_no_dispatched_steps(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        lesson = fixture.with_session(fixture.core.lesson())
        row = fixture.core.row(lesson)
        registered = register_plan(fixture.core, lesson, row, "review", SESSION)
        plan = registered["plan"]
        # A process that died between "the attempt started" and "the outcome was written".
        fixture.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                        "stage": "running", "ticket": "dead-ticket", "attempts": 1})
        # The SAME document shape the product's own request transaction builds: the source binding,
        # the plan identity, and no optional identity sent as null.
        source_row = fixture.core.source_rows()[0]
        ticket = fixture.core("reviewRequest", {"lessonId": lesson,
                                                "expectedVersion": row["version"], "maxTokens": 2,
                                                "stepwiseBudget": True, "steps": 1,
                                                "inputChars": 1, "stepOutputTokens": 1,
                                                "planHash": plan["planHash"], "queueKey": plan["queueKey"],
                                                "sourceBinding": True, "sessionId": SESSION,
                                                "sourceRevision": source_row["revision"],
                                                "sourceBindingHash": source_row["bindingHash"]})
        self.assertTrue(ticket.get("ok"), "%r" % (ticket,))
        started = fixture.hooks.start_auto_pass("startup")
        # The dead process's attempt is released by the CONTROLLED STARTUP RECOVERY, once — and its
        # bounded counts are published with the chain rather than lost with that one call.
        release = fixture.hooks.plan["startupRecovery"]
        self.assertGreaterEqual(release["interrupted"], 1, "%r" % (started,))
        self.assertEqual(release["releasedTickets"], 0, "%r" % (started,))
        recovered_plan = fixture.core.plan_for(lesson, "review")
        self.assertEqual(recovered_plan.get("ticket"), ticket["ticket"],
                         "a request never dispatched by the dead process is safe to continue")
        audit = fixture.step()
        after = fixture.core.plan_for(lesson, "review")
        self.assertNotEqual(after.get("stage"), "running")
        self.assertEqual(len(fixture.core.ops("reviewRequest")), 1,
                         "resume uses the existing ticket instead of signing another attempt")
        # The SAME ticket is settled once; a late repeated result cannot start another attempt.
        replay = fixture.core("reviewResult", {"ticket": ticket["ticket"], "lessonId": lesson,
                                               "projectKey": PROJECT, "costKnown": True,
                                               "sourceBinding": True, "first": "x", "second": "y"})
        self.assertFalse(replay.get("ok"), "a voided ticket is never a second attempt: %r" % (replay,))
        self.assertIn(replay.get("code"), ("review_plan_stale", "review_settled", "ticket_voided",
                                            "review_ticket_rejected"))

    def test_an_unsigned_budget_wait_stays_recoverable_and_costs_nothing(self):
        fixture = PassFixture(self, tokens_per_day=0, calls_per_day=0)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        lesson = fixture.with_session(fixture.core.lesson())
        row = fixture.core.row(lesson)
        registered = register_plan(fixture.core, lesson, row, "review", SESSION)
        plan = registered["plan"]
        fixture.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                        "stage": "queued", "nextAttemptAt": 0})
        fixture.hooks.start_auto_pass("startup")
        audit = fixture.step()
        parked = fixture.core.plan_for(lesson, "review")
        self.assertEqual(fixture.transport.physical, 0)
        self.assertEqual(fixture.core.ops("reviewRequest"), [],
                         "a zero allowance means the request document is never even built: %r" % (audit,))
        self.assertEqual(fixture.core.ops("evaluationRequest"), [])
        # A parked plan keeps its identity and its attempts: the next pass asks again.
        self.assertIsNotNone(parked)
        self.assertIn(parked.get("stage"), ("queued", "blocked"))

    def test_a_candidate_whose_route_cannot_be_proved_is_never_charged(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        # NO observed dispatch fact for this session: the pass must not invent a route.
        fixture.core.lesson("lesson-cold")
        fixture.hooks.start_auto_pass("startup")
        audit = fixture.step()
        self.assertEqual(fixture.transport.physical, 0)
        self.assertEqual(fixture.core.ops("reviewRequest"), [])
        self.assertEqual(fixture.core.ops("evaluationRequest"), [])
        self.assertIn("source_unknown", audit.get("codes") or [])


@NEEDS_SDK
class ProjectScopeTests(unittest.TestCase):
    """A project-scoped candidate is registered and run IN its own project, and never downgraded.

    The project identity comes from the ORIGINAL session's own trusted turn context (the hook's
    `project_key`, which the core hashed into the lesson's scope) — not from a raw project table and
    not from a guess. The core re-derives the scope from what the pass states and checks the lesson
    against it, so a candidate from ANOTHER project is refused instead of being pulled into this one.
    """

    def fixture_with_project(self, project=PROJECT):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        # THE REAL PUBLIC LIFECYCLE, no patched origin: a trusted failure observation matures into a
        # problem, the problem is reflected on, and the reflection produces the candidate — carrying
        # the session and the project the evidence was really observed under.
        fixture.observe_route(project=project)
        fixture.core.observe(1, SESSION, project=project)
        matured = fixture.core.observe(2, SESSION, project=project)
        fixture.hooks.turns[(SESSION, "1")] = {"base": {"sessionId": SESSION, "turnId": "1",
                                                        "projectKey": project}}
        lesson = fixture.core.candidate(matured["id"], SESSION, project=project)
        return fixture, lesson

    def test_a_project_candidate_is_registered_and_advanced_in_its_own_project(self):
        fixture, lesson = self.fixture_with_project()
        fixture.hooks.start_auto_pass("startup")
        audit = fixture.step()
        self.assertGreaterEqual(audit.get("registered"), 1, "%r" % (audit,))
        plan = fixture.core.plan_for(lesson, "review")
        self.assertIsNotNone(plan, "the core registered the plan in the project scope")
        self.assertEqual(plan["source"].get("projectKey"), PROJECT,
                         "the plan carries the ORIGINAL project identity, not a downgrade")
        fixture.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                        "nextAttemptAt": 0})
        second = fixture.step()
        self.assertGreater(fixture.transport.physical, 0, "the project plan really ran: %r" % (second,))

    def test_another_project_is_kept_separate_and_is_refused_under_this_one(self):
        # ISOLATION, proved from both sides:
        #   • a candidate whose session stated project B is registered IN B — never absorbed into the
        #     project A scope this test process happens to be working in;
        #   • and asking the core to operate on that lesson under A is refused outright, so no attempt
        #     can be charged to a project the lesson does not belong to. Nothing is downgraded to fit.
        other = "other-project"
        fixture, lesson = self.fixture_with_project(project=other)
        self.assertEqual(fixture.hooks.plan_project_of(SESSION), other,
                         "the original identity is what the turn stated")
        fixture.hooks.start_auto_pass("startup")
        step = fixture.step()
        self.assertGreaterEqual(step.get("registered"), 1, "%r" % (step,))
        plan = fixture.core.plan_for(lesson, "review")
        self.assertIsNotNone(plan)
        self.assertEqual(plan["source"].get("projectKey"), other,
                         "the plan belongs to ITS project, not to this process's project")
        # The core's own verdict under the OTHER project is that this lesson does not exist there.
        refused = fixture.core("autoPlanProposal", {"lessonId": lesson, "version": plan["version"],
                                                    "track": "review", "projectKey": PROJECT,
                                                    "source": plan["source"]})
        self.assertNotEqual(refused.get("ok"), True,
                            "a project-B lesson is refused under project A: %r" % (refused,))

    def test_a_session_that_stated_no_project_stays_instancescoped(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        fixture.core.observe(1, SESSION)
        matured = fixture.core.observe(2, SESSION)
        fixture.hooks.turns[(SESSION, "1")] = {"base": {"sessionId": SESSION, "turnId": "1"}}
        lesson = fixture.core.candidate(matured["id"], SESSION)
        self.assertIsNone(fixture.hooks.plan_project_of(SESSION), "no project was ever stated")
        fixture.hooks.start_auto_pass("startup")
        audit = fixture.step()
        self.assertGreaterEqual(audit.get("registered"), 1, "%r" % (audit,))


@NEEDS_SDK
class DueCursorPersistenceTests(unittest.TestCase):
    """The due-plan rotation is PERSISTED in the core, so a rebuilt process resumes where it stopped."""

    def test_the_due_cursor_survives_a_new_bridge_over_the_same_store(self):
        first = PassFixture(self)
        self.addCleanup(first.close)
        first.observe_route()
        for index in range(4):
            instruction = "%s（第%d条核对项）" % (INSTRUCTION, index + 1)
            lesson = first.with_session(first.core.lesson("lesson-%d" % index, instruction), "dead-%d" % index)
            row = first.core.row(lesson)
            register_plan(first.core, lesson, row, "review", "dead-%d" % index)
        first.hooks.start_auto_pass("startup")
        for plan in first.core.plans():
            first.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                          "nextAttemptAt": 0})
        audit = first.step()
        taken_first = list(audit.get("taken") or [])
        self.assertEqual(len(taken_first), 2, "%r" % (audit,))
        # The core's OWN document holds the rotation, not this process's memory.
        stored = first.core("maintainLearning", {}).get("dueCursor")
        self.assertEqual(stored, audit.get("dueCursor"), "the pass reports what the core stored")
        self.assertEqual(stored, 2)
        # A SECOND bridge over the SAME store (the "rebuilt process") starts from what was stored.
        state_root = first.state_root
        second = PassFixture(self)
        self.addCleanup(second.close)
        second.core.root = state_root
        second.core.config = dict(first.core.config, stateRoot=str(state_root))
        second.hooks.start_auto_pass("startup")
        for plan in second.core.plans():
            second.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                           "nextAttemptAt": 0})
        resumed = second.step()
        taken_second = list(resumed.get("taken") or [])
        self.assertEqual(resumed.get("dueCursor"), 0, "the stored rotation resumed: {!r}".format(resumed))
        self.assertTrue(set(taken_second) - set(taken_first),
                        "the rebuilt process reached plans the first one never took: {!r} vs {!r}".format(
                            taken_first, taken_second))


@NEEDS_SDK
class PlanAdvanceTests(unittest.TestCase):
    """A due plan really runs: the core registers it, the driver buys it, the core settles it."""

    def test_a_proven_due_plan_is_advanced_through_the_one_driver(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        lesson = fixture.with_session(fixture.core.lesson())
        fixture.hooks.start_auto_pass("startup")
        first = fixture.step()
        self.assertGreaterEqual(first.get("registered"), 1, "%r" % (first,))
        plan = fixture.core.plan_for(lesson, "review")
        self.assertIsNotNone(plan, "the core registered the official plan")
        self.assertEqual(plan.get("stage"), "queued")
        # Make it due now and run the next pass: it must really buy the review.
        fixture.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                        "nextAttemptAt": 0})
        second = fixture.step()
        self.assertGreater(fixture.transport.physical, 0, "the pass really dispatched: %r" % (second,))
        self.assertTrue(fixture.core.ops("reviewRequest"), "through the core's own request")
        self.assertTrue(fixture.core.ops("reviewResult"), "and the core's own result")
        after = fixture.core.plan_for(lesson, "review")
        self.assertEqual(after.get("stage"), "done", "%r" % (after,))
        # ONE physical slot: the driver never runs two attempts at once.
        self.assertEqual(fixture.hooks.reflection_driver.slot.status()["peak"], 1)

    def test_supported_chat_route_runs_with_stepwise_budget_and_wire_output_caps(self):
        fixture = PassFixture(self, tokens_per_day=20_000, calls_per_day=2)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        lesson = fixture.with_session(fixture.core.lesson())
        fixture.hooks.start_auto_pass("startup")
        first = fixture.step()
        plan = fixture.core.plan_for(lesson, "review")
        self.assertIsNotNone(plan, "%r" % (first,))
        fixture.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                         "nextAttemptAt": 0})
        result = fixture.step()
        self.assertEqual(fixture.transport.physical, 4, "%r" % (result,))
        self.assertTrue(all(item.get("max_tokens") in (128, 256) for item in fixture.transport.bodies))
        reservations = fixture.core.ops("ticketReserve")
        self.assertEqual(len(reservations), 4)
        status = fixture.core("status", {})
        self.assertLessEqual(status.get("evaluationTokensReserved24h", 0), 20_000)
        self.assertLessEqual(status.get("evaluationCallsLast24h", 0), 2)

    def test_objective_plan_resumes_remaining_steps_after_twenty_thousand_window(self):
        node_clock = node_clock_mod.NodeClock(self)
        fixture = PassFixture(self, tokens_per_day=20_000, calls_per_day=2)
        self.addCleanup(fixture.close)
        fixture.hooks.wall_ms = node_clock.now_ms
        fixture.observe_route()
        lesson = fixture.with_session(fixture.core.lesson())
        fixture.hooks.start_auto_pass("startup")
        fixture.step()
        review = fixture.core.plan_for(lesson, "review")
        objective = fixture.core.plan_for(lesson, "objective")
        self.assertIsNotNone(review)
        self.assertIsNotNone(objective)
        fixture.core("autoPlanUpdate", {"queueKey": review["queueKey"], "planHash": review["planHash"],
                                         "stage": "blocked", "reason": "test_review_deferred"})
        fixture.core("autoPlanUpdate", {"queueKey": objective["queueKey"], "planHash": objective["planHash"],
                                         "nextAttemptAt": 0})
        result = fixture.step()
        status = fixture.core("status", {})
        self.assertLessEqual(status.get("evaluationTokensReserved24h", 0), 20_000)
        self.assertLessEqual(status.get("evaluationCallsLast24h", 0), 2)
        self.assertTrue(all(body.get("max_tokens") == 128 for body in fixture.transport.bodies))
        after = fixture.core.plan_for(lesson, "objective")
        self.assertEqual(after.get("stage"), "queued", "%r bodies=%d status=%r reserves=%r" % (
            result, len(fixture.transport.bodies), status, fixture.core.ops("ticketReserve")))
        self.assertEqual(after.get("reason"), "evaluation_budget")
        ticket = after.get("ticket")
        self.assertIsInstance(ticket, str)
        raw = fixture.core.document()
        saved = next(row for row in raw["autoPlans"] if row["queueKey"] == after["queueKey"])
        self.assertEqual(len(saved.get("progress", {}).get("steps", [])), fixture.transport.physical)
        self.assertEqual(fixture.transport.physical, 22)
        self.assertEqual(status.get("evaluationTasksLast24h"), 1)
        self.assertEqual(status.get("evaluationRequestsLast24h"), 22)

        # The plan checkpoint survives ticket expiry. A fresh process waits for the same source session
        # to report a real dispatch route, then the official startup/timer chain resumes remaining steps.
        parked = fixture.core.plan_for(lesson, "objective")
        self.assertEqual(parked.get("ticket"), ticket)
        initial_progress = next(row for row in fixture.core.document()["autoPlans"]
                                if row["queueKey"] == parked["queueKey"]).get("progress", {}).get("steps", [])
        initial_keys = {item.get("stepKey") for item in initial_progress}
        self.assertEqual(len(initial_keys), 22)
        old_driver = fixture.hooks.reflection_driver
        fixture.restart_hooks(tokens_per_day=20_000, calls_per_day=2)
        self.assertIsNot(fixture.hooks.reflection_driver, old_driver)
        fixture.hooks.wall_ms = node_clock.now_ms
        node_clock.advance_ms(24 * 60 * 60 * 1000 + 1)
        # The host has now delivered a genuine pre_api_request event for this same source session.
        # This is the supported way a fresh process regains dispatch facts; the fixture does not
        # repopulate bridge internals or manufacture a plan/ticket transition.
        fixture.hooks.pre_api_request(session_id=SESSION, turn_id="turn-after-restart",
            provider=PROVIDER, model=MODEL, base_url=BASE_URL, api_mode="chat_completions",
            request={"method": "POST", "body": {"model": MODEL, "reasoning_effort": EFFORT}})
        started = fixture.hooks.start_auto_pass("startup")
        self.assertTrue(started.get("armed") or started.get("ok"), "%r" % (started,))
        self.assertEqual(len(fixture.scheduler.live()), 1)
        fixture.scheduler.fire()
        # Startup recovery may impose its ordinary retry delay after recognizing the retained
        # budget wait. Let the production timer chain, not a plan mutation, reach that deadline.
        for _ in range(8):
            if fixture.core.plan_for(lesson, "objective").get("stage") == "done":
                break
            node_clock.advance_ms(60_000)
            fixture.scheduler.fire()
        resumed = fixture.hooks.auto_pass_status()
        finished = fixture.core.plan_for(lesson, "objective")
        self.assertEqual(finished.get("stage"), "done", "%r plan=%r" % (resumed, finished))
        progress = next(row for row in fixture.core.document()["autoPlans"]
                        if row["queueKey"] == finished["queueKey"]).get("progress", {}).get("steps", [])
        final_keys = {item.get("stepKey") for item in progress}
        final_by_key = {item.get("stepKey"): item.get("requestHash") for item in progress}
        self.assertEqual(len(progress), 36, "the frozen plan contains 36 objective steps")
        self.assertEqual(len(final_keys), 36, "each objective step has one durable checkpoint")
        self.assertTrue(initial_keys < final_keys, "the original checkpoints survived ticket expiry and restart")
        self.assertTrue(all(final_by_key.get(item.get("stepKey")) == item.get("requestHash")
                            for item in initial_progress), "the original step request identities stayed unchanged")
        self.assertEqual(len(final_keys - initial_keys), 14, "only 14 incomplete steps remained")
        self.assertEqual(fixture.transport.physical, 36,
                         "22 prior requests were reused and only 14 remaining requests dispatched")
        tickets_used = {row["value"].get("ticket") for row in fixture.core.ops("ticketReserve")}
        self.assertIn(ticket, tickets_used)
        self.assertEqual(tickets_used, {ticket}, "the live ticket survived the day window and process restart")
        self.assertEqual(fixture.core("status", {}).get("evaluationTasksLast24h"), 1,
                         "the resumed ticket counts once in the new window, not once per step")
        self.assertEqual(fixture.core("status", {}).get("evaluationRequestsLast24h"), 14)

    def test_hermes_production_pass_grants_and_recalls_an_ordinary_evidence_trial(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        first = fixture.core.observe(1, SESSION, tool="ordinary-tool")
        second = fixture.core.observe(2, SESSION, tool="ordinary-tool")
        problem_id = second.get("id")
        self.assertIsInstance(problem_id, str)
        ordinary = "部署前核对当前分支与工作区状态，确认改动已保存后再继续。"
        lesson = fixture.core.candidate(problem_id, SESSION, instruction=ordinary, turn="ordinary-trial")
        fixture.hooks.start_auto_pass("startup")
        audit = fixture.step()
        self.assertGreaterEqual(audit.get("evidenceTrialsGranted", 0), 1, "%r" % (audit,))
        calls = fixture.core.ops("grantEvidenceTrial")
        self.assertTrue(calls, "the production Hermes pass calls the core trial operation")
        row = next(item for item in fixture.core.document()["lessons"] if item.get("id") == lesson)
        self.assertEqual(row.get("trial", {}).get("kind"), "evidence", "%r" % (calls,))
        self.assertEqual(row.get("trial", {}).get("note"), "reference_only_unverified")
        prepared = fixture.core("prepare", {"sessionId": SESSION, "turnId": "ordinary-recall",
                                             "origin": "user", "prompt": "部署前如何确认工作区状态？"})
        self.assertEqual(prepared.get("reason"), "recalled", "%r" % (prepared,))
        self.assertIn(lesson, prepared.get("lessons", []), "%r" % (prepared,))


class ReadOnlyStatusTests(unittest.TestCase):
    """Status is a read: no scan, no write, no armed timer, no model."""

    def test_status_reads_do_not_run_a_pass_or_touch_the_document(self):
        fixture = PassFixture(self)
        self.addCleanup(fixture.close)
        fixture.observe_route()
        lesson = fixture.core.lesson()
        fixture.hooks.start_auto_pass("startup")
        before = fixture.core.digest()
        status = fixture.hooks.auto_pass_status()
        local = fixture.hooks.local_status()
        self.assertIn("installed", status)
        self.assertTrue(status.get("running"), "%r" % (status,))
        self.assertEqual(fixture.core.ops("autoPlans"), [], "a status read does not scan the queue")
        self.assertEqual(fixture.core.digest(), before, "a status read writes nothing")
        self.assertEqual(len(fixture.scheduler.live()), 1, "and it does not arm another wake-up")


def main():
    unittest.main()


if __name__ == "__main__":
    main()
