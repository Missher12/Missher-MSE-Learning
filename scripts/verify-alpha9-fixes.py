"""Correct-behaviour verification for the alpha.8 review item R3 (validity re-check under the lock wait).

Usage: python3 -B scripts/verify-alpha9-fixes.py [<source-root>]

The review's own probe (dist/review-20261001-alpha8/mse-alpha8-adapter-review-wait-boundary.py)
asserts the alpha.8 defect on purpose; these assertions describe the CORRECT behaviour. Every
case holds the write boundary, drives the scheduled retry onto its own thread, waits for the
background to actually ENTER the lock wait, and only then changes state — a pass can therefore
never come from "the retry was refused before it started".
"""
import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mse_alpha9_hermes", root / "adapters/hermes/bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

results = []
model_calls = 0


class Clock:
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


class ObservedLock:
    """The Hooks write boundary plus a signal for 'a background attempt is waiting on it'."""

    def __init__(self):
        self.raw = threading.RLock()
        self.waiting = threading.Event()

    def acquire(self, *args, **kwargs):
        if threading.current_thread().name == "mse-wait-boundary":
            self.waiting.set()
        return self.raw.acquire(*args, **kwargs)

    def release(self):
        return self.raw.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


class Fixture:
    def __init__(self, fail_times=1, receipt_remaining_ms=3_600_000):
        self.clock = Clock()
        self.calls = []
        self.state = {"complete_calls": 0, "prepare_calls": 0}
        self.window = {"permitted": True}
        clock, fixture, state = self.clock, self, self.state

        def call(op, value):
            if op == "prepare":
                state["prepare_calls"] += 1
                return {"ok": True, "context": "本地经验：导出金额前核对数值类型", "lessons": ["lesson-fixture"],
                        "lessonVersions": [{"id": "lesson-fixture", "version": 1, "methodId": None}],
                        "receipt": "receipt-fixture", "receiptExpiresAt": clock.wall_ms() + receipt_remaining_ms}
            if op == "complete":
                state["complete_calls"] += 1
                fixture.calls.append({"at": clock.now(), "payload": dict(value)})
                if state["complete_calls"] <= fail_times:
                    return {"ok": False, "code": "lock_busy"}
                return {"ok": True, "outcome": value["outcome"], "attributed": 0}
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
                               enabled=lambda: fixture.window["permitted"])
        self.hooks.lock = ObservedLock()

    def start_turn(self):
        prepared = self.hooks.pre_llm_call(session_id="old", turn_id="1", user_message="请导出金额并排序")
        assert prepared is not None, "the fixture turn must recall the synthetic rule"
        self.hooks.pre_api_request(session_id="old", turn_id="1", api_request_id="req-fixture",
                                   request_messages=[{"role": "user",
                                                      "content": "请导出金额并排序\n\n" + prepared["context"]}])
        self.hooks.post_api_request(session_id="old", turn_id="1", api_request_id="req-fixture")
        assert self.hooks.verification("old", "1", "trusted-fixture", True, ["lesson-fixture"], 1)
        self.hooks.post_llm_call(session_id="old", turn_id="1", completed=True)

    def frozen_payload(self, key=("old", "1")):
        return json.dumps(self.hooks.settlement.entries[key]["payload"], sort_keys=True)

    def wait_then_change(self, action):
        """Hold the boundary, drive the retry into the wait, change state, release."""
        assert self.calls and self.clock.jobs, "a pending retry is scheduled"
        timer_id, (due, callback) = next(iter(self.clock.jobs.items()))
        self.clock.jobs.pop(timer_id)
        self.clock.time = due
        failures = []

        def body():
            try:
                callback()
            except Exception as exc:  # noqa: BLE001 - reported as a failed check
                failures.append(repr(exc))

        worker = threading.Thread(target=body, name="mse-wait-boundary")
        worker.daemon = True
        with self.hooks.lock:
            worker.start()
            assert self.hooks.lock.waiting.wait(5), "the background reached the lock wait"
            assert len(self.calls) == 1, "nothing is written while the boundary is held"
            if action == "legacy_disable":
                self.window["permitted"] = False
            elif action == "pause":
                self.hooks.set_enabled(False)
            elif action == "close":
                self.hooks.close_session("old")
            elif action == "dispose":
                self.hooks.dispose()
            elif action == "expiry":
                self.clock.time += 301.0
            elif action == "pause_then_expire":
                self.hooks.set_enabled(False)
                self.clock.time += 301.0
        worker.join(5)
        assert not worker.is_alive(), "the bounded wait always returns"
        assert failures == [], failures
        return self.hooks.settlement_history()

    def dispose(self):
        self.hooks.dispose()


def run(identifier, function):
    try:
        results.append({"id": identifier, "pass": True, "detail": function()})
    except Exception as failure:  # noqa: BLE001 - a failed check is reported, not raised
        results.append({"id": identifier, "pass": False, "detail": f"{type(failure).__name__}: {failure}"})


def check_control_retry_lands_after_the_wait():
    f = Fixture()
    try:
        f.start_turn()
        frozen = f.frozen_payload()
        f.wait_then_change("control")
        assert len(f.calls) == 2, "an unchanged retry settles after the wait"
        assert json.dumps(f.calls[-1]["payload"], sort_keys=True) == frozen
        assert f.hooks.settlement_status() == []
        assert f.hooks.settlement_history()[-1]["state"] == "settled"
        return {"completeCalls": 2, "state": "settled"}
    finally:
        f.dispose()


def check_invalidations_never_reach_the_core():
    observed = {}
    for action in ["legacy_disable", "pause", "close", "dispose", "expiry"]:
        f = Fixture()
        try:
            f.start_turn()
            frozen = f.frozen_payload()
            history = f.wait_then_change(action)
            states = [row["state"] for row in history]
            assert len(f.calls) == 1, f"{action}: the stale write must not be issued"
            assert "settled" not in states, f"{action}: an invalid retry is never settled"
            if action in {"legacy_disable", "pause"}:
                pending = f.hooks.settlement.entries.get(("old", "1"))
                assert pending is not None and pending["state"] == "pending", f"{action}: payload kept for a resume"
                assert pending["attempts"] == 1, f"{action}: a refused write consumes no attempt"
                assert json.dumps(pending["payload"], sort_keys=True) == frozen, f"{action}: payload unchanged"
                assert f.hooks.settlement.paused, f"{action}: the queue pauses instead of retrying on"
            elif action == "close":
                assert f.hooks.settlement.entries.get(("old", "1")) is None
                assert states == ["stopped"], f"{action}: retired once, never settled twice"
            elif action == "dispose":
                assert f.hooks.settlement.disposed
                assert f.hooks.settlement.attempt(("old", "1"))["state"] == "pending"
                assert len(f.calls) == 1
            elif action == "expiry":
                assert f.hooks.settlement.entries.get(("old", "1")) is None
                assert states == ["expired"], f"{action}: the original deadline contract"
            observed[action] = {"completeCalls": 1, "history": states}
        finally:
            f.dispose()
    return observed


def check_pause_during_the_wait_replays_after_a_resume():
    f = Fixture()
    try:
        f.start_turn()
        frozen = f.frozen_payload()
        f.wait_then_change("legacy_disable")
        assert len(f.calls) == 1
        f.window["permitted"] = True
        assert f.hooks.pre_llm_call(session_id="warm", turn_id="1", user_message="") is None
        f.clock.advance(0)
        assert len(f.calls) == 2, "the unexpired frozen payload is replayed exactly once"
        assert json.dumps(f.calls[-1]["payload"], sort_keys=True) == frozen, "the replay uses the frozen payload"
        assert f.hooks.settlement_status() == []
        assert f.hooks.settlement_history()[-1]["state"] == "settled"
        return {"completeCalls": 2, "replayed": "frozen payload unchanged"}
    finally:
        f.dispose()


def check_pause_during_the_wait_that_expires_is_retired():
    f = Fixture()
    try:
        f.start_turn()
        f.wait_then_change("pause_then_expire")
        assert len(f.calls) == 1
        f.hooks.set_enabled(True)
        f.clock.advance(0)
        assert len(f.calls) == 1, "an expired settlement is never written late"
        assert f.hooks.settlement_status() == []
        assert f.hooks.settlement_history()[-1]["state"] == "expired"
        return {"completeCalls": 1, "state": "expired"}
    finally:
        f.dispose()


def check_foreground_backoff_respects_the_lifecycle():
    f = Fixture(fail_times=0)
    try:
        original = f.hooks.call
        state = {"prepare_calls": 0}

        def call(op, value):
            if op == "prepare":
                state["prepare_calls"] += 1
                f.window["permitted"] = False      # withdrawn during the backoff
                return {"ok": False, "code": "lock_busy"}
            return original(op, value)

        f.hooks.call = call
        result = f.hooks.pre_llm_call(session_id="foreground", turn_id="1", user_message="请导出金额并排序")
        assert result is None, "no context is invented for a failed recall"
        assert state["prepare_calls"] == 1, "the backoff re-reads the lifecycle instead of retrying"
        return {"prepareCalls": 1, "injected": False}
    finally:
        f.dispose()


def check_native_orderings_still_hold():
    # A background write already inside the boundary, and a foreground boundary held first:
    # both orderings must serialize and still inject on the recovery turn.
    def scenario(foreground_first):
        f = Fixture(fail_times=1)
        try:
            f.start_turn()
            frozen = f.frozen_payload()
            started = threading.Event()
            release = threading.Event()
            original = f.hooks.call

            def call(op, value):
                if op == "complete" and f.state["complete_calls"] >= 1:
                    started.set()
                    release.wait(5)
                return original(op, value)

            f.hooks.call = call
            if foreground_first:
                f.hooks.lock.acquire()
                outcome = []
                worker = threading.Thread(target=lambda: outcome.append(f.hooks.settlement.attempt(("old", "1"))),
                                          name="mse-wait-boundary")
                worker.daemon = True
                worker.start()
                time.sleep(0.2)
                assert len(f.calls) == 1, "the background waits for the held foreground boundary"
                f.hooks.lock.release()
                worker.join(5)
                release.set()
            else:
                f.hooks.lock.acquire()
                worker = threading.Thread(target=lambda: f.hooks.settlement.attempt(("old", "1")),
                                          name="mse-wait-boundary")
                worker.daemon = True
                worker.start()
                assert f.hooks.lock.waiting.wait(5) or started.wait(5)
                f.hooks.lock.release()
                assert started.wait(5), "the background write is in flight"
                resumed = f.hooks.pre_llm_call(session_id="resumed", turn_id="1",
                                               user_message="请导出金额并进行排序")
                assert resumed is not None and "核对数值类型" in resumed["context"], "the recall still happens"
                release.set()
                worker.join(5)
            assert f.calls, "the retry ran"
            assert json.dumps(f.calls[0]["payload"], sort_keys=True) == frozen
            return {"calls": len(f.calls), "foregroundFirst": foreground_first}
        finally:
            release.set()
            f.dispose()
    return {"held": scenario(True), "inFlight": scenario(False)}


run("r3-control-retry-lands-after-the-wait", check_control_retry_lands_after_the_wait)
run("r3-five-invalidations-never-reach-the-core", check_invalidations_never_reach_the_core)
run("r3-pause-during-the-wait-replays-after-resume", check_pause_during_the_wait_replays_after_a_resume)
run("r3-pause-during-the-wait-that-expires-is-retired", check_pause_during_the_wait_that_expires_is_retired)
run("r3-foreground-backoff-respects-the-lifecycle", check_foreground_backoff_respects_the_lifecycle)
run("r3-native-foreground-background-orderings", check_native_orderings_still_hold)

report = {"source": str(root), "schema": "mse-alpha9-fix-checks-v1", "passed": sum(1 for row in results if row["pass"]),
          "failed": sum(1 for row in results if not row["pass"]), "modelCalls": model_calls, "results": results}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(1 if report["failed"] else 0)
