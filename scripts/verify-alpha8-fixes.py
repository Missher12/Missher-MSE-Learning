"""Correct-behaviour verification for the alpha.7 review item R2 (foreground/background interlock).

Usage: python3 -B scripts/verify-alpha8-fixes.py [<source-root>]

The review's own probe (dist/review-20261001-alpha7/mse-alpha7-adapter-review-native-diag.py with
`MSE_REVIEW_SLOW_CANCELLED=1`) exposes the alpha.7 defect on purpose; these assertions describe
the CORRECT behaviour. Every interleaving is deterministic: the retry runs on its own thread
(what the product's `threading.Timer` does), the fake core call blocks on an Event so this
script decides who writes first, and an overlap detector fails the check if two core calls are
ever inside the write boundary at the same time.
"""
import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mse_alpha8_hermes", root / "adapters/hermes/bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

results = []
model_calls = 0


class Clock:
    """Deterministic monotonic seconds plus a separate wall clock in epoch milliseconds."""

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
    def __init__(self, complete_plan=None, fail_times=0, receipt_remaining_ms=3_600_000):
        self.clock = Clock()
        self.calls = []
        self.order = []
        self.gates = {"complete_started": threading.Event(), "release_complete": threading.Event()}
        self.state = {"complete_calls": 0, "prepare_calls": 0, "active": 0, "overlap": False, "max_active": 0}
        self.permitted = True
        clock, fixture, gates = self.clock, self, self.gates

        def enter(operation):
            fixture.state["active"] += 1
            fixture.state["max_active"] = max(fixture.state["max_active"], fixture.state["active"])
            if fixture.state["active"] > 1:
                fixture.state["overlap"] = True
            fixture.order.append(operation + ":start")

        def leave(operation):
            fixture.order.append(operation + ":end")
            fixture.state["active"] -= 1

        def call(op, value):
            if op == "prepare":
                fixture.state["prepare_calls"] += 1
                enter("prepare")
                try:
                    return {"ok": True, "context": "本地经验：导出金额前核对数值类型", "lessons": ["lesson-fixture"],
                            "lessonVersions": [{"id": "lesson-fixture", "version": 1, "methodId": None}],
                            "receipt": "receipt-fixture", "receiptExpiresAt": clock.wall_ms() + receipt_remaining_ms}
                finally:
                    leave("prepare")
            if op == "complete":
                fixture.state["complete_calls"] += 1
                fixture.calls.append({"at": clock.now(), "payload": dict(value)})
                enter("complete")
                try:
                    if complete_plan is not None:
                        complete_plan(gates, fixture.state, fixture.calls)
                    if fixture.state["complete_calls"] <= fail_times:
                        return {"ok": False, "code": "lock_busy"}
                    return {"ok": True, "outcome": value["outcome"], "attributed": 0}
                finally:
                    leave("complete")
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

    def start_turn(self, session="old", turn="1", settle=True):
        prepared = self.hooks.pre_llm_call(session_id=session, turn_id=turn, user_message="请导出金额并排序")
        assert prepared is not None, "the fixture turn must recall the synthetic rule"
        self.hooks.pre_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture",
                                   request_messages=[{"role": "user",
                                                      "content": "请导出金额并排序\n\n" + prepared["context"]}])
        self.hooks.post_api_request(session_id=session, turn_id=turn, api_request_id="req-fixture")
        assert self.hooks.verification(session, turn, "trusted-fixture", True, ["lesson-fixture"], 1)
        if settle:
            self.hooks.post_llm_call(session_id=session, turn_id=turn, completed=True)
        return prepared

    def background_attempt(self, key=("old", "1")):
        finished = threading.Event()
        outcome = []

        def body():
            try:
                outcome.append(self.hooks.settlement.attempt(key))
            finally:
                finished.set()

        thread = threading.Thread(target=body, name="mse-settlement-retry")
        thread.daemon = True
        thread.start()
        return finished, outcome

    def wait_until(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return predicate()

    def dispose(self):
        self.gates["release_complete"].set()
        self.hooks.dispose()


def run(identifier, function):
    try:
        results.append({"id": identifier, "pass": True, "detail": function()})
    except Exception as failure:  # noqa: BLE001 - a failed check is reported, not raised
        results.append({"id": identifier, "pass": False, "detail": f"{type(failure).__name__}: {failure}"})


def check_background_write_in_flight_still_injects():
    def plan(gates, state, calls):
        if state["complete_calls"] >= 2:
            gates["complete_started"].set()
            gates["release_complete"].wait(5)
    f = Fixture(complete_plan=plan, fail_times=1)
    try:
        f.start_turn()
        assert len(f.calls) == 1, "the first attempt failed transiently"
        frozen = json.dumps(f.hooks.settlement.entries[("old", "1")]["payload"], sort_keys=True)
        finished, _ = f.background_attempt()
        assert f.gates["complete_started"].wait(5), "the retry started writing"
        resumed = f.hooks.pre_llm_call(session_id="resumed", turn_id="1", user_message="请导出金额并进行排序")
        assert not f.state["overlap"], "the foreground and background writes must not overlap"
        f.gates["release_complete"].set()
        assert finished.wait(5)
        assert f.wait_until(lambda: f.hooks.settlement_status() == [])
        assert len(f.calls) == 2, "the frozen retry lands exactly once"
        assert json.dumps(f.calls[-1]["payload"], sort_keys=True) == frozen
        assert f.hooks.settlement_history()[-1]["state"] == "settled"
        assert resumed is not None and "核对数值类型" in resumed["context"], "the foreground turn still recalls"
        assert f.state["max_active"] == 1
        return {"completeCalls": 2, "resumedBytes": len(resumed["context"].encode("utf-8")), "maxConcurrent": 1}
    finally:
        f.dispose()


def check_held_foreground_boundary_defers_and_replays():
    f = Fixture(fail_times=1)
    try:
        f.start_turn()
        assert len(f.calls) == 1
        frozen = json.dumps(f.hooks.settlement.entries[("old", "1")]["payload"], sort_keys=True)
        f.hooks.lock.acquire()
        finished, _ = f.background_attempt()
        try:
            time.sleep(0.2)
            assert len(f.calls) == 1, "the background write waits for the foreground boundary"
            assert len(f.hooks.settlement_status()) == 1, "the frozen payload stays queued"
        finally:
            f.hooks.lock.release()
        assert finished.wait(5)
        assert f.wait_until(lambda: f.hooks.settlement_status() == [])
        assert len(f.calls) == 2, "the deferred replay is not lost"
        assert json.dumps(f.calls[-1]["payload"], sort_keys=True) == frozen
        assert f.hooks.settlement_history()[-1]["state"] == "settled"
        assert not f.state["overlap"]
        return {"completeCalls": 2, "overlap": False}
    finally:
        f.dispose()


def check_recovery_turn_injects_while_cancelled_settlement_lands():
    def plan(gates, state, calls):
        gates["complete_started"].set()
        gates["release_complete"].wait(5)
    f = Fixture(complete_plan=plan, fail_times=0)
    try:
        window = {"permitted": True}
        f.hooks.enabled = lambda: window["permitted"]
        f.start_turn(session="next", turn="2", settle=False)
        assert len(f.calls) == 0, "the open turn has not settled yet"
        window["permitted"] = False
        assert f.hooks.pre_llm_call(session_id="conflict", turn_id="1",
                                    user_message="请导出金额并排序") is None
        assert len(f.hooks.settlement_status()) == 1, "the cancelled settlement waits while paused"
        assert f.hooks.settlement.entries[("next", "2")]["payload"]["outcome"] == "cancelled"
        window["permitted"] = True
        assert f.hooks.pre_llm_call(session_id="warm", turn_id="1", user_message="") is None
        finished, _ = f.background_attempt(key=("next", "2"))
        assert f.gates["complete_started"].wait(5)
        resumed = f.hooks.pre_llm_call(session_id="resumed", turn_id="1", user_message="请导出金额并进行排序")
        assert resumed is not None and "核对数值类型" in resumed["context"], "the recovery turn must inject"
        assert not f.state["overlap"], "the landing cancellation and the recall must serialise"
        f.gates["release_complete"].set()
        assert finished.wait(5)
        assert f.wait_until(lambda: f.hooks.settlement_status() == [])
        assert f.hooks.settlement_history()[-1]["state"] == "settled"
        assert [row["payload"]["outcome"] for row in f.calls] == ["cancelled"], "the frozen outcome is replayed as itself"
        assert [row["payload"].get("sessionId") for row in f.calls] == ["next"], "no leak into the resumed turn"
        return {"completeCalls": 1, "resumedBytes": len(resumed["context"].encode("utf-8")), "maxConcurrent": 1}
    finally:
        f.dispose()


def check_a_bounded_wait_defers_with_lock_busy():
    original = module.SETTLEMENT_LOCK_TIMEOUT
    module.SETTLEMENT_LOCK_TIMEOUT = 0.05
    f = Fixture(fail_times=1)
    try:
        f.start_turn()
        assert len(f.calls) == 1
        f.hooks.lock.acquire()
        finished, outcome = f.background_attempt()
        try:
            assert finished.wait(5), "a bounded wait always returns"
            assert len(f.calls) == 1, "the write is refused while the boundary is held"
            assert outcome[0]["state"] == "retrying" and outcome[0]["code"] == "lock_busy"
            assert len(f.hooks.settlement_status()) == 1, "the frozen payload stays queued"
        finally:
            f.hooks.lock.release()
        f.clock.advance(0.25)
        assert f.wait_until(lambda: len(f.calls) == 2), "a later attempt still replays it exactly once"
        assert f.hooks.settlement_history()[-1]["state"] == "settled"
        assert not f.state["overlap"]
        return {"refusedState": "retrying", "code": "lock_busy", "laterAttempts": 1}
    finally:
        module.SETTLEMENT_LOCK_TIMEOUT = original
        f.dispose()


def check_controls_preserved():
    # Quiet-period permission withdrawal still blocks a retry (F5).
    quiet = Fixture(fail_times=1)
    try:
        quiet.start_turn()
        assert len(quiet.calls) == 1
        quiet.permitted = False
        quiet.clock.advance(0.25)
        assert len(quiet.calls) == 1, "a withdrawn permission still stops the retry"
        assert len(quiet.hooks.settlement_status()) == 1
        quiet.permitted = True
        quiet.hooks.pre_llm_call(session_id="another", turn_id="1", user_message="")
        quiet.clock.advance(0)
        assert len(quiet.calls) == 2, "recovery replays the unexpired original once"
        assert quiet.hooks.settlement_history()[-1]["state"] == "settled"
    finally:
        quiet.dispose()
    # A reset still stops retries and a dispose still cancels them.
    reset = Fixture(fail_times=1)
    try:
        reset.start_turn()
        reset.hooks.on_session_reset(old_session_id="old", new_session_id="new")
        reset.clock.advance(0.25)
        assert len(reset.calls) == 1
        assert reset.hooks.settlement_history()[-1]["state"] == "stopped"
    finally:
        reset.dispose()
    # Receipt units and the five-minute age bound are unchanged.
    units = Fixture(receipt_remaining_ms=100)
    try:
        near = units.hooks._settlement_deadline(units.clock.wall_ms() + 100)
        far = units.hooks._settlement_deadline(units.clock.wall_ms() + 3_600_000)
        assert abs(near - 1000.1) < 1e-9 and abs(far - 1300.0) < 1e-9
    finally:
        units.dispose()
    return {"quietWithdrawalBlocked": True, "resetStopped": True, "receiptNear": 1000.1, "receiptAgeBound": 1300.0}


run("r2-background-write-in-flight-still-injects", check_background_write_in_flight_still_injects)
run("r2-held-foreground-boundary-defers-and-replays", check_held_foreground_boundary_defers_and_replays)
run("r2-recovery-turn-injects-while-cancelled-settlement-lands", check_recovery_turn_injects_while_cancelled_settlement_lands)
run("r2-a-bounded-wait-defers-with-lock-busy", check_a_bounded_wait_defers_with_lock_busy)
run("r2-controls-preserved", check_controls_preserved)

report = {"source": str(root), "schema": "mse-alpha8-fix-checks-v1", "passed": sum(1 for row in results if row["pass"]),
          "failed": sum(1 for row in results if not row["pass"]), "modelCalls": model_calls, "results": results}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(1 if report["failed"] else 0)
