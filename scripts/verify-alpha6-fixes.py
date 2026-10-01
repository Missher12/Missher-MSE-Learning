"""Fixed-behaviour verification for the alpha.5 review items D2/D3/D4 on the Hermes side.

Usage: python3 scripts/verify-alpha6-fixes.py [<source-root>]

The review's own probe asserts the alpha.5 defects on purpose; these assertions describe
the CORRECT behaviour and are driven through the real hook entry points
(`pre_llm_call`, `on_session_reset`, `on_session_end`), never by calling
`close_session`/`set_enabled` directly.
"""
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mse_alpha6_hermes", root / "adapters/hermes/bridge.py")
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
        self.permitted = permitted
        clock, calls = self.clock, self.calls

        def call(op, value):
            if op == "prepare":
                return {"ok": True, "context": "本地经验：导出金额前核对数值类型",
                        "lessons": ["lesson-fixture"],
                        "lessonVersions": [{"id": "lesson-fixture", "version": 1, "methodId": None}],
                        "receipt": "receipt-fixture",
                        "receiptExpiresAt": clock.wall_ms() + receipt_remaining_ms}
            if op == "complete":
                calls.append({"at": clock.now(), "payload": dict(value)})
                return ({"ok": False, "code": "lock_busy"} if len(calls) == 1
                        else {"ok": True, "outcome": value["outcome"], "attributed": 0})
            return {"ok": True}

        fixture = self

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


def check_d2_reset_through_the_real_hook():
    fixture = Fixture()
    fixture.run_turn()
    assert len(fixture.calls) == 1
    assert len(fixture.hooks.settlement_status()) == 1, "the frozen settlement is still retrying"
    fixture.hooks.on_session_reset(old_session_id="old", new_session_id="new")
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 1, "a reset session must not keep settling"
    assert fixture.hooks.settlement_history()[-1]["state"] == "stopped"
    fixture.hooks.dispose()
    return {"completeCalls": 1, "retired": "stopped"}


def check_d2_legacy_takeover_pauses_and_recovers():
    fixture = Fixture()
    fixture.run_turn()
    fixture.permitted = False
    assert fixture.hooks.pre_llm_call(session_id="another", turn_id="1",
                                      user_message="请导出金额并排序") is None
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 1, "a legacy takeover must stop retrying"
    assert fixture.hooks.settlement.paused
    fixture.permitted = True
    assert fixture.hooks.pre_llm_call(session_id="another", turn_id="1",
                                      user_message="请导出金额并排序") is not None
    fixture.clock.advance(0)
    assert len(fixture.calls) == 2, "recovered permission replays the unexpired completion once"
    fixture.hooks.dispose()
    return {"paused": True, "recoveredReplay": 1}


def check_d2_per_turn_end_is_not_a_close():
    fixture = Fixture()
    fixture.run_turn()
    fixture.hooks.on_session_end(session_id="old", turn_id="1", completed=True, failed=False, interrupted=False)
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 2, "an ordinary turn end keeps the frozen settlement alive"
    fixture.hooks.dispose()
    return {"completeCalls": 2}


def check_d3_stopped_sessions_release_capacity():
    fixture = Fixture()
    for index in range(64):
        session = f"closed-{index}"
        fixture.hooks.pre_llm_call(session_id=session, turn_id="1", user_message="请导出金额并排序")
        fixture.hooks.post_llm_call(session_id=session, turn_id="1", completed=True)
        fixture.hooks.close_session(session)
    live = len(fixture.hooks.settlement_status())
    fixture.clock.advance(300.001)
    fresh = fixture.hooks.pre_llm_call(session_id="healthy", turn_id="1", user_message="请导出金额并排序")
    assert live == 0, "stopped entries hold no live capacity"
    assert fresh is not None, "a healthy turn still settles after 64 stopped sessions"
    assert len(fixture.hooks.settlement_history()) <= 32, "terminal history stays bounded"
    fixture.hooks.dispose()
    return {"liveAfterStop": live, "history": len(fixture.hooks.settlement_history())}


def check_d4_receipt_deadline_units():
    fixture = Fixture(receipt_remaining_ms=100)
    fixture.run_turn()
    fixture.clock.advance(0.25)
    assert len(fixture.calls) == 1, "a receipt with 100ms left must not be retried at 250ms"
    assert fixture.hooks.settlement_history()[-1]["state"] == "exhausted"
    fixture.hooks.dispose()
    far = Fixture(receipt_remaining_ms=3_600_000)
    far.run_turn()
    deadline = far.hooks.settlement.entries[("old", "1")]["deadline"]
    assert abs(deadline - 1300.0) < 1e-6, f"the five minute age bound governs, got {deadline}"
    far.clock.advance(0.25)
    assert len(far.calls) == 2
    far.hooks.dispose()
    return {"nearReceiptRetries": 1, "farReceiptDeadline": 1300.0}


run("d2-session-reset-stops-retries", check_d2_reset_through_the_real_hook)
run("d2-legacy-takeover-pauses-queue", check_d2_legacy_takeover_pauses_and_recovers)
run("d2-per-turn-end-is-not-a-close", check_d2_per_turn_end_is_not_a_close)
run("d3-stopped-sessions-release-capacity", check_d3_stopped_sessions_release_capacity)
run("d4-receipt-deadline-clock-units", check_d4_receipt_deadline_units)

report = {"source": str(root), "passed": sum(1 for row in results if row["pass"]),
          "failed": sum(1 for row in results if not row["pass"]), "modelCalls": model_calls,
          "results": results}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(1 if report["failed"] else 0)
