"""Stage 4c — the Hermes INTERPRETER on the ONE driver: review and objective multi-step runs.

Everything here is offline. The Node core is the shipped `src/cli.mjs` in a temporary state root, the
provider is a fake transport that counts PHYSICAL attempts, and no credential, profile or daily store
is read. What is NOT faked is the part under test: the real `adapters/hermes/driver.py`, the real
`AsyncOpenAI` from the committed SDK generation, the real asyncio Task / slot / cleanup boundary, and
the real core transactions that sign, continue and settle a ticket.

The division of labour these cases ENCODE is the contract, not a convenience:

  • Python executes and reports FACTS — raw answers, the raw blind judge verdicts, the real
    `finish_reason` truncation, the real per-step measurements. It never decides a structured
    criterion, never sends `structuredPassed`, and never says `allowed`/`verified`.
  • The Node core owns the formal interpretation: the frozen case, the criteria, the label swap, the
    structured guard and every promotion. A review whose verdicts do not formally prove the criteria
    stays `inconclusive` even when the executor is happy.

Known边界 of this layer (deliberately NOT claimed here): it is a driver-layer harness — `Hooks` is a
stand-in and the real plugin-manager registration, ContextVar profile binding and Host process
lifecycle belong to the native acceptance layer.
"""
import asyncio
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
    """Put the CURRENT committed Hermes dependency generation on the import path."""
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

driver = load("mse_learning_driver_4c_test", ROOT / "adapters/hermes/driver.py")

PROVIDER = "deepseek-official"
MODEL = "deepseek-flash"
EFFORT = "max"
BASE_URL = "https://source-a.invalid/v1"
SESSION = "auto-session-1"
PROJECT = "probe-project"
# In-domain for the registered pack: a lifecycle SUBJECT and a lifecycle MECHANISM, and nothing the
# pack's own predicate forbids.
INSTRUCTION = "并发提交前先核对请求代次与票据状态，再提交写入并核对结算记录，避免重复提交。"
# The pack's own fixed answer for its first case — the CANDIDATE arm's answer. The baseline gets a
# deliberately DIFFERENT answer, so the two presentations are distinguishable and the swap is real.
ARM_TEXT = "DISCARD —— 当前活动代次为 9，到达结果的代次为 7，落后于活动代次，按约定丢弃。"
BASELINE_TEXT = "APPLY —— 直接作答：该结果可以应用，未做代次核对。"
JUDGE_MARK = "你是独立的答案评审"


def verdict(criteria_ids, met="both", winner="tie"):
    """A judge reply in the core's FORMAL schema (`criteria`, not the adapter's older spelling)."""
    return json.dumps({"winner": winner, "reason": "两侧按同一规则作答，未发现差异",
                       "criteria": [{"id": name, "met": met} for name in criteria_ids]},
                      ensure_ascii=False)


def node_cli():
    node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
    cli = ROOT / "src" / "cli.mjs"
    if not node or not cli.is_file():
        raise unittest.SkipTest("node or the shipped CLI is unavailable")
    return node, cli


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
        self.operations.append({"op": op, "value": value, "ok": answer.get("ok"),
                                "code": answer.get("code"), "skipped": answer.get("skipped"),
                                "ticket": answer.get("ticket")})
        # `on_answer` lets a fixture read what the CORE itself published (the frozen case's criteria,
        # for instance) instead of keeping a second copy of the question bank.
        if self.on_answer is not None:
            self.on_answer(op, value, answer)
        return answer

    def ops(self, name):
        return [row for row in self.operations if row["op"] == name]

    # ── the persisted facts, read from the core's own document (never by writing to it) ──────────
    def document(self):
        return json.loads((self.root / "lessons-v1.json").read_text())

    def spend_row(self, ticket):
        for row in self.document().get("spends", []):
            if row.get("ticket") == ticket:
                return row
        return None

    def review_row(self, lesson_id):
        for lesson in self.document().get("lessons", []):
            if lesson.get("id") == lesson_id:
                return lesson.get("review")
        return None

    def publish(self, session=SESSION, **overrides):
        value = {"sessionId": session, "projectKey": PROJECT, "provider": PROVIDER, "model": MODEL,
                 "apiMode": "chat_completions", "baseUrl": BASE_URL, "reasoningState": "explicit",
                 "reasoningValue": EFFORT, "driver": "async_openai_chat"}
        value.update(overrides)
        return self("sourcePublish", value)

    def lesson(self, event_id="lesson-4c", instruction=INSTRUCTION):
        """One in-domain method candidate, registered on the trusted host path."""
        answer = self("record", {"eventId": event_id, "projectKey": PROJECT, "kind": "method",
                                 "source": "host_proposal", "instruction": instruction})
        if answer.get("ok") is not True:
            raise AssertionError("the fixture could not record a method: %r" % (answer,))
        return answer["id"]

    def row(self, lesson_id):
        answer = self("autoCandidateFacts", {"lessonId": lesson_id})
        if answer.get("ok") is not True or not isinstance(answer.get("row"), dict):
            raise AssertionError("the fixture could not read the candidate row: %r" % (answer,))
        return answer["row"]

    @staticmethod
    def session_hash(session):
        import hashlib
        return hashlib.sha256(str(session).encode()).hexdigest()

    def source_of(self, session=SESSION):
        """The source row this session really published, as the trusted read reports it."""
        answer = self("sourceStatus", {"limit": 32})
        for row in answer.get("rows", []):
            if row.get("sessionHash") == self.session_hash(session):
                return row
        raise AssertionError("the fixture lost its published source: %r" % (answer,))

    def plan_source(self, session=SESSION):
        return {"kind": "manual_backfill", "sessionId": session, "projectKey": PROJECT,
                "route": {"provider": PROVIDER, "model": MODEL, "reasoningEffort": EFFORT}}

    def register(self, lesson_id, track, session=SESSION):
        """Register the OFFICIAL plan for one track, through the core's own registration."""
        row = self.row(lesson_id)
        proposal = self("autoPlanProposal", {"lessonId": lesson_id, "version": row["version"],
                                             "environment": row["environment"], "projectKey": PROJECT,
                                             "track": track, "source": self.plan_source(session)})
        if proposal.get("ok") is not True:
            raise AssertionError("the fixture could not propose a plan: %r" % (proposal,))
        registered = self("autoPlanRegister", {"lessonId": lesson_id, "version": proposal["version"],
                                               "environment": proposal["environment"], "track": track,
                                               "source": self.plan_source(session), "suite": proposal["suite"],
                                               "criteria": proposal["criteria"], "caseId": proposal["caseId"]})
        if registered.get("ok") is not True:
            raise AssertionError("the fixture could not register a plan: %r" % (registered,))
        plan = dict(registered.get("plan") or {})
        plan.setdefault("queueKey", proposal["queueKey"])
        plan.setdefault("planHash", proposal["planHash"])
        plan.setdefault("version", proposal["version"])
        # The plan's own NORMALISED environment is what the core hashes into the queue key; it is not a
        # raw id, and it is passed back to the core as the core itself normalised it.
        plan.setdefault("environment", proposal["environment"])
        plan["criteria"] = proposal["criteria"]
        plan["caseId"] = proposal["caseId"]
        plan["instruction"] = proposal.get("instruction")
        plan["packId"] = proposal["suite"]["packId"]
        plan["packVersion"] = proposal["suite"]["version"]
        plan["scenarioHash"] = proposal["scenarioHash"]
        plan["criteriaHash"] = proposal["criteriaHash"]
        plan["cases"] = [{"caseId": item["caseId"], "family": item["family"], "split": item["split"]}
                         for item in proposal["cases"]]
        plan["caseCriteria"] = {item["caseId"]: item.get("criteria") for item in proposal["cases"]}
        plan["proposal"] = proposal
        return {"proposal": proposal, "plan": plan, "registered": registered}

    def running(self, plan):
        return self("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                       "stage": "running", "attempts": 1})


def _send(request, body_handler):
    import httpx
    return httpx.Response(200, json=body_handler(body_of(request)))


def body_of(request):
    try:
        return json.loads(request.content.decode("utf-8")) if request.content else {}
    except Exception:  # noqa: BLE001
        return {}


class Transport:
    """An in-memory httpx transport that counts PHYSICAL attempts and never opens a socket.

    `before(index, body)` runs INSIDE the handler, before the response is produced, for the index-th
    physical call (1-based). That is where a permission change is injected: it lands while the run is
    really in flight, so the step AFTER it is the one that has to refuse.
    """

    def __init__(self, test, answers, before=None, hold=(), cancel_on_hold=None, hold_seconds=0.6):
        import httpx

        class InMemory(httpx.AsyncBaseTransport):
            def __init__(self):
                self.physical = 0
                self.closed = 0
                self.requests = []
                self.entered = []

            async def handle_async_request(self, request):
                self.physical += 1
                body = body_of(request)
                self.requests.append(body)
                if self.physical in hold:
                    # HELD IN FLIGHT: the request really goes on the wire, it ignores the caller's
                    # cancellation for a bounded moment, and then it FAILS WITHOUT ANSWERING. That is
                    # the only shape under which "dispatched and never measured" can be observed.
                    self.entered.append(self.physical)
                    deadline = time.monotonic() + hold_seconds
                    while time.monotonic() < deadline:
                        try:
                            await asyncio.shield(asyncio.sleep(0.02))
                        except asyncio.CancelledError:
                            pass
                    if cancel_on_hold is not None:
                        cancel_on_hold()
                    raise httpx.ReadError("held request never answered")
                if before is not None:
                    before(self.physical, body)
                answer = answers(body) if callable(answers) else answers
                return httpx.Response(200, json=answer)

            async def aclose(self):
                self.closed += 1

        self.raw = InMemory()
        self.closed_transport = 0

    @property
    def physical(self):
        return self.raw.physical


class Fixture:
    """One driver wired to a real core, a fake transport and a synthetic resolver."""

    def __init__(self, test, answers=None, *, before=None, wrap=False, hold=(), cancel_on_hold=None):
        self.test = test
        self.state_root = Path(tempfile.mkdtemp(prefix="mse4c-driver-"))
        test.addCleanup(shutil.rmtree, self.state_root, True)
        self.core = Core(self.state_root)
        self.answers = answers
        # A wrapper is handed the per-call answer AFTER it was produced (the physical index is known),
        # which is where a fixture reproduces "this particular frame had no readable usage".
        self.transport = Transport(test, self._answer if wrap else answers, before=before, hold=hold,
                                   cancel_on_hold=cancel_on_hold)
        self.hook = {"provider": PROVIDER, "model": MODEL, "base_url": BASE_URL,
                     "api_mode": "chat_completions",
                     "request": {"method": "POST", "body": {"model": MODEL, "reasoning_effort": EFFORT}}}
        self.resolver_runtime = {"provider": PROVIDER, "model": MODEL, "api_mode": "chat_completions",
                                 "base_url": BASE_URL, "api_key": "synthetic-key"}
        self.clients = []
        self.hooks = types.SimpleNamespace(call=self.core)
        self.driver = driver.ReflectionDriver(self.hooks, resolver=self.resolver,
                                             client_factory=self.client_factory,
                                             allow_direct_client=False)
        self.core.publish()

    def resolver(self, provider, model):
        return dict(self.resolver_runtime)

    def _answer(self, body):
        """The installed answer, wrapped by whatever the case installed through `wrap`."""
        answer = self.answers(body)
        for layer in getattr(self, "layers", []):
            answer = layer(answer, body)
        return answer

    def wrap(self, layer):
        """Install one layer over the answer, called as `layer(answer, body)`."""
        self.layers = getattr(self, "layers", [])
        self.layers.append(layer)

    def client_factory(self, identity, runtime):
        import httpx
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0,
                             http_client=httpx.AsyncClient(transport=self.transport.raw))
        self.clients.append(client)
        return client, identity.model

    @property
    def binding_hash(self):
        return self.core.source_of()["bindingHash"]

    @property
    def physical(self):
        return self.transport.physical

    def job(self, plan, track, lesson_id, cancel=None, **overrides):
        """The job document the bridge hands the ONE driver for an automatic paid run."""
        value = {"kind": track, "route_provider": PROVIDER, "route_model": MODEL, "pre_api": self.hook,
                 "base": {"sessionId": SESSION}, "source_session": SESSION, "problem": {}, "ticket": None,
                 "queueKey": plan["queueKey"], "planHash": plan["planHash"], "lessonId": lesson_id,
                 "version": plan["version"], "projectKey": PROJECT,
                 "environmentId": plan["environment"], "planTrack": track,
                 "source": {"revision": 1, "bindingHash": self.binding_hash},
                 "cancel_event": cancel or threading.Event()}
        if track == "review":
            value["review"] = {"maxTokens": 4000}
        else:
            value["objective"] = {"maxTokens": 12_000, "cursor": 0}
        value.update(overrides)
        return value

    def run(self, job):
        job = dict(job)
        cancel = job.pop("cancel_event", None) or threading.Event()
        return self.driver.run(job, "failed", ("", ""), cancel, self.core)

    def close(self):
        self.driver.close()


class Provider:
    """A provider that answers ARMS with the frozen answer and JUDGE passes with a verdict.

    The judge request is recognised by the CORE's own judge system prompt, so the fixture reads no
    product constant of its own. The verdict is the formal schema and — when `winner="candidate"` —
    it names the label the CORE's own blind ledger put the candidate answer at, which is the only way
    a real judge can express "this answer is better": the labels are the core's, never the executor's.
    Whether that verdict proves anything stays the core's decision.
    """

    def __init__(self, criteria_for_case, *, usage_tokens=150, finish_reason="stop", usage=True,
                 met="both", arm_text=ARM_TEXT, winner="tie", baseline_text=BASELINE_TEXT):
        self.criteria_for_case = criteria_for_case
        self.usage_tokens = usage_tokens
        self.finish_reason = finish_reason
        self.usage = usage
        self.met = met
        self.arm_text = arm_text
        self.baseline_text = baseline_text
        self.winner = winner
        self.arms = 0
        self.judges = 0
        self.case_of_judge = []
        self.calls = 0

    def __call__(self, body):
        self.calls += 1
        messages = body.get("messages") or [{}]
        system = messages[0].get("content", "") if isinstance(messages[0], dict) else ""
        if JUDGE_MARK in system:
            self.judges += 1
            text = messages[1].get("content", "") if len(messages) > 1 else ""
            case_id = self._case_of(text)
            self.case_of_judge.append(case_id)
            ids = [row["id"] for row in (self.criteria_for_case.get(case_id) or [])
                   if row.get("kind") == "structured"]
            winner = "tie"
            if self.winner != "tie":
                # The candidate's own answer is the one whose text this fixture produced, and the
                # ledger's two labels are visible in the prompt — so the "better answer" is expressed
                # in the core's label space rather than guessed.
                winner = self._label_of(text, self.arm_text) or "tie"
            content = verdict(ids, self.met, winner)
        else:
            self.arms += 1
            content = self.baseline_text if self.arms % 2 == 0 else self.arm_text
        answer = {"id": "chatcmpl-4c", "object": "chat.completion", "created": 0, "model": MODEL,
                  "choices": [{"index": 0, "finish_reason": self.finish_reason,
                               "message": {"role": "assistant", "content": content}}]}
        if self.usage:
            answer["usage"] = {"prompt_tokens": 120, "completion_tokens": 30,
                               "total_tokens": self.usage_tokens}
        return answer

    def _case_of(self, judge_text):
        """Which frozen case this judge request is about.

        The review track has exactly one frozen case. The objective track's judge call is not part of
        the walk (the pack scores those answers), so a single case is the whole surface; the fallback
        names the first frozen case rather than inventing criteria.
        """
        names = [name for name, criteria in self.criteria_for_case.items() if criteria]
        if len(names) == 1:
            return names[0]
        for name in names:
            if name in judge_text:
                return name
        return names[0] if names else None

    @staticmethod
    def _label_of(text, answer):
        """Which label the core's own prompt put this answer at, read from its ledger order.

        The prompt labels the two anonymous answers by their position in the core's private ledger
        ("答案 A：…" / "答案 B：…"), so the label of a given answer is
        whichever marker precedes it.
        """
        needle = answer.strip()
        if needle == "":
            return None
        blocks = []
        for name in ("A", "B"):
            start = text.find("答案 %s：" % name)
            if start < 0:
                continue
            body = start + len("答案 A：")
            # The block runs to the OTHER label, or to the end of the prompt.
            other = [text.find("答案 %s：" % other_name, body) for other_name in ("A", "B")]
            ends = [at for at in other if at > body]
            blocks.append((name, text[body:min(ends) if ends else len(text)]))
        for name, block in blocks:
            if needle in block:
                return name
        return None


def criteria_map(plan):
    """Placeholder map: the provider is re-pointed at the CORE's own material once it arrives."""
    return {item["caseId"]: [] for item in plan["proposal"]["cases"]}


def learn_material(fixture, provider):
    """Point the provider at the criteria the CORE publishes for the case it is really running.

    The plan's bounded case REFERENCES carry hashes only; the criteria themselves are the registry's
    and arrive with the execution material. So the fixture reads them from the core's own answer
    instead of keeping a second copy of the question bank.
    """

    def on_answer(op, value, answer):
        if op in ("reviewMaterial", "objectiveMaterial") and answer.get("ok") is True and provider is not None:
            if answer.get("caseId") and answer.get("criteria"):
                provider.criteria_for_case[answer["caseId"]] = answer["criteria"]

    fixture.core.on_answer = on_answer


@NEEDS_SDK
class ReviewMultiStepTests(unittest.TestCase):
    """A review is four paid steps on ONE ticket, and every step re-takes the core's permission."""

    def setUp(self):
        self.fixture = None

    def review(self, track="review", **provider_kwargs):
        holder = {}

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers)
        self.addCleanup(fixture.close)
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, track)
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan), **provider_kwargs)
        learn_material(fixture, holder["provider"])
        return fixture, holder, lesson, plan

    def test_a_review_is_four_steps_on_one_ticket_and_the_core_keeps_the_verdict(self):
        # The judge names the CANDIDATE as the better answer in both passes, which — with the core's
        # own label swap — is the formally aligned pattern: the same ARM wins twice under two
        # different letters. Nothing here decides that; the fixture only answers with a label.
        fixture, holder, lesson, plan = self.review(winner="candidate")
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson))
        provider = holder["provider"]
        self.assertEqual(fixture.physical, 4, "two arms and two judge passes")
        self.assertEqual(provider.arms, 2)
        self.assertEqual(provider.judges, 2)
        # The released reflection ticket path is never used by an automatic paid run.
        self.assertEqual(fixture.core.ops("reflectionRequest"), [])
        submits = fixture.core.ops("reviewResult")
        self.assertEqual(len(submits), 1, "%r" % (result,))
        # ── the power boundary: Python sends the RAW verdicts and never a structured decision ─────
        payload = submits[0]["value"]
        self.assertNotIn("structuredPassed", payload,
                         "the structured reading is the Node core's, never the executor's")
        self.assertIn("first", payload)
        self.assertIn("second", payload)
        self.assertIn("costKnown", payload)
        self.assertEqual(payload["answers"]["candidate"], ARM_TEXT)
        self.assertTrue(payload["swapped"], "the core's own two presentations really were swapped")
        # ── and the core is what decided ──────────────────────────────────────────────────────────
        row = fixture.core.review_row(lesson)
        self.assertIsNotNone(row, "the core recorded the review on the lesson")
        self.assertEqual(row["state"], "reviewed", "%r" % (row,))
        self.assertEqual(row["benefit"], "unproven", "a model review never proves a benefit")
        self.assertEqual(row["agreement"], "aligned")
        # Every step's measurement reached the core BEFORE the next call, through the same merger.
        reports = fixture.core.ops("ticketUsage")
        self.assertEqual(len(reports), 4, "one report per physical step: %r" % (reports,))
        ticket = submits[0]["value"]["ticket"]
        self.assertTrue(all(row["ticket"] == ticket for row in reports), "ONE ticket for the whole run")
        spend = fixture.core.spend_row(ticket)
        self.assertEqual(spend["usage"], {"known": True, "tokens": 4 * 150})
        # The core's own terminal label for a review ticket, whatever the verdict was.
        self.assertEqual(spend["terminal"], "review_settled")

    def test_a_tie_cannot_become_a_review_without_a_declared_reading(self):
        # Two tie verdicts, every structured criterion reported as met by both arms. Under the core's
        # formal guard a tie has NO candidate-favouring pass, so the pass report cannot carry it: the
        # only thing that could turn this into `reviewed` is a DECLARED host reading of the structured
        # criteria — which is exactly the power this side does not have and does not send.
        fixture, holder, lesson, plan = self.review()
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(fixture.physical, 4)
        submits = fixture.core.ops("reviewResult")
        self.assertEqual(len(submits), 1)
        self.assertNotIn("structuredPassed", submits[0]["value"])
        row = fixture.core.review_row(lesson)
        self.assertEqual(row["state"], "inconclusive", "%r" % (row,))
        self.assertEqual(row["benefit"], "none")
        self.assertIn("review_tie", row["reasons"])

    def test_a_verdict_that_does_not_formally_prove_the_criteria_earns_no_trial(self):
        # The judge answers "neither": the comparison happened, the run was measured, and the formal
        # structured guard still refuses to call it a review. Nothing on the Python side may fill that
        # in — which is exactly why `structuredPassed` is not sent.
        fixture, holder, lesson, plan = self.review(winner="candidate", met="neither")
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(fixture.physical, 4)
        self.assertEqual(len(fixture.core.ops("reviewResult")), 1)
        row = fixture.core.review_row(lesson)
        self.assertEqual(row["state"], "inconclusive", "%r" % (row,))
        self.assertEqual(row["benefit"], "none")

    def test_a_pause_before_the_first_step_spends_nothing(self):
        fixture, holder, lesson, plan = self.review()
        fixture.core.running(plan)
        fixture.core("settlementPause", {"paused": True})
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(fixture.physical, 0, "a pause before the first step sends nothing")
        self.assertEqual(fixture.core.ops("reviewResult"), [])
        self.assertEqual(fixture.core.ops("ticketUsage"), [])
        self.assertIsInstance(result.get("wait"), str)

    def test_a_plan_that_went_terminal_refuses_the_next_step(self):
        fixture, holder, lesson, plan = self.review()
        fixture.core.running(plan)
        fixture.core("autoPlanUpdate", {"queueKey": plan["queueKey"], "planHash": plan["planHash"],
                                        "stage": "blocked", "reason": "operator"})
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(fixture.physical, 0)
        self.assertEqual(fixture.core.ops("reviewResult"), [])
        self.assertIsInstance(result.get("wait"), str)


@NEEDS_SDK
class PerStepPermissionTests(unittest.TestCase):
    """The permission read before step 1 is NOT a lease for step 2."""

    def test_a_pause_after_the_first_arm_stops_the_second_arm(self):
        holder = {}

        def before(index, body):
            if index == 1:
                holder["fixture"].core("settlementPause", {"paused": True})

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers, before=before)
        self.addCleanup(fixture.close)
        holder["fixture"] = fixture
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(fixture.physical, 1, "the second arm is never dispatched")
        self.assertEqual(fixture.core.ops("reviewResult"), [], "a stopped run never commits")
        self.assertIsInstance(result.get("wait"), str)
        # the first arm's real measurement is still settled on the ticket, not lost with the run
        reports = fixture.core.ops("ticketUsage")
        self.assertTrue(reports, "the paid step is reported before the run ends")
        spend = fixture.core.spend_row(reports[0]["ticket"])
        # The ticket keeps its RESERVATION as the conservative floor and the real measurement beside
        # it: a stopped run does not refund what it already spent.
        self.assertEqual(spend["reserved"], 4000)
        self.assertEqual(spend["usage"], {"known": True, "tokens": 150})

    def test_a_terminal_plan_after_the_first_arm_stops_the_second(self):
        holder = {}

        def before(index, body):
            if index == 1:
                holder["fixture"].core("autoPlanUpdate",
                                       {"queueKey": holder["plan"]["queueKey"],
                                        "planHash": holder["plan"]["planHash"],
                                        "stage": "blocked", "reason": "operator"})

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers, before=before)
        self.addCleanup(fixture.close)
        holder["fixture"] = fixture
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        holder["plan"] = plan
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(fixture.physical, 1)
        self.assertEqual(fixture.core.ops("reviewResult"), [])
        self.assertIsInstance(result.get("wait"), str)

    def test_the_objective_walk_re_takes_the_permission_before_every_arm(self):
        holder = {}

        def before(index, body):
            if index == 2:
                holder["fixture"].core("settlementPause", {"paused": True})

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers, before=before)
        self.addCleanup(fixture.close)
        holder["fixture"] = fixture
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "objective")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "objective", lesson))
        self.assertEqual(fixture.physical, 2, "the pause lands between the two arms of case 1")
        self.assertEqual(fixture.core.ops("objectiveResult"), [])
        self.assertIsInstance(result.get("wait"), str)


@NEEDS_SDK
class ObjectiveWalkTests(unittest.TestCase):
    """The objective walk follows the CORE's own cursor — the full frozen case list, holdout included."""

    def test_the_walk_covers_every_frozen_case_and_settles_once(self):
        holder = {}

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers)
        self.addCleanup(fixture.close)
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "objective")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        cases = [row["caseId"] for row in plan["proposal"]["cases"]]
        self.assertGreaterEqual(len(cases), 12, "the pack's own case list is what the walk covers")
        self.assertTrue(any(row["split"] == "holdout" for row in plan["proposal"]["cases"]))
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "objective", lesson))
        self.assertEqual(fixture.physical, 2 * len(cases),
                         "one baseline arm and one candidate arm per FROZEN case, in cursor order")
        submits = fixture.core.ops("objectiveResult")
        self.assertEqual(len(submits), 1, "%r" % (result,))
        self.assertEqual(sorted(submits[0]["value"]["answers"].keys()), sorted(cases))
        self.assertIsInstance(submits[0]["value"].get("usage"), dict)
        self.assertTrue(all(isinstance(value, int) for case in submits[0]["value"]["usage"].values()
                            for value in case.values()))


@NEEDS_SDK
class StepFactsTests(unittest.TestCase):
    """Truncation, unknown measurement and overrun are FACTS the core decides on, not local verdicts."""

    def review(self, **provider_kwargs):
        holder = {}

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers)
        self.addCleanup(fixture.close)
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan), **provider_kwargs)
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        return fixture, lesson, plan

    def test_a_length_finish_reason_is_reported_as_truncation(self):
        fixture, lesson, plan = self.review(finish_reason="length")
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(result.get("truncated"), True, "the real finish_reason is the truncation fact")
        self.assertEqual(result.get("costKnown"), True, "the steps were really measured")
        self.assertEqual(len(fixture.core.ops("reviewResult")), 1)
        submits = fixture.core.ops("reviewResult")[0]["value"]
        self.assertEqual(submits["truncated"], True, "the truncation fact reaches the core")
        row = fixture.core.review_row(lesson)
        self.assertNotEqual(row["state"], "reviewed", "a cut-off comparison earns no trial")
        self.assertEqual(row["benefit"], "none")

    def test_an_unreadable_step_latches_unknown_in_the_persisted_fact(self):
        fixture, lesson, plan = self.review(usage=False)
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertIs(result.get("costKnown"), False, "an unreadable step is never a known zero")
        self.assertEqual(result.get("costKnown"), fixture.core.ops("reviewResult")[0]["value"]["costKnown"])
        ticket = fixture.core.ops("reviewResult")[0]["value"]["ticket"]
        spend = fixture.core.spend_row(ticket)
        self.assertEqual(spend["usage"]["known"], False, "the merged, persisted quality is unknown")
        self.assertEqual(spend["usage"]["tokens"], 0)
        row = fixture.core.review_row(lesson)
        self.assertEqual(row["state"], "inconclusive")
        self.assertEqual(row["benefit"], "none")
        self.assertIn("review_cost_unknown", row["reasons"])

    def test_the_unknown_latches_even_when_a_later_step_is_readable(self):
        # The FIRST step has no usage, the rest do: the run as a whole is still unmeasured, and a
        # later readable frame must not un-measure it.
        holder = {}

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers, wrap=True)
        self.addCleanup(fixture.close)
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        provider = Provider(criteria_map(plan))
        holder["provider"] = provider
        learn_material(fixture, provider)

        def first_unreadable(answer, body):
            if provider.calls == 1:
                answer = dict(answer)
                answer.pop("usage", None)
            return answer

        fixture.wrap(first_unreadable)
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson))
        self.assertEqual(fixture.physical, 4)
        self.assertIs(result.get("costKnown"), False)
        ticket = fixture.core.ops("reviewResult")[0]["value"]["ticket"]
        spend = fixture.core.spend_row(ticket)
        self.assertEqual(spend["usage"]["known"], False)
        self.assertGreater(spend["usage"]["tokens"], 0, "the known part is kept beside the unknown")


@NEEDS_SDK
class CancelAccountingTests(unittest.TestCase):
    """A step that really entered the wire and was cancelled is UNKNOWN — never a zero, never known.

    This is the driver-rev1 confirmed defect: the first arm read a known measurement, the second arm's
    request was already dispatched and awaiting when the run was cancelled from another thread. The
    cancellation unwinds straight past the step's own bookkeeping, so the run's persisted cost kept
    saying `{known: true, tokens: <first arm>}` — a measurement for a step the provider may well have
    charged for. The ticket must end `{known: false, tokens: <known part>}`: the known PREFIX is kept,
    the unmeasured step latches unknown, and nothing is credited or replayed.
    """

    def test_a_cancelled_in_flight_step_latches_unknown_and_keeps_the_known_prefix(self):
        release = threading.Event()
        delivered = threading.Event()
        holder = {}
        cancel = threading.Event()

        def before(index, body):
            if index == 1:
                delivered.set()

        def answers(body):
            return holder["provider"](body)

        def cancel_while_held():
            # The cancellation arrives WHILE the request is dispatched, and the request then fails
            # without ever reporting a measurement.
            cancel.set()
            release.set()

        fixture = Fixture(self, answers, before=before, hold=(2,), cancel_on_hold=cancel_while_held)
        self.addCleanup(fixture.close)
        holder["fixture"] = fixture
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson, cancel=cancel))
        self.assertTrue(delivered.is_set(), "the first arm really ran")
        self.assertTrue(release.is_set(), "the held request really was dispatched")
        self.assertEqual(fixture.physical, 2, "the second arm was really dispatched")
        self.assertEqual(fixture.core.ops("reviewResult"), [], "a cancelled review never commits")
        self.assertIsInstance(result.get("wait"), str)
        # ── the confirmed defect: the persisted quality is UNKNOWN, with the known prefix kept ──
        reports = fixture.core.ops("ticketUsage")
        self.assertTrue(reports, "the run reports what it measured")
        ticket = reports[-1]["value"]["ticket"]
        spend = fixture.core.spend_row(ticket)
        self.assertEqual(spend["usage"], {"known": False, "tokens": 150},
                         "an in-flight cancelled step is unknown, and the known prefix is kept: %r" % (spend,))
        self.assertIsNone(spend.get("terminal"), "nothing was settled as a review")

    def test_a_cancel_after_an_answered_step_keeps_only_the_known_prefix(self):
        # The first arm WAS answered and measured; the cancellation lands immediately afterwards, so
        # the next arm is never dispatched. Nothing may be invented for it: no unknown, no zero, and
        # the known prefix is all the run really has.
        holder = {}
        cancel = threading.Event()

        def before(index, body):
            # The first request was ANSWERED (so its measurement is known); the cancellation lands
            # immediately afterwards and the next step must never be dispatched.
            cancel.set()

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers, before=before)
        self.addCleanup(fixture.close)
        holder["fixture"] = fixture
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson, cancel=cancel))
        self.assertEqual(fixture.physical, 1, "the second step is never dispatched")
        self.assertEqual(fixture.core.ops("reviewResult"), [])
        reports = fixture.core.ops("ticketUsage")
        self.assertTrue(reports, "the answered step really was reported")
        spend = fixture.core.spend_row(reports[-1]["value"]["ticket"])
        self.assertEqual(spend["usage"], {"known": True, "tokens": 150},
                         "only the answered step is measured, and it stays KNOWN: %r" % (spend,))
        self.assertIsNone(spend.get("terminal"))
        self.assertEqual(fixture.core.ops("reviewResult"), [])


@NEEDS_SDK
class SlotAndCancelTests(unittest.TestCase):
    """One physical slot for both tracks, and a cancelled attempt never commits."""

    def test_the_slot_is_busy_and_peak_one_while_a_paid_run_holds_it(self):
        observed = {}
        holder = {}

        def before(index, body):
            if index == 1:
                observed["status"] = holder["fixture"].driver.slot.status()

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers, before=before)
        self.addCleanup(fixture.close)
        holder["fixture"] = fixture
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        fixture.run(fixture.job(plan, "review", lesson))
        self.assertTrue(observed["status"]["busy"], "the slot really is held during the paid steps")
        self.assertEqual(observed["status"]["peak"], 1)
        self.assertEqual(fixture.driver.slot.status()["busy"], False, "and released after the cleanup")

    def test_a_cancel_between_steps_never_commits_and_keeps_the_cost(self):
        holder = {}
        cancel = threading.Event()

        def before(index, body):
            if index == 1:
                cancel.set()

        def answers(body):
            return holder["provider"](body)

        fixture = Fixture(self, answers, before=before)
        self.addCleanup(fixture.close)
        holder["fixture"] = fixture
        lesson = fixture.core.lesson()
        registered = fixture.core.register(lesson, "review")
        plan = registered["plan"]
        holder["provider"] = Provider(criteria_map(plan))
        learn_material(fixture, holder["provider"])
        fixture.core.running(plan)
        result = fixture.run(fixture.job(plan, "review", lesson, cancel=cancel))
        self.assertEqual(fixture.core.ops("reviewResult"), [], "a cancelled review never commits")
        self.assertIsInstance(result.get("wait"), str)
        self.assertEqual(fixture.driver.slot.status()["peak"], 1)
        reports = fixture.core.ops("ticketUsage")
        if reports:
            spend = fixture.core.spend_row(reports[0]["ticket"])
            self.assertGreaterEqual(spend["tokens"], 150, "the paid step is still settled")


def main():
    unittest.main()


if __name__ == "__main__":
    main()
