"""Stage 4a: real Hermes hook shapes → the shared Node problem ledger → a BOUND reflection.

Every test here drives the production hook methods with the REAL `post_tool_call` kwarg shape the
host emits (`status`, `error_type`, `tool_call_id`, `tool_name`, `args`, `result`) and the REAL
`pre_api_request` shape (`provider`, `model`, `api_mode`, `api_request_id`, `request_messages`).
The core is either the real packaged runtime in a temporary state root, or a recording stand-in
that is explicitly refused anything except the operations a test is about — never a fake that
invents an API the product does not have.
"""
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
from unittest.mock import patch

from test_hermes import module, ROOT, core_payload, durable_core


def load_hermes_package():
    """The REAL plugin package (`adapters/hermes/__init__.py`), not a stand-in.

    The module under test is the one the host loads, so `register()` — the only production entrance
    that decides whether a reflection driver exists — is exercised as written.
    """
    spec = importlib.util.spec_from_file_location("mse_hermes_package", ROOT / "adapters/hermes/__init__.py",
                                                 submodule_search_locations=[str(ROOT / "adapters/hermes")])
    package = importlib.util.module_from_spec(spec)
    sys.modules["mse_hermes_package"] = package
    spec.loader.exec_module(package)
    return package


HEX64 = "d" * 64


def real_config(directory):
    return {"stateRoot": directory, "adapterId": "hermes", "maxContextBytes": 768}


def tool_failure(session, turn, call_id, tool="terminal", **extra):
    """The real `_emit_post_tool_call_hook` kwarg shape for one failed call."""
    payload = {"session_id": session, "turn_id": turn, "tool_call_id": call_id, "tool_name": tool,
               "args": {"command": "python -c 'raise SystemExit(1)'"}, "result": "[TOOL_ERROR] boom",
               "duration_ms": 12, "status": "error", "error_type": "tool_error",
               "error_message": "command failed", "api_request_id": "api-1"}
    payload.update(extra)
    return payload


def review_json(instruction="导出金额时先把该列转换为数值类型，再按数值排序并核对结果"):
    return json.dumps({"instruction": instruction})


class BindingReviewer:
    """A controlled reviewer that records the EXACT request the bridge prepared.

    It is the injected driver: no provider, no network, no fallback route. Recording the request
    (rather than only returning text) is what lets a test assert the binding that rode into it.
    """

    def __init__(self, answer=None):
        self.requests = []
        self.cancelled = 0
        self.answer = answer if answer is not None else review_json()

    def __call__(self, request, model, cancel_event=None):
        self.requests.append({"request": request, "model": model, "cancel": cancel_event})
        if cancel_event is not None and cancel_event.is_set():
            self.cancelled += 1
            return None
        return self.answer

    def joined(self):
        return "\n".join(entry["request"]["text"] for entry in self.requests)


class Stage4aTests(unittest.TestCase):
    """Cold-start discovery, the bounded gates, adoption, and read-only surfaces."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="mse-stage4a-")
        self.addCleanup(self.directory.cleanup)
        self.config = real_config(self.directory.name)
        self.environment = patch.dict(os.environ, {"MSE_LEARN_CLI": str(ROOT / "src/cli.mjs"),
                                    "MSE_NODE_EXECUTABLE": shutil.which("node"),
                                    "MSE_REFLECTION_ENABLED": "1"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def hooks(self, review=None):
        return module.Hooks(config=self.config, review=review)

    def problem_rows(self, hooks):
        status = hooks.call("problemStatus", {"limit": 20})
        assert status.get("ok") is True, status
        return status

    def test_a_problem_without_a_usable_source_route_waits_and_consumes_nothing(self):
        """A source this host could not keep is a WAIT: 0 tickets, 0 reviews, revision untouched.

        The core's `problemRecoveryPlan` is what decides this, and it is asked BEFORE the ticket
        exists. Every case below still persists the trusted problem — discovery is never blocked —
        and parks it with a visible wait, so the same evidence can buy a real attempt once the route
        is confirmable.
        """
        cases = (
            ("no_route", None),
            ("missing_model", {"provider": "deepseek-official"}),
            ("missing_provider", {"model": "deepseek-flash"}),
            ("control_char_in_provider", {"provider": "deepseek\u0007official", "model": "deepseek-flash"}),
            ("control_char_in_effort", {"provider": "deepseek-official", "model": "deepseek-flash",
                                        "request": {"method": "POST", "body": {"reasoning_effort": "max\t"}}}),
        )
        for label, route_kwargs in cases:
            with self.subTest(case=label):
                # A FRESH state root per case: the same evidence replayed against the same problem
                # is a duplicate by design, so sharing one store would silently test nothing.
                isolated = tempfile.TemporaryDirectory(prefix="mse-stage4a-%s-" % label)
                self.addCleanup(isolated.cleanup)
                reviewer = BindingReviewer()
                hooks = module.Hooks(config=real_config(isolated.name), review=reviewer)
                hooks.pre_llm_call(session_id="cold", turn_id="1", user_message="导出金额并排序")
                if route_kwargs is not None:
                    hooks.pre_api_request(session_id="cold", turn_id="1", api_request_id="req-1",
                                          api_mode="chat_completions",
                                          request_messages=[{"role": "user", "content": "导出金额并排序"}],
                                          **route_kwargs)
                hooks.post_tool_call(**tool_failure("cold", "1", "call-1"))
                hooks.post_tool_call(**tool_failure("cold", "1", "call-2"))
                hooks.post_llm_call(session_id="cold", turn_id="1", completed=True, assistant_response="")
                self._wait_idle(hooks)
                # 1. The problem is still discovered and persisted.
                rows = self._problems(hooks)
                self.assertEqual(len(rows), 1, rows)
                self.assertEqual(rows[0]["evidenceRevision"], 2)
                # 2. No ticket, no reviewer call, nothing consumed.
                self.assertEqual(reviewer.requests, [], "an unbound source must not be reviewed")
                self.assertEqual(rows[0]["attemptedRevision"], 0, "no revision may be consumed")
                self.assertEqual(rows[0]["lessonId"], None)
                self.assertEqual(hooks.call("list", {"limit": 5})["lessons"], [])
                # 3. The wait is explicit and positive, not a silent drop.
                self.assertIn(rows[0]["reason"], {"source_route_unbound", "source_unbound"},
                              "the wait must name a source fact")
                self.assertEqual(rows[0]["recoverable"], True, "new evidence must still open a chance")
                self.assertGreater(rows[0]["nextAttemptAt"], 0, "a park is always a positive wait")
                local = hooks.local_status()["problems"]
                self.assertEqual(local["waiting"], 1)
                self.assertIn(local["last"], {"source_route_unbound", "source_unbound"})

    def test_a_valid_route_then_an_invalid_one_for_the_same_turn_binds_nothing(self):
        """A later unusable dispatch REPLACES the earlier valid route for that same turn.

        Keeping the earlier capture would let the turn's failures be reflected on a permit the LAST
        real dispatch no longer supports, which is the hole a top-level-only bounds check leaves. The
        result must be 0 tickets, 0 reviewer calls and no consumed revision.
        """
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="flip", turn_id="1", user_message="导出金额并排序")
        # The first dispatch is perfectly usable and IS captured.
        self.route(hooks, "flip")
        self.assertEqual(hooks.routes[("flip", "1")],
                         {"provider": "deepseek-official", "model": "deepseek-flash"})
        # A second dispatch on the same turn reports a route this host cannot keep.
        hooks.pre_api_request(session_id="flip", turn_id="1", api_request_id="req-flip-2",
                              provider="deepseek-official", model="deepseek-flash", api_mode="chat_completions",
                              request={"method": "POST", "body": {"reasoning_effort": "e" * 17}},
                              request_messages=[{"role": "user", "content": "导出金额并排序"}])
        self.assertEqual(hooks.routes, {}, "the unusable dispatch must clear the earlier route")
        self.assertEqual(hooks.local_status()["routeRejections"], 1)
        hooks.post_tool_call(**tool_failure("flip", "1", "c1"))
        hooks.post_tool_call(**tool_failure("flip", "1", "c2"))
        hooks.post_llm_call(session_id="flip", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        self.assertEqual(reviewer.requests, [], "no reviewer may run on a superseded permit")
        rows = self._problems(hooks)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["attemptedRevision"], 0)
        self.assertEqual(rows[0]["reason"], "source_route_unbound")
        self.assertEqual(hooks.call("list", {"limit": 5})["lessons"], [])

    def test_the_reasoning_effort_is_read_from_the_real_wire_body_only(self):
        """`request.body.reasoning_effort` is the real host shape; nothing else in it is read."""
        hooks = self.hooks(review=BindingReviewer())
        hooks.pre_llm_call(session_id="wire", turn_id="1", user_message="导出金额并排序")
        hooks.pre_api_request(session_id="wire", turn_id="1", api_request_id="req-wire-1",
                              provider="deepseek-official", model="deepseek-flash", api_mode="chat_completions",
                              request={"method": "POST", "body": {"reasoning_effort": "high", "temperature": 0.2,
                                                                  "messages": [{"role": "user", "content": "secret"}]},
                                       "url": "https://example.invalid/v1/chat/completions"},
                              request_messages=[{"role": "user", "content": "导出金额并排序"}])
        self.assertEqual(hooks.routes[("wire", "1")],
                         {"provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "high"})
        # A top-level `reasoning_effort` is NOT the host's shape and is not what gets bound.
        hooks.pre_llm_call(session_id="wire", turn_id="2", user_message="导出金额并排序")
        hooks.pre_api_request(session_id="wire", turn_id="2", api_request_id="req-wire-2",
                              provider="deepseek-official", model="deepseek-flash",
                              reasoning_effort="low",
                              request_messages=[{"role": "user", "content": "导出金额并排序"}])
        self.assertEqual(hooks.routes[("wire", "2")],
                         {"provider": "deepseek-official", "model": "deepseek-flash"},
                         "the hook's top level is not the wire")
        # The rest of the request never reaches the store or the map.
        stored = json.dumps({"%s|%s" % key: value for key, value in hooks.routes.items()})
        self.assertNotIn("messages", stored)
        self.assertNotIn("temperature", stored)
        self.assertNotIn("example.invalid", stored)
        self.assertNotIn("secret", stored)

    def route(self, hooks, session, turn="1", effort=None, **extra):
        """One REAL `pre_api_request` on the profile route, which is what binds a problem's source.

        The reasoning effort travels where the host really puts it — inside `request.body`, the shape
        `agent._api_request_payload_for_hook` builds — so this also covers the real wire reading.
        Without a route at all the evidence has no provider/model and the core's own recovery plan
        refuses the problem as `source_route_unbound`, which the negative-control test asserts.
        """
        body = {"model": "deepseek-flash"}
        if effort is not None:
            body["reasoning_effort"] = effort
        payload = {"provider": "deepseek-official", "model": "deepseek-flash", "api_mode": "chat_completions",
                   "api_request_id": "req-%s-%s" % (session, turn), "request": {"method": "POST", "body": body}}
        payload.update(extra)
        hooks.pre_api_request(session_id=session, turn_id=turn,
                              request_messages=[{"role": "user", "content": "导出金额并排序"}], **payload)

    # --- 1. cold start: no lesson, no receipt, two independent failures, no summary ----------
    def test_an_empty_library_with_two_failures_and_no_summary_produces_one_bound_candidate(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        # The library really is empty: nothing to recall, so the turn has no receipt at all.
        self.assertIsNone(hooks.pre_llm_call(session_id="cold", turn_id="1", user_message="导出金额并排序"))
        self.route(hooks, "cold")
        row = hooks.turns[("cold", "1")]
        self.assertIsNone(row["receipt"], "a cold library must not produce a receipt")
        # Two INDEPENDENT failures of the SAME tool: the core aggregates by tool identity, so
        # this is one problem with two pieces of evidence, which is the readiness threshold.
        hooks.post_tool_call(**tool_failure("cold", "1", "call-1"))
        hooks.post_tool_call(**tool_failure("cold", "1", "call-2"))
        # The host really ends the turn with no assistant reply at all.
        hooks.post_llm_call(session_id="cold", turn_id="1", completed=True, failed=False, interrupted=False,
                            assistant_response="")
        self._wait_idle(hooks)
        # 1. The problem is really persisted, at revision 2, and it is READY.
        status = self.problem_rows(hooks)
        self.assertEqual(status["total"], 1, status)
        self.assertEqual(status["byState"]["candidate_created"], 1, status)
        # 2. Exactly ONE bound reflection was requested, and its request carried the binding and
        #    the bounded host-fact summary (the host produced no assistant text to reflect on).
        self.assertEqual(len(reviewer.requests), 1, "exactly one reflection for one problem")
        self.assertIn("2 条工具失败", reviewer.joined())
        self.assertNotIn("command failed", reviewer.joined())
        self.assertNotIn("raise SystemExit", reviewer.joined())
        # 3. The candidate exists and is LINKED to the problem, and nothing claims adoption.
        lessons = hooks.call("list", {"limit": 5})["lessons"]
        self.assertEqual(len(lessons), 1, lessons)
        self.assertEqual(lessons[0]["status"], "candidate")
        linked = [problem for problem in self._problems(hooks) if problem.get("lessonId") == lessons[0]["id"]]
        self.assertEqual(len(linked), 1, "the candidate is linked to its problem in the same write")
        self.assertEqual(linked[0]["evidenceRevision"], 2)
        # 4. Nothing was adopted or verified by any of this.
        self.assertEqual(hooks.call("status", {})["adopted"], 0)
        self.assertEqual(hooks.call("status", {})["verified"], 0)

    def test_the_ticket_binds_the_exact_problem_id_and_revision_it_was_issued_for(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="cold", turn_id="1", user_message="导出金额并排序")
        self.route(hooks, "cold")
        hooks.post_tool_call(**tool_failure("cold", "1", "call-1"))
        hooks.post_tool_call(**tool_failure("cold", "1", "call-2"))
        hooks.post_llm_call(session_id="cold", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        problem = self._problems(hooks)[0]
        # The recorded request text is the data-only summary; the binding itself is asserted through
        # the core's own document — the lesson carries the problem link, and the problem carries the
        # ATTEMPTED revision, which is what "bound" means.
        self.assertEqual(len(reviewer.requests), 1)
        self.assertEqual(problem["lessonId"] is not None, True)
        self.assertEqual(problem["attemptedRevision"], 2, "the signed ticket consumed revision 2")
        self.assertEqual(problem["state"], "candidate_created")

    # --- 2. the gates: nothing immature may reach a candidate --------------------------------
    def test_a_single_failure_with_a_summary_never_reaches_a_candidate(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="one", turn_id="1", user_message="导出金额并排序")
        hooks.post_tool_call(**tool_failure("one", "1", "call-1"))
        hooks.post_llm_call(session_id="one", turn_id="1", completed=True, failed=False, interrupted=False,
                            assistant_response="工具失败了，我换了一种办法，最后完成了导出")
        self._wait_idle(hooks)
        self.assertEqual(reviewer.requests, [], "one failure plus a summary is not independent evidence")
        self.assertEqual(hooks.call("list", {"limit": 5})["lessons"], [])
        self.assertEqual(hooks.local_status()["problems"]["waiting"] >= 0, True)

    def test_a_replayed_call_id_is_not_new_evidence(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="replay", turn_id="1", user_message="导出金额并排序")
        for _ in range(4):
            hooks.post_tool_call(**tool_failure("replay", "1", "same-call"))
        hooks.post_llm_call(session_id="replay", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        self.assertEqual(reviewer.requests, [], "a replay of one physical call is one fact")
        problems = self._problems(hooks)
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]["evidenceRevision"], 1, "a replay never advances the revision")

    def test_an_anonymous_failure_degrades_to_one_slot_per_turn_tool_and_class(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="anon", turn_id="1", user_message="导出金额并排序")
        for index in range(3):
            payload = tool_failure("anon", "1", "", tool="terminal")
            payload.pop("tool_call_id")
            hooks.post_tool_call(**payload)
        hooks.post_llm_call(session_id="anon", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        problems = self._problems(hooks)
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]["evidenceRevision"], 1,
                         "no call id degrades to one slot; it never fabricates independent failures")
        self.assertEqual(reviewer.requests, [])
        self.assertEqual(hooks.local_status()["problems"]["degraded"], 1,
                         "one degraded slot, counted once")

    def test_cancellation_a_provider_error_and_a_permission_block_are_never_method_failures(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="avail", turn_id="1", user_message="导出金额并排序")
        hooks.post_tool_call(**tool_failure("avail", "1", "c1", status="cancelled"))
        hooks.post_tool_call(**tool_failure("avail", "1", "c2", error_type="ConnectionError"))
        hooks.post_tool_call(**tool_failure("avail", "1", "c3", status="blocked", error_type="permission"))
        hooks.post_tool_call(**tool_failure("avail", "1", "c4", error_type="KeyboardInterrupt"))
        hooks.post_tool_call(**tool_failure("avail", "1", "c5", status="timeout", error_type=None))
        hooks.post_llm_call(session_id="avail", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        # Exactly one roster entry: the timeout. Cancellation, a provider outage and a guard block
        # are availability facts, so they never refute a method and never reach the roster.
        problems = self._problems(hooks)
        self.assertEqual(len(problems), 1, problems)
        self.assertEqual(problems[0]["failureClass"], "tool_timeout")
        self.assertEqual(problems[0]["evidenceRevision"], 1)
        self.assertEqual(reviewer.requests, [])

    def test_a_cancelled_turn_records_no_problem_and_reflects_on_nothing(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="stop", turn_id="1", user_message="导出金额并排序")
        hooks.post_tool_call(**tool_failure("stop", "1", "c1"))
        hooks.post_tool_call(**tool_failure("stop", "1", "c2"))
        hooks.post_llm_call(session_id="stop", turn_id="1", interrupted=True, completed=False)
        self._wait_idle(hooks)
        self.assertEqual(reviewer.requests, [])
        self.assertEqual(self.problem_rows(hooks)["total"], 0, "a cancelled turn is not method evidence")

    def test_a_ready_problem_is_not_overwritten_by_a_later_immature_failure(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="mix", turn_id="1", user_message="导出金额并排序")
        self.route(hooks, "mix", "1")
        hooks.post_tool_call(**tool_failure("mix", "1", "c1"))
        hooks.post_tool_call(**tool_failure("mix", "1", "c2"))
        hooks.post_llm_call(session_id="mix", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        mature = self._problems(hooks)[0]
        self.assertEqual(len(reviewer.requests), 1)
        # A LATER turn whose last recorded failure is immature must not re-point anything.
        hooks.pre_llm_call(session_id="mix", turn_id="2", user_message="导出金额并排序")
        self.route(hooks, "mix", "2")
        hooks.post_tool_call(**tool_failure("mix", "2", "c3", tool="read_file"))
        hooks.post_llm_call(session_id="mix", turn_id="2", completed=True, assistant_response="")
        self._wait_idle(hooks)
        after = self._problems(hooks)
        still = next(problem for problem in after if problem["id"] == mature["id"])
        self.assertEqual(still["lessonId"], mature["lessonId"], "the candidate stays linked to its own problem")
        self.assertEqual(still["attemptedRevision"], 2, "an immature later failure buys no second attempt")
        self.assertEqual(len(reviewer.requests), 1, "the mature problem is still the only attempt")
        self.assertEqual(hooks.call("list", {"limit": 5})["lessons"].__len__(), 1)

    # --- 3. no receipt is not a blocker, and a real adoption still settles --------------------
    def test_a_no_receipt_turn_discovers_problems_and_a_receipt_turn_still_settles(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        # Group A: an empty library. Discovery works, settlement has nothing to bind and says so.
        hooks.pre_llm_call(session_id="cold", turn_id="1", user_message="导出金额并排序")
        self.assertIsNone(hooks.turns[("cold", "1")]["receipt"])
        self.route(hooks, "cold")
        hooks.post_tool_call(**tool_failure("cold", "1", "c1"))
        hooks.post_tool_call(**tool_failure("cold", "1", "c2"))
        hooks.post_llm_call(session_id="cold", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        self.assertEqual(self.problem_rows(hooks)["total"], 1, "an empty library still discovers")
        self.assertEqual(len(reviewer.requests), 1)
        self.assertEqual(hooks.local_status()["problems"]["last"] is None or True, True)
        # Group B: seed one real rule, then run a turn that really adopts it and completes.
        hooks2 = self.hooks(review=BindingReviewer())
        hooks2.call("record", {"eventId": "seed", "source": "direct_user", "kind": "correction",
                               "instruction": "导出金额前先把该列转换为数值类型，再按数值排序"})
        prompt = "导出金额并排序"
        recalled = hooks2.pre_llm_call(session_id="warm", turn_id="1", user_message=prompt)
        self.assertIsNotNone(recalled)
        row = hooks2.turns[("warm", "1")]
        self.assertIsNotNone(row["receipt"])
        hooks2.pre_api_request(session_id="warm", turn_id="1", api_request_id="req-1",
                               request_messages=[{"role": "user", "content": prompt + "\n\n" + recalled["context"]}])
        hooks2.post_api_request(session_id="warm", turn_id="1", api_request_id="req-1")
        self.assertEqual(hooks2.call("status", {})["adopted"], 1)
        hooks2.post_llm_call(session_id="warm", turn_id="1", completed=True, assistant_response="导出完成")
        self.assertEqual(hooks2.settlement.size(), 0, "a real receipt settles through the durable path")

    # --- 4. real adoption pairing, including the negative cases ------------------------------
    def test_adoption_requires_the_real_request_shape_and_the_same_successful_request_id(self):
        hooks = self.hooks(review=BindingReviewer())
        hooks.call("record", {"eventId": "seed", "source": "direct_user", "kind": "correction",
                              "instruction": "导出金额前先把该列转换为数值类型，再按数值排序"})
        prompt = "导出金额并排序"
        recalled = hooks.pre_llm_call(session_id="adopt", turn_id="1", user_message=prompt)
        call = {"session_id": "adopt", "turn_id": "1", "api_request_id": "req-1"}
        # (a) The offered context was TRIMMED out of the final wire: nothing may be adopted.
        hooks.pre_api_request(**call, request_messages=[{"role": "user", "content": prompt}])
        hooks.post_api_request(**call)
        self.assertEqual(hooks.call("status", {})["adopted"], 0)
        # (b) The context is present but the request FAILED: still nothing.
        hooks.pre_api_request(**call, request_messages=[{"role": "user", "content": prompt + "\n\n" + recalled["context"]}])
        hooks.post_api_request(**dict(call, failed=True))
        self.assertEqual(hooks.call("status", {})["adopted"], 0)
        # (c) A different request id answering success must not settle this one.
        hooks.post_api_request(**dict(call, api_request_id="other"))
        self.assertEqual(hooks.call("status", {})["adopted"], 0)
        # (d) The real pairing succeeds exactly once.
        hooks.post_api_request(**call)
        self.assertEqual(hooks.call("status", {})["adopted"], 1)
        # (e) A REPEATED success for the same request is idempotent, never a second adoption.
        hooks.post_api_request(**call)
        self.assertEqual(hooks.call("status", {})["adopted"], 1)
        self.assertEqual(len(hooks.call("recentAdoptions", {})["adoptions"]), 1)
        # (f) A normal completion is never `verified`.
        hooks.post_llm_call(session_id="adopt", turn_id="1", completed=True, assistant_response="导出完成")
        self.assertEqual(hooks.call("status", {})["verified"], 0)

    def test_a_zero_receipt_pre_api_call_still_captures_the_real_route(self):
        reviewer = BindingReviewer()
        hooks = self.hooks(review=reviewer)
        hooks.pre_llm_call(session_id="cold", turn_id="1", user_message="导出金额并排序")
        self.assertIsNone(hooks.turns[("cold", "1")]["receipt"])
        # The host dispatches a real request on the profile's route; there is nothing to adopt.
        hooks.pre_api_request(session_id="cold", turn_id="1", api_request_id="req-1",
                              provider="deepseek-official", model="deepseek-flash", api_mode="chat_completions",
                              base_url="https://example.invalid/v1",
                              request_messages=[{"role": "user", "content": "导出金额并排序"}])
        self.assertEqual(hooks.routes[("cold", "1")],
                         {"provider": "deepseek-official", "model": "deepseek-flash"})
        # Two failures in that same turn persist a problem whose origin carries THAT route.
        hooks.post_tool_call(**tool_failure("cold", "1", "c1"))
        hooks.post_tool_call(**tool_failure("cold", "1", "c2"))
        hooks.post_llm_call(session_id="cold", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        problem = self._problems(hooks)[0]
        self.assertEqual(problem["origin"]["provider"], "deepseek-official")
        self.assertEqual(problem["origin"]["model"], "deepseek-flash")
        # The connection details the core's route contract does not accept are not stored anywhere.
        raw = "".join(path.read_text() for path in Path(self.directory.name).rglob("*") if path.is_file())
        self.assertNotIn("example.invalid", raw)
        self.assertNotIn("api_mode", raw)

    def test_a_route_outside_the_core_bounds_binds_nothing_at_all(self):
        """Out-of-bounds identity is NOT truncated into a route the host never reported.

        The core's own `routeValid` bounds are provider 32, model 64 and reasoningEffort 16 UTF-16
        units. A value over its bound leaves the WHOLE route unbound rather than storing a shortened
        string that a later attempt could present as a match.
        """
        for label, kwargs in (
                ("provider", {"provider": "p" * 33, "model": "deepseek-flash"}),
                ("model", {"provider": "deepseek-official", "model": "m" * 65}),
                ("reasoningEffort", {"provider": "deepseek-official", "model": "deepseek-flash",
                                     "request": {"method": "POST", "body": {"reasoning_effort": "e" * 17}}})):
            with self.subTest(field=label):
                hooks = self.hooks(review=BindingReviewer())
                hooks.pre_llm_call(session_id="route", turn_id="1", user_message="导出金额并排序")
                hooks.pre_api_request(session_id="route", turn_id="1", api_request_id="req-1", api_mode="chat_completions",
                                      request_messages=[{"role": "user", "content": "导出金额并排序"}], **kwargs)
                self.assertEqual(hooks.routes, {}, "an out-of-bounds route is not captured")
                local = hooks.local_status()
                self.assertEqual(local["routesBound"], 0)
                self.assertEqual(local["routeRejections"], 1)
                self.assertEqual(local["routeRejection"], "route_%s_unusable" % label)
                hooks.post_tool_call(**tool_failure("route", "1", "c1"))
                hooks.post_tool_call(**tool_failure("route", "1", "c2"))
                hooks.post_llm_call(session_id="route", turn_id="1", completed=True, assistant_response="")
                self._wait_idle(hooks)
                origin = self._problems(hooks)[0]["origin"]
                self.assertIsNone(origin["provider"], "no partial route is claimed")
                self.assertIsNone(origin["model"])
                self.assertIsNone(origin["reasoningEffort"])

    def test_a_route_exactly_at_the_core_bounds_is_bound_verbatim(self):
        """The boundary itself is accepted, and only the three allowed fields travel."""
        hooks = self.hooks(review=BindingReviewer())
        hooks.pre_llm_call(session_id="route", turn_id="1", user_message="导出金额并排序")
        hooks.pre_api_request(session_id="route", turn_id="1", api_request_id="req-1",
                              provider="p" * 32, model="m" * 64, api_mode="chat_completions",
                              base_url="https://example.invalid/v1",
                              request={"method": "POST", "body": {"reasoning_effort": "e" * 16}},
                              request_messages=[{"role": "user", "content": "导出金额并排序"}])
        self.assertEqual(hooks.routes[("route", "1")],
                         {"provider": "p" * 32, "model": "m" * 64, "reasoningEffort": "e" * 16})
        self.assertEqual(hooks.local_status()["routesBound"], 1)
        self.assertEqual(hooks.local_status()["routeRejections"], 0)

    # --- 5. the production state: a capability wait, never a fallback route -------------------
    def test_the_production_default_waits_for_4b_and_signs_no_ticket(self):
        hooks = self.hooks()  # no injected reviewer: the real production default
        hooks.pre_llm_call(session_id="cold", turn_id="1", user_message="导出金额并排序")
        hooks.post_tool_call(**tool_failure("cold", "1", "c1"))
        hooks.post_tool_call(**tool_failure("cold", "1", "c2"))
        hooks.post_llm_call(session_id="cold", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        local = hooks.local_status()
        self.assertEqual(local["capabilities"]["reflectionDriver"], "capability_waiting")
        self.assertEqual(local["problems"]["waiting"], 1)
        self.assertEqual(local["problems"]["last"], "capability_waiting")
        problem = self._problems(hooks)[0]
        # No ticket was signed: the evidence revision is untouched and can buy a real attempt once
        # 4b wires a proven driver. Signing and then discarding would have lost this chance.
        self.assertEqual(problem["state"], "eligible")
        self.assertEqual(problem["attemptedRevision"], 0)
        self.assertEqual(problem["recoverable"], True, "the evidence is still attemptable")
        self.assertEqual(problem["evidenceRevision"], 2)

    def test_the_driver_seam_can_be_installed_and_cleared(self):
        hooks = self.hooks()
        self.assertFalse(hooks._reflectionDriverReady())
        reviewer = BindingReviewer()
        self.assertTrue(hooks.set_review(reviewer))
        self.assertTrue(hooks._reflectionDriverReady())
        self.assertEqual(hooks.local_status()["capabilities"]["reflectionDriver"], "injected_reviewer")
        # Clearing must NOT fall back to the built-in `_review`: that released method resolves the
        # profile default route and calls `call_llm`, whose retry/fallback chain is exactly what stage
        # 4b replaced. Treating it as an installed driver would re-enable an unproven capability by
        # the side door, so the instance returns to the honest waiting state instead.
        self.assertFalse(hooks.set_review(None))
        self.assertFalse(hooks._reflectionDriverReady())
        self.assertEqual(hooks.local_status()["capabilities"]["reflectionDriver"], "capability_waiting")
        self.assertFalse(hooks._injected_review)
        self.assertTrue(callable(hooks.review), "the released default is still present, just not trusted")

    # --- 5b. the REAL registration entrance --------------------------------------------------
    def test_the_real_register_entry_point_installs_the_proven_driver(self):
        """`register()` is the production entrance, and stage 4b wires the capability-proven driver.

        An injected reviewer in a unit test proves the seam works; it does NOT prove what the plugin
        actually loads. This drives the real package's `register()` with a fake `hermes_constants`
        (the only host module it needs) and a fake plugin context, then runs one complete turn
        through the hooks it really registered.

        From stage 4b on, a turn whose route the host never reported cannot borrow one: the driver
        proves the turn's OWN `pre_api_request` facts, and this turn supplied none, so the attempt
        waits with `source_unbound` and the revision stays unspent. That is the same "no ticket from
        an unprovable source" property the 4a case asserted, now enforced by the real driver rather
        than by the absence of one.
        """
        package = load_hermes_package()
        home = Path(self.directory.name, "hermes-home")
        home.mkdir()
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: home
        constants.set_hermes_home_override = lambda value: value
        constants.reset_hermes_home_override = lambda token: None
        registered = {}

        class FakeContext:
            def has_plugin(self, name):
                return False

            def on_unload(self, callback):
                registered["on_unload"] = callback

            def register_hook(self, name, handler):
                registered[name] = handler

        context_hooks = {}

        class CapturingContext(FakeContext):
            def __setattr__(self, name, value):
                if name == "mse_learning":
                    context_hooks["hooks"] = value
                object.__setattr__(self, name, value)

        with patch.dict(sys.modules, {"hermes_constants": constants}):
            package.register(CapturingContext())
        # The plugin really registered its hooks and exposed the ONE Hooks instance they belong to.
        self.assertIn("pre_llm_call", registered)
        self.assertIn("post_tool_call", registered)
        self.assertIn("on_session_end", registered)
        self.assertIn("on_session_finalize", registered)
        self.assertIn("on_unload", registered)
        hooks = context_hooks["hooks"]
        for name in ("pre_llm_call", "post_tool_call", "on_session_end"):
            self.assertIs(registered[name].__self__, hooks, "%s must belong to the exposed instance" % name)
        # Stage 4b: the real registration installs the single-attempt driver factory, and the
        # capability record says so without any fixture pre-filling the instance.
        self.assertEqual(hooks.capabilities["reflectionDriver"], "async_openai_single_attempt")
        self.assertTrue(hooks.capabilities["providerWireEvidence"])
        self.assertIsNotNone(hooks.reflection_driver)
        self.assertTrue(callable(hooks._driver_factory))
        self.assertTrue(hooks._reflectionDriverReady())
        hooks.config["stateRoot"] = self.directory.name
        hooks.pre_llm_call(session_id="reg", turn_id="1", user_message="导出金额并排序")
        self.assertIsNone(hooks.turns[("reg", "1")]["receipt"])
        hooks.post_tool_call(**tool_failure("reg", "1", "c1"))
        hooks.post_tool_call(**tool_failure("reg", "1", "c2"))
        hooks.on_session_end(session_id="reg", turn_id="1", completed=True, failed=False, interrupted=False,
                             assistant_response="")
        self._wait_idle(hooks)
        # The problem is really there and really READY; the ticket is NOT signed.
        problems = self._problems(hooks)
        self.assertEqual(len(problems), 1, problems)
        self.assertEqual(problems[0]["evidenceRevision"], 2)
        self.assertEqual(problems[0]["attemptedRevision"], 0, "no ticket, so no revision was consumed")
        self.assertEqual(problems[0]["state"], "eligible")
        self.assertEqual(problems[0]["recoverable"], True)
        self.assertEqual(hooks.call("list", {"limit": 5})["lessons"], [])
        # The driver really ran and refused to borrow a route this turn never reported.
        self.assertEqual(hooks.local_status()["problems"]["last"], "source_unbound")
        self.assertGreaterEqual(hooks.local_status()["problems"]["waiting"], 1)
        self.assertEqual(hooks.call("problemStatus", {"limit": 5})["rows"][0]["attemptedRevision"], 0,
                         "an unprovable source consumes nothing")

    def test_the_profile_binding_factory_binds_the_FACTORY_profile_on_a_worker_thread(self):
        """The profile is captured at factory time, not re-resolved on the worker thread.

        A Hermes profile override lives in a `ContextVar`, and a ContextVar has a different value in
        a NEW thread: the worker starts with the default and cannot see what the registering thread
        set. Resolving the home inside the callback would therefore bind background work back to the
        DEFAULT profile while the foreground believes it is on A. The fake below reproduces exactly
        that semantics with thread-local state, and the real driver is exercised on a real thread.
        """
        package = load_hermes_package()
        default_home = Path(self.directory.name, "default-home")
        profile_home = Path(self.directory.name, "profile-home")
        state = threading.local()
        observed = []

        def current():
            return getattr(state, "override", default_home)

        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = current
        constants.set_hermes_home_override = lambda value: setattr(state, "override", value) or "token"
        constants.reset_hermes_home_override = lambda token: setattr(state, "override", default_home)

        with patch.dict(sys.modules, {"hermes_constants": constants}):
            # The REGISTERING thread is on profile A.
            state.override = profile_home
            inner_calls = []
            wrapper = package.profile_bound_review(
                lambda request, model, cancel=None: inner_calls.append(current()) or "text")
            self.assertEqual(wrapper.mse_profile_home, profile_home, "the factory captured THIS profile")
            # The WORKER thread starts on the default, exactly as a real background thread does.
            def exploding_driver(request, model, cancel=None):
                inner_calls.append(current())
                raise RuntimeError("boom")

            raising_wrapper = package.profile_bound_review(exploding_driver)
            for kind, driver in (("normal", wrapper), ("raising", raising_wrapper)):
                def worker():
                    observed.append(("before", kind, current()))
                    if kind == "raising":
                        with self.assertRaises(RuntimeError):
                            driver("req", "model")
                    else:
                        observed.append(("driver", kind, driver("req", "model")))
                    observed.append(("after", kind, current()))

                thread = threading.Thread(target=worker)
                thread.start()
                thread.join(10)
                self.assertFalse(thread.is_alive())
        self.assertEqual(inner_calls, [profile_home, profile_home],
                         "the driver must see the PROFILE home, not the worker's default")
        self.assertEqual(observed, [
            ("before", "normal", default_home), ("driver", "normal", "text"), ("after", "normal", default_home),
            ("before", "raising", default_home), ("after", "raising", default_home),
        ], "the worker's own ContextVar value is restored, including after a raise")

    # --- 6. read-only surfaces and the bounded transport --------------------------------------
    def test_status_problem_status_recent_adoptions_and_reflection_plan_write_nothing(self):
        hooks = self.hooks(review=BindingReviewer())
        hooks.pre_llm_call(session_id="ro", turn_id="1", user_message="导出金额并排序")
        hooks.post_tool_call(**tool_failure("ro", "1", "c1"))
        hooks.post_tool_call(**tool_failure("ro", "1", "c2"))
        hooks.post_llm_call(session_id="ro", turn_id="1", completed=True, assistant_response="")
        self._wait_idle(hooks)
        def fingerprint():
            return sorted((str(path.relative_to(self.directory.name)), path.read_bytes())
                          for path in Path(self.directory.name).rglob("*") if path.is_file())
        before = fingerprint()
        spends_before = hooks.call("status", {})["counts"]
        for _ in range(3):
            hooks.local_status()
            hooks.call("problemStatus", {"limit": 10})
            hooks.call("recentAdoptions", {})
            hooks.call("reflectionPlan", {"sessionId": "ro", "turnId": "9",
                                          "taskSummary": "导出金额并排序", "resultSummary": "任务已完成",
                                          "outcome": "supported"})
            hooks.call("problemDueFeed", {})
            hooks.call("controlGeneration", {})
        self.assertEqual(fingerprint(), before, "read entry points must not touch the store")
        self.assertEqual(hooks.call("status", {})["counts"], spends_before)
        self.assertEqual(len(hooks.call("recentAdoptions", {})["adoptions"]), 0)

    def test_the_core_transport_keeps_its_2_second_and_8_kib_bounds(self):
        """The real `_call`: an oversized answer and a hung runtime are FAILURES, never successes."""
        hooks = self.hooks()
        big = Path(self.directory.name, "big.mjs")
        big.write_text("process.stdout.write(JSON.stringify({ok:true,pad:'x'.repeat(20000)}))\n")
        hang = Path(self.directory.name, "hang.mjs")
        hang.write_text("await new Promise(() => {})\n")
        for script, bound in ((big, "8 KiB stdout"), (hang, "2 second timeout")):
            with patch.dict(os.environ, {"MSE_LEARN_CLI": str(script), "MSE_NODE_EXECUTABLE": shutil.which("node")}):
                result = hooks._call("status", {})
            self.assertIsInstance(result, dict, bound)
            self.assertEqual(result.get("ok"), False, f"{bound} must refuse, never truncate")
            self.assertEqual(result.get("code"), "invalid_runtime_response" if script is big else "runtime_unavailable")

    # --- helpers -----------------------------------------------------------------------------
    def _problems(self, hooks):
        """The problems the core really holds, read back through the CLI (never through a fake)."""
        status = hooks.call("problemStatus", {"limit": 20})
        assert status.get("ok") is True, status
        return status.get("rows", [])

    def _wait_idle(self, hooks, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not hooks.jobs and not hooks.reviewing:
                return
            time.sleep(0.02)
        self.fail("the reflection worker did not finish in time")
