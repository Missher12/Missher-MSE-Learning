"""Correct-behaviour verification for the alpha.6 review item F5 (Hermes side).

Usage: python3 scripts/verify-alpha7-fixes.py [<source-root>]

The review's own probe (dist/review-20261001-alpha6/adapter-review.py) asserts the alpha.6
defect on purpose; these assertions describe the CORRECT behaviour and are driven through
the real hook entry points with a fake clock and a fake Node call bridge.

F5: after a first `complete` fails transiently, the host can withdraw permission without
firing any new hook. The queue re-reads the latest permission immediately before every write,
so that retry is paused with its original frozen payload instead of landing anyway.
"""
import importlib.util
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mse_alpha7_hermes", root / "adapters/hermes/bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

results = []
model_calls = 0


class Clock:
    """Monotonic seconds for the queue plus a separate wall clock in epoch milliseconds."""

    def __init__(self, wall_ms=1_800_000_000_000.0):
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


class Fixture:
    def __init__(self, receipt_remaining_ms=3_600_000, permitted=True):
        self.clock = Clock()
        self.calls = []
        self.ops = []
        self.permitted = permitted
        fixture = self
        clock, calls = self.clock, self.calls

        def call(op, value):
            fixture.ops.append(op)
            if op == "prepare":
                return {"ok": True, "context": "本地经验：导出金额前核对数值类型",
                        "lessons": ["lesson-fixture"],
                        "lessonVersions": [{"id": "lesson-fixture", "version": 1, "methodId": None}],
                        "receipt": "receipt-fixture",
                        "receiptExpiresAt": clock.wall_ms() + receipt_remaining_ms}
            if op == "complete":
                # The host permission is sampled at call time, so a call that should never
                # have happened is visible in the record itself.
                calls.append({"at": clock.now(), "permitted": fixture.permitted, "payload": dict(value)})
                return ({"ok": False, "code": "lock_busy"} if len(calls) == 1
                        else {"ok": True, "outcome": value["outcome"], "attributed": 0})
            return {"ok": True}

        class HookHooks(module.Hooks):
            def __init__(inner_self, *args, **kwargs):
                inner_self.monotonic = clock.now
                inner_self.schedule = clock.schedule
                inner_self.cancel = clock.cancel
                inner_self.wall_ms = clock.wall_ms
                super().__init__(*args, **kwargs)

        self.hooks = HookHooks(config={"stateRoot": "/tmp/unused-fake-engine", "adapterId": "hermes",
                                       "maxContextBytes": 768}, call=call,
                               enabled=lambda: fixture.permitted)

    def run_turn(self, session="old", turn="1"):
        prepared = self.hooks.pre_llm_call(session_id=session, turn_id=turn, user_message="请导出金额并排序")
        assert prepared is not None, "the fixture turn must recall the synthetic rule"
        self.hooks.pre_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture",
                                   request_messages=[{"role": "user",
                                                      "content": "请导出金额并排序\n\n" + prepared["context"]}])
        self.hooks.post_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture")
        assert self.hooks.verification(session, turn, "trusted-fixture", True, ["lesson-fixture"], 1)
        self.hooks.post_llm_call(session_id=session, turn_id=turn, completed=True)


def run(identifier, function):
    try:
        results.append({"id": identifier, "pass": True, "detail": function()})
    except Exception as failure:  # noqa: BLE001 - a failed check is reported, not raised
        results.append({"id": identifier, "pass": False, "detail": f"{type(failure).__name__}: {failure}"})


def check_f5_quiet_period_retry_never_writes():
    fixture = Fixture()
    fixture.run_turn()
    assert len(fixture.calls) == 1, "the first attempt ran and failed transiently"
    frozen = json.dumps(fixture.calls[0]["payload"], sort_keys=True)
    pending = fixture.hooks.settlement_status()
    assert len(pending) == 1 and pending[0]["attempts"] == 1
    # Permission disappears with no hook call at all, then the retry timer fires.
    fixture.permitted = False
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 1, "a withdrawn permission must stop the retry before it writes"
    status = fixture.hooks.settlement_status()
    assert len(status) == 1, "the frozen settlement is kept, not dropped"
    assert status[0]["state"] == "pending", "a paused entry stays pending for an explicit resume"
    assert status[0]["attempts"] == 1, "a refused attempt is not counted as an attempt"
    assert fixture.hooks.settlement.paused, "the queue pauses instead of retrying on"
    assert fixture.hooks.settlement_history() == [], "nothing was retired as cancelled or failed"
    assert any(event["kind"] == "blocked" and event["code"] == "learning_disabled"
               for event in fixture.hooks.settlement_events), "the refusal is observable"
    fixture.hooks.dispose()
    return {"completeCalls": 1, "state": "pending", "blocked": True, "frozenUnchanged": frozen}


def check_f5_recovery_replays_only_the_original_payload():
    fixture = Fixture()
    fixture.run_turn()
    original = json.dumps(fixture.calls[0]["payload"], sort_keys=True)
    review_ops = lambda: [op for op in fixture.ops if op in {"reflectionRequest", "reflectionResult", "evaluationRequest"}]
    reviews_before = review_ops()
    fixture.permitted = False
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 1
    # Permission returns: the next hook call is the only thing that resumes the queue.
    fixture.permitted = True
    fixture.hooks.pre_llm_call(session_id="another", turn_id="1", user_message="请导出金额并排序")
    fixture.clock.advance(0)
    assert len(fixture.calls) == 2, "the unexpired original is replayed exactly once"
    assert fixture.calls[1]["permitted"] is True
    assert json.dumps(fixture.calls[1]["payload"], sort_keys=True) == original, \
        "the replay is the SAME frozen payload, never rewritten to cancelled"
    assert fixture.hooks.settlement_history()[-1]["state"] == "settled"
    assert fixture.hooks.settlement_status() == []
    assert review_ops() == reviews_before, "no reflection or evaluation work is re-run on resume"
    assert [op for op in fixture.ops if op == "complete"].count("complete") == 2, \
        "the retry only ever replays complete"
    assert all(call["permitted"] is True for call in fixture.calls), "no call is ever made without permission"
    fixture.hooks.dispose()
    return {"completeCalls": 2, "payloadIdentical": True, "replayedWork": 0}


def check_f5_expired_original_is_retired_without_writing():
    # Long enough for the first retry to be scheduled, short enough to expire while paused.
    fixture = Fixture(receipt_remaining_ms=2000)
    fixture.run_turn()
    assert len(fixture.calls) == 1
    fixture.permitted = False
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 1
    # A long quiet period: the frozen payload may only be replayed while it is unexpired.
    fixture.clock.advance(10)
    fixture.permitted = True
    fixture.hooks.pre_llm_call(session_id="another", turn_id="1", user_message="请导出金额并排序")
    fixture.clock.advance(0)
    assert len(fixture.calls) == 1, "an expired settlement is never written late"
    assert fixture.hooks.settlement_status() == []
    assert fixture.hooks.settlement_history()[-1]["state"] == "expired"
    fixture.hooks.dispose()
    return {"completeCalls": 1, "retired": "expired"}


def check_f5_control_normal_turn_end_and_explicit_pause():
    fixture = Fixture()
    fixture.run_turn(session="normal", turn="1")
    assert len(fixture.calls) == 1, "the ordinary per-turn settlement is attempted immediately"
    fixture.hooks.dispose()
    explicit = Fixture()
    explicit.run_turn(session="explicit", turn="1")
    explicit.hooks.set_enabled(False)
    explicit.clock.advance(0.25)
    assert len(explicit.calls) == 1, "an explicit pause stops retries"
    explicit.hooks.set_enabled(True)
    explicit.clock.advance(0)
    assert len(explicit.calls) == 2, "an explicit resume replays the unexpired completion once"
    explicit.hooks.dispose()
    return {"normalCalls": 1, "pausedCalls": 1, "resumedCalls": 2}


def check_f5_control_reset_still_closes_the_session():
    fixture = Fixture()
    fixture.run_turn()
    fixture.hooks.on_session_reset(old_session_id="old", new_session_id="new")
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 1, "a reset session must not keep settling"
    assert fixture.hooks.settlement_history()[-1]["state"] == "stopped"
    fixture.hooks.dispose()
    return {"completeCalls": 1, "retired": "stopped"}


def check_f5_receipt_units_are_unchanged():
    fixture = Fixture(receipt_remaining_ms=100)
    deadline = fixture.hooks._settlement_deadline(fixture.clock.wall_ms() + 100)
    assert abs(deadline - 1000.1) < 1e-9, f"monotonic receipt deadline: {deadline}"
    far = fixture.hooks._settlement_deadline(fixture.clock.wall_ms() + 3_600_000)
    assert abs(far - 1300.0) < 1e-9, f"the five-minute age bound still applies: {far}"
    fixture.hooks.dispose()
    return {"nearReceipt": 1000.1, "ageBound": 1300.0}


run("f5-quiet-period-retry-never-writes", check_f5_quiet_period_retry_never_writes)
run("f5-recovery-replays-only-the-original-payload", check_f5_recovery_replays_only_the_original_payload)
run("f5-expired-original-is-retired-without-writing", check_f5_expired_original_is_retired_without_writing)
run("f5-control-normal-turn-end-and-explicit-pause", check_f5_control_normal_turn_end_and_explicit_pause)
run("f5-control-reset-still-closes-the-session", check_f5_control_reset_still_closes_the_session)
run("f5-receipt-units-are-unchanged", check_f5_receipt_units_are_unchanged)

report = {"source": str(root), "passed": sum(1 for row in results if row["pass"]),
          "failed": sum(1 for row in results if not row["pass"]), "modelCalls": model_calls, "results": results}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(1 if report["failed"] else 0)
