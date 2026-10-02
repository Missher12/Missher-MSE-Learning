"""Hermes event translation only; persistence, matching and attribution live in the Node core."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import threading
import time


# The MSE-owned review envelope and the legacy library-review prompts. A user task
# that merely discusses or develops MSE is not an internal call.
INTERNAL_REVIEW = re.compile(
    r"^(?:\[\[mse-internal-review\]\]|Review the conversation above and "
    r"(?:update the skill library|consider saving to memory))",
    re.I)



# --- Settlement replay -------------------------------------------------------
# Mirrors the DSH side: one frozen `complete` payload per turn, replayed at most
# three times with backoff, never re-running a model, tool, reflection or evaluation.
# Temporary gates: the core answered "not now" and the item keeps its original deadline while it
# waits for the explicit resume. Everything else the core records is terminal.
TEMPORARY_GATE_CODES = frozenset({"settlement_paused", "settlement_guard_refused", "settlement_stale_control"})
TRANSIENT_CODES = frozenset({"lock_busy", "state_unavailable", "session_state_unavailable", "state_busy",
                             "runtime_unavailable", "timeout", "ETIMEDOUT", "EAGAIN", "EBUSY", "transport_error"})
BACKOFF_SECONDS = (0.25, 1.0, 3.0)
# Serialisation between this Hooks instance's background settlement replay and its
# foreground core calls. The background side waits at most this long for the foreground
# boundary and then defers with a transient lock_busy; the foreground never waits on the
# background, so a recovery turn's recall is not lost to a cancelled settlement landing.
SETTLEMENT_LOCK_TIMEOUT = 2.0
# A foreground recall is worth a bounded second chance when the store is transiently busy
# (an out-of-process writer, or a lock held outside this instance). Bounded on purpose:
# no unbounded wait, and a permanent failure still returns no context.
FOREGROUND_RETRY_DELAYS = (0.05, 0.15)
# Exact-stop control. The bound is per stop intent: a repeated host event for the same session
# never resets it, and the original window is what ends it. A confirmed stop leaves the active
# set immediately; an unconfirmed one keeps its barrier and its capacity slot, visibly.
# --- Cross-language session identity -----------------------------------------
# The shared core already defines this rule and it is part of the accepted bytes: `hash` is
# SHA-256 over the UTF-8 bytes of the value, and `identity` validates the value and returns it
# unchanged (`src/index.mjs`), so `sessionHash === sha256(utf8(sessionId))`. The DSH adapter
# matches host session ids with the same rule. An exact stop addressed by a raw id must block the
# restored entries that belong to THAT session, and the only accepted way to know the mapping is
# to compute it with this same rule — never to guess a key.
#
# The core measures the id in UTF-16 code units (`value.length <= 512`), so this side does too,
# and a lone surrogate is encoded the way Node encodes it (U+FFFD) rather than failing.
# The one refusal that names a single session instead of the whole queue: an exact stop whose
# durable confirmation has not landed yet. Everything else refuses globally.
SESSION_SCOPED_REFUSAL = "session_stopped"
IDENTITY_MAX_UNITS = 512
IDENTITY_CONTROL = re.compile("[\u0000-\u001f\u007f]")


def session_identity(value):
    """The core's own `sessionHash` for a raw session id, or None when it is not an id.

    `None` means the core would refuse the value as an identity; it is never a hash of something
    else. `tests/test_hermes.py::IdentityMappingTests` checks this against hashes the REAL core
    produced, including Unicode ids.
    """
    if not isinstance(value, str) or value == "":
        return None
    if len(value.encode("utf-16-le")) // 2 > IDENTITY_MAX_UNITS:
        return None
    if IDENTITY_CONTROL.search(value):
        return None
    try:
        data = value.encode("utf-8")
    except UnicodeEncodeError:
        data = value.encode("utf-8", "surrogatepass").decode("utf-8", "replace").encode("utf-8")
    return hashlib.sha256(data).hexdigest()


STOP_MAX_ATTEMPTS = 3
STOP_CONFIRM_SECONDS = 30.0
STOP_RETRY_DELAYS = (0.25, 1.0)
MAX_PENDING_STOPS = 64
MAX_STOP_HISTORY = 32


class SettlementError(Exception):
    """A settlement failure carrying the core/runtime code used for retry classification."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class SettlementQueue:
    """Bounded, idempotent, in-process replay of frozen settlements. Injectable clock and scheduler."""

    def __init__(self, complete, now=time.monotonic, schedule=None, cancel=None, is_transient=None,
                 max_items=64, max_attempts=4, delays=BACKOFF_SECONDS, max_age_seconds=300.0, on_event=None,
                 max_history=32, permitted=None, interlock=None, lock_timeout=2.0):
        self.complete = complete
        self.now = now
        self.schedule = schedule or (lambda fn, delay: self._timer(fn, delay))
        self.cancel = cancel or (lambda handle: handle.cancel())
        # A temporary gate (paused, host-state refused, stale control generation) is NOT a
        # failure: the core said "not now", the entry keeps its original deadline and attempts,
        # and only an explicit resume may replay it. Classifying it as permanent would retire the
        # item locally while the store still holds it pending.
        self.is_transient = is_transient or (
            lambda error: getattr(error, "code", None) in TRANSIENT_CODES
            or getattr(error, "code", None) in TEMPORARY_GATE_CODES)
        self.max_items = max_items
        self.max_attempts = max_attempts
        self.delays = tuple(delays)
        self.max_age_seconds = max_age_seconds
        self.on_event = on_event or (lambda event: None)
        self.max_history = max_history
        # Re-read immediately before every write. A host that withdraws permission during a
        # quiet period (no new hook call) must not have its old retry land anyway.
        self.permitted = permitted or (lambda: True)
        # The write boundary shared with the foreground writer, resolved on every attempt so
        # a host or test that replaces it before a retry is still honoured. `attempt` holds
        # it while it re-validates the entry AND performs the write, so a state change during
        # a bounded lock wait cannot let a stale settlement through.
        self.interlock = interlock
        self.lock_timeout = lock_timeout
        self.entries = {}
        self.retired = []
        self.timers = {}
        self.generation = 0
        self.paused = False
        self.disposed = False

    @staticmethod
    def _timer(fn, delay):
        timer = threading.Timer(max(delay, 0.0), fn)
        timer.daemon = True
        timer.start()
        return timer

    def size(self):
        return len(self.entries)

    def status(self):
        """Live retry slots only; a terminal state never holds capacity."""
        return [{"key": list(entry["key"]), "sessionId": entry["sessionId"], "turnId": entry["turnId"],
                 "attempts": entry["attempts"], "state": entry["state"], "lastError": entry["lastError"],
                 "sessionHash": entry.get("sessionKey"), "deadline": entry["deadline"],
                 "delivery": entry["delivery"]} for entry in self.entries.values()]

    def history(self):
        """Bounded terminal history, newest last, carrying the same session/turn identity."""
        return [dict(row) for row in self.retired]

    def _retire(self, entry, state):
        self.entries.pop(entry["key"], None)
        record = {"key": list(entry["key"]), "sessionId": entry["sessionId"], "turnId": entry["turnId"],
                  "state": state, "attempts": entry["attempts"], "lastError": entry["lastError"], "at": self.now()}
        self.retired.append(record)
        if len(self.retired) > self.max_history:
            del self.retired[:-self.max_history]
        return record

    @staticmethod
    def deadline_from_receipt(receipt_expires_at, wall_ms, now, max_age_seconds=300.0):
        """Convert a core epoch-millisecond receipt deadline into the queue clock's own unit.

        The core reports `receiptExpiresAt` in epoch milliseconds while this queue may run on
        a monotonic clock; comparing the two scales directly would silently ignore the
        receipt and let a retry outlive it. The age bound always applies.
        """
        limit = now + max_age_seconds
        if isinstance(receipt_expires_at, (int, float)) and not isinstance(receipt_expires_at, bool):
            limit = min(limit, now + max(0.0, receipt_expires_at - wall_ms) / 1000.0)
        return limit

    def _deadline(self, deadline):
        limit = self.now() + self.max_age_seconds
        return min(limit, deadline) if isinstance(deadline, (int, float)) else limit

    def enqueue(self, key, payload, session_id, deadline=None, durable=False, session_key=None):
        if self.disposed:
            return "disposed"
        existing = self.entries.get(key)
        if existing is not None:
            return "duplicate" if existing["payload"] == payload else "conflict"
        if len(self.entries) >= self.max_items:
            self.on_event({"kind": "capacity", "sessionId": session_id, "turnId": payload.get("turnId")})
            return "capacity"
        entry = {"key": key, "sessionId": session_id, "turnId": payload.get("turnId"),
                 "payload": dict(payload), "attempts": 0, "state": "pending", "lastError": None,
                 "queuedAt": self.now(), "deadline": self._deadline(deadline), "delivery": "pending",
                 # The core's own public session identity, when the entry was recovered from the
                 # durable document and has no raw session id of its own. It is what an exact stop
                 # matches on; the adapter never derives or guesses a session hash.
                 "sessionKey": session_key if isinstance(session_key, str) and session_key else None}
        if durable is True:
            # A durable entry's expiry is the CORE's decision, taken in the transaction that holds
            # the pending row. Retiring it here first would leave the store unaware and would let
            # this process report a cleanup that never happened.
            entry["durable"] = True
        self.entries[key] = entry
        return "queued"

    def _allowed(self, entry=None):
        """Latest host permission for THIS entry, without the pause side effect `_active` performs.

        Returns `None` when the entry may write, otherwise a code. The entry is passed through
        because a permission answer can be session-specific: an unconfirmed exact stop blocks THAT
        session's writes and nothing else, so it must never suspend the whole queue. Any other
        refusal (disabled, legacy takeover, disposed, host state unknown) stays global.
        """
        try:
            verdict = self.permitted(entry)
        except Exception:
            return "host_state_unknown"
        if verdict is True or verdict is None:
            return None
        if isinstance(verdict, str) and verdict:
            return verdict
        return "learning_disabled" if verdict is False else "host_state_unknown"

    def attempt(self, key):
        entry = self.entries.get(key)
        if entry is None:
            return {"state": "missing"}
        if self.disposed or self.paused:
            return {"state": entry["state"]}
        refusal = self._allowed(entry)
        if refusal is not None:
            # Permission disappeared while this retry was waiting. The frozen payload and its
            # deadline are kept exactly as they are — never rewritten to cancelled and never
            # re-derived. A refusal that only names THIS session (an unconfirmed exact stop) blocks
            # this entry alone; a global refusal pauses the queue, so only an explicit resume may
            # replay it, and only while it is still unexpired.
            self.on_event({"kind": "blocked", "key": key, "sessionId": entry["sessionId"],
                           "turnId": entry["turnId"], "attempts": entry["attempts"], "code": refusal})
            if refusal == SESSION_SCOPED_REFUSAL:
                return {"state": "blocked", "entry": entry, "code": refusal}
            self.pause()
            return {"state": "paused", "entry": entry}
        now = self.now()
        if now > entry["deadline"] and entry.get("durable") is not True:
            entry["lastError"] = entry["lastError"] or "deadline_exceeded"
            record = self._retire(entry, "expired")
            self.on_event({"kind": "expired", "key": key, "sessionId": entry["sessionId"],
                           "turnId": entry["turnId"], "attempts": entry["attempts"],
                           "code": "deadline_exceeded", "record": record})
            return {"state": "expired", "entry": entry, "record": record}
        # A lifecycle-driven re-read may give an `unconfirmed` entry one more attempt; an automatic
        # retry never reaches here, because the deadline attempt schedules no successor.
        if entry["state"] == "unconfirmed":
            entry["state"] = "pending"
        entry["attempts"] += 1
        try:
            self._enter_write_boundary()
            try:
                refusal = self._revalidate(entry, key)
                if refusal is not None:
                    return self._refused(entry, key, refusal)
                result = self.complete(entry["payload"])
            finally:
                self._leave_write_boundary()
            record = self._retire(entry, "settled")
            self.on_event({"kind": "settled", "key": key, "sessionId": entry["sessionId"],
                           "turnId": entry["turnId"], "attempts": entry["attempts"], "result": result, "record": record})
            return {"state": "settled", "entry": entry, "result": result, "record": record}
        except Exception as error:  # noqa: BLE001 - classification decides whether to retry
            code = getattr(error, "code", None) or "learning_unavailable"
            entry["lastError"] = code
            if not self.is_transient(error):
                # A durable item the core itself ended is recorded with the core's own terminal
                # state: the row already exists in the document, and claiming a different local
                # outcome would either hide a stop or invent a failure.
                terminal = {"settlement_expired": "expired", "settlement_stopped": "stopped"}.get(code, "failed")
                record = self._retire(entry, terminal)
                self.on_event({"kind": "stopped" if terminal == "stopped" else "failed", "key": key,
                               "sessionId": entry["sessionId"], "turnId": entry["turnId"],
                               "attempts": entry["attempts"], "code": code, "record": record})
                return {"state": terminal, "entry": entry, "code": code, "record": record}
            delay = self.delays[min(entry["attempts"] - 1, len(self.delays) - 1)]
            if entry.get("durable") is True:
                # A durable entry is never locally exhausted or expired: the core records the
                # terminal state in the same document that holds the pending row. It is not retried
                # for ever either. The last automatic attempt is placed exactly ON the original
                # deadline, so the store gets its one chance to record `expired` from its own clock;
                # if that attempt still cannot be confirmed (a live writer holds the lock, the
                # runtime is unavailable), automatic scheduling stops with an explicit, honest
                # `unconfirmed` state. The core keeps the record and the original deadline, the next
                # legitimate lifecycle or a restart re-reads it, and the deadline is never refreshed.
                after = self.now()
                if after >= entry["deadline"]:
                    entry["state"] = "unconfirmed"
                    self.on_event({"kind": "unconfirmed", "key": key, "sessionId": entry["sessionId"],
                                   "turnId": entry["turnId"], "attempts": entry["attempts"], "code": code,
                                   "deadline": entry["deadline"]})
                    return {"state": "unconfirmed", "entry": entry, "code": code}
                self._schedule(entry, entry["deadline"] - after if after + delay > entry["deadline"]
                               else delay)
                return {"state": "retrying", "entry": entry, "code": code}
            bound = entry.get("maxAttempts", self.max_attempts)
            if entry["attempts"] >= bound or now + delay > entry["deadline"]:
                record = self._retire(entry, "exhausted")
                self.on_event({"kind": "exhausted", "key": key, "sessionId": entry["sessionId"],
                               "turnId": entry["turnId"], "attempts": entry["attempts"], "code": code, "record": record})
                return {"state": "exhausted", "entry": entry, "code": code, "record": record}
            self._schedule(entry, delay)
            return {"state": "retrying", "entry": entry, "code": code}

    def _enter_write_boundary(self):
        """Acquire the shared write boundary; a bounded wait reports transient contention."""
        if self.interlock is None:
            return
        boundary = self.interlock() if callable(self.interlock) else self.interlock
        if boundary is None or boundary.acquire(timeout=self.lock_timeout):
            return
        raise SettlementError("lock_busy")

    def _leave_write_boundary(self):
        if self.interlock is None:
            return
        boundary = self.interlock() if callable(self.interlock) else self.interlock
        if boundary is not None:
            boundary.release()

    def _revalidate(self, entry, key):
        """Re-check, under the write boundary, that this frozen payload may still be written.

        Everything here can change while a retry waits for the boundary: the queue may be
        paused or disposed, the session may be closed (which retires this entry), permission
        may be withdrawn, the entry may have been replaced by a later one under the same key,
        or the deadline may have passed. The check runs against the CURRENT state, and the
        write that follows uses the same serialization boundary — never the state sampled
        before the wait.
        """
        if self.disposed:
            return "retired"
        if self.entries.get(key) is not entry:
            return "retired"
        if self.paused:
            return "learning_disabled"
        refusal = self._allowed(entry)
        if refusal is not None:
            return refusal
        # A durable entry is retired by the CORE, inside the transaction that holds its pending
        # row. Expiring it here would clear only the local copy and leave the store pending for
        # ever — the exact failure this bound exists to prevent. The attempt still runs, and the
        # core answers `settlement_expired` from its own clock.
        if self.now() > entry["deadline"] and entry.get("durable") is not True:
            return "expired"
        return None

    def _refused(self, entry, key, refusal):
        """Apply the original contract to a write that became invalid while it waited.

        A refused write never counts as an attempt, is never reported as settled, and is
        never retired twice: `pause` keeps the frozen payload for a legitimate resume,
        while a session that was closed (or a disposed queue) is already terminal.
        """
        entry["attempts"] = max(0, entry["attempts"] - 1)
        if refusal == "retired":
            return {"state": "retired", "entry": entry}
        if refusal == "expired":
            entry["lastError"] = entry["lastError"] or "deadline_exceeded"
            record = self._retire(entry, "expired")
            self.on_event({"kind": "expired", "key": key, "sessionId": entry["sessionId"],
                           "turnId": entry["turnId"], "attempts": entry["attempts"],
                           "code": "deadline_exceeded", "record": record})
            return {"state": "expired", "entry": entry, "record": record}
        entry["lastError"] = refusal
        self.on_event({"kind": "blocked", "key": key, "sessionId": entry["sessionId"],
                       "turnId": entry["turnId"], "attempts": entry["attempts"], "code": refusal})
        if refusal == SESSION_SCOPED_REFUSAL:
            # Only this session is stopped; every other session keeps its timers and its work.
            return {"state": "blocked", "entry": entry, "code": refusal}
        self.pause()
        return {"state": "paused", "entry": entry}

    def _schedule(self, entry, delay):
        generation = self.generation
        key = entry["key"]

        def fire():
            self.timers.pop(key, None)
            if generation != self.generation or self.disposed or self.paused:
                return
            self.attempt(key)

        self.timers[key] = self.schedule(fire, delay)

    def pause(self):
        if self.disposed:
            return
        self.generation += 1
        self.paused = True
        for handle in self.timers.values():
            self.cancel(handle)
        self.timers.clear()

    def resume(self):
        """Resume after an explicit pause: replay pending entries, and give a durable
        `unconfirmed` entry its one further read of the core (which is what retires it if its
        deadline has passed). Scheduling stays bounded because a failing deadline attempt
        schedules no successor."""
        if self.disposed or not self.paused:
            return
        self.paused = False
        now = self.now()
        for key, entry in list(self.entries.items()):
            if entry["state"] not in ("pending", "unconfirmed"):
                continue
            # Same rule as `attempt`: a durable entry is retried so the CORE can retire it.
            if now > entry["deadline"] and entry.get("durable") is not True:
                record = self._retire(entry, "expired")
                self.on_event({"kind": "expired", "key": key, "sessionId": entry["sessionId"],
                               "turnId": entry["turnId"], "attempts": entry["attempts"],
                               "code": "deadline_exceeded", "record": record})
                continue
            self._schedule(entry, 0)

    def hold_session(self, session_id=None, session_hash=None, entry_key=None):
        """Cancel exactly one session's scheduled retries WITHOUT retiring its entries.

        An unconfirmed exact stop means "this session may not write yet"; it does not mean the item
        is finished. The entries keep their frozen payload, their deadline and their place in the
        status view, no timer of theirs can fire, and every other session keeps its own timers.
        """
        if session_id is None and session_hash is None and entry_key is None:
            return []
        held = []
        for key, entry in list(self.entries.items()):
            exact = (session_id is not None and entry.get("sessionId") == session_id) or \
                    (session_hash is not None and entry.get("sessionKey") == session_hash) or \
                    (entry_key is not None and key == entry_key)
            if not exact:
                continue
            handle = self.timers.pop(key, None)
            if handle is not None:
                self.cancel(handle)
            held.append(key)
        return held

    def stop_session(self, session_id=None, session_hash=None, entry_key=None):
        """Retire only the entries whose identity is EXACTLY this session.

        The raw session id, the core's own public session hash, or the acknowledged entry key
        identifies it. A call with none of them identifies nothing: `stop_session(None)` must never
        be read as "every restored entry", which is how one session's unconfirmed stop used to
        freeze a whole queue.
        """
        if session_id is None and session_hash is None and entry_key is None:
            return []
        stopped = []
        for key, entry in list(self.entries.items()):
            exact = (session_id is not None and entry.get("sessionId") == session_id) or \
                    (session_hash is not None and entry.get("sessionKey") == session_hash) or \
                    (entry_key is not None and key == entry_key)
            if not exact:
                continue
            handle = self.timers.pop(key, None)
            if handle is not None:
                self.cancel(handle)
            stopped.append(key)
            record = self._retire(entry, "stopped")
            self.on_event({"kind": "stopped", "key": key, "sessionId": entry.get("sessionId"),
                           "turnId": entry["turnId"], "attempts": entry["attempts"], "record": record})
        return stopped

    def dispose(self):
        self.generation += 1
        for handle in self.timers.values():
            self.cancel(handle)
        self.timers.clear()
        self.disposed = True


def _bounded_env(name, default, maximum):
    value = os.environ.get(name, str(default))
    return int(value) if value.isascii() and value.isdigit() and len(value) <= 7 and int(value) <= maximum else default


class Hooks:
    def __init__(self, config=None, call=None, review=None, enabled=None):
        self.config = config or {
            "stateRoot": str(Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser() / "mse-learning"),
            "adapterId": "hermes", "maxContextBytes": 768,
        }
        self.config = dict(self.config)
        self.config.setdefault("evaluationTokensPerDay", _bounded_env("MSE_EVALUATION_TOKENS_PER_DAY", 0, 1000000))
        self.config.setdefault("evaluationCallsPerDay", _bounded_env("MSE_EVALUATION_CALLS_PER_DAY", 2, 8))
        self.call = call or self._call
        self.turns = {}
        self.settlement_events = []
        self.children = set()
        # Local control intent, published BEFORE any lock that can wait, so a pause or an exact
        # stop taking effect cannot be hidden behind a queue waiting for the same lock. It is an
        # intent, not an acknowledgement: durable confirmation only comes from the core's control
        # transaction, and a failure is recorded rather than reported as success.
        #
        # `control_lock` is a LEAF lock: it is only ever held for a few attribute reads/writes,
        # never across a core call, a timer wait or `self.lock`. That is what lets the stop intent
        # become visible while another thread holds the heavy write boundary.
        self.control_lock = threading.Lock()
        self.local_control_pending = set()
        # Unconfirmed exact stops only, keyed by identity: ("session", rawId) or ("entry", ackKey).
        # A confirmed stop leaves this map immediately, so successes never accumulate.
        self.pending_stops = {}
        self.stop_history = []
        self.stop_capacity_refusals = 0
        self.max_pending_stops = MAX_PENDING_STOPS
        self.max_stop_attempts = STOP_MAX_ATTEMPTS
        self.stop_confirm_seconds = STOP_CONFIRM_SECONDS
        self.control_errors = []
        # Observable control/recovery facts: a durable control change is only "confirmed" once the
        # core's own transaction committed, and a failure says so instead of claiming success.
        self.control = {"userPaused": None, "confirmed": None, "error": None, "generation": None}
        self.recovery = None
        # Counts real lifecycle attempts; only a confirmed durable read stops trying. Never
        # touched by construction or by a read-only status call.
        self.recovery_attempted = 0
        self.lock = threading.RLock()
        self.review = review or self._review
        self.reviewing = False
        self.enabled = enabled or (lambda: True)
        self.closed = False
        self.generation = 0
        self.running = True
        self.jobs = []
        # Wall clock used only to convert the core's epoch-millisecond receipt deadline into
        # this queue's monotonic seconds. Injectable for clock-controlled tests.
        self.wall_ms = getattr(self, 'wall_ms', None) or (lambda: time.time() * 1000.0)
        self.settlement = SettlementQueue(self._settle_payload, now=getattr(self, 'monotonic', time.monotonic),
                                          schedule=getattr(self, 'schedule', None), cancel=getattr(self, 'cancel', None),
                                          on_event=self._on_settlement_event, permitted=self._permitted,
                                          interlock=self._write_boundary, lock_timeout=SETTLEMENT_LOCK_TIMEOUT)
        self.capabilities = {"requestAdoption": "post_api_request_success", "providerWireEvidence": False,
                             "trustedLessonChecks": True, "artifactChecks": True,
                             "reflectionCancellation": "result_discard", "boundedSettlementRetry": True}

    def _write_boundary(self):
        """The lock shared by this instance's foreground and background core calls.

        Resolved on every attempt rather than captured once, so replacing `self.lock` (a test
        or a host wrapper) before a retry is honoured. The queue holds it across its final
        validity check and the write itself (see `SettlementQueue.attempt`).
        """
        return self.lock

    def _durable(self, op, value):
        """One trusted local core call, with a transport failure surfaced as a retryable code."""
        try:
            result = self.call(op, dict(value))
        except Exception as error:  # noqa: BLE001 - a missing runtime is retryable, never a success
            raise SettlementError(getattr(error, "code", None) or "runtime_unavailable")
        if not isinstance(result, dict):
            raise SettlementError("invalid_runtime_response")
        return result

    def _settle_payload(self, payload):
        """Apply one frozen settlement through the durable core; never re-runs model work.

        Two steps, in this order: obtain the durable acknowledgement, then apply the handle it
        returned. An item that has not been acknowledged yet retries the ENQUEUE only — a refusal
        from the core (paused, stopped, conflicting, changed receipt) is never bypassed with a
        direct completion, because that is exactly the control the durable path exists to keep.
        """
        frozen = {name: value for name, value in payload.items() if not name.startswith("_")}
        handle = payload.get("_durable")
        if handle is None:
            ack = self._durable("settlementEnqueue", frozen)
            if ack.get("ok") is not True:
                raise SettlementError(ack.get("code") or "learning_unavailable")
            handle = {"key": ack.get("key"), "payloadHash": ack.get("payloadHash")}
            # Remember the handle on the queue entry, so every later attempt replays the SAME
            # acknowledged settlement instead of enqueueing a second one.
            entry = self.settlement.entries.get(payload.get("_key"))
            if entry is not None:
                entry["payload"]["_durable"] = dict(handle)
                # From this moment the store owns the settlement: its deadline, its attempts and
                # its terminal state all live in the acknowledged record. Retiring the local copy
                # instead would leave the store pending for ever.
                entry["durable"] = True
        # The generation is read immediately before the write, inside the same boundary the queue
        # holds, so a pause or a stop that committed while this attempt waited is seen here.
        status = self._durable("settlementStatus", {})
        generation = (status.get("control") or {}).get("generation")
        if not isinstance(generation, int):
            raise SettlementError("runtime_unavailable")
        result = self._durable("settlementApply", {"key": handle.get("key"),
                                                   "payloadHash": handle.get("payloadHash"),
                                                   "generation": generation})
        if result.get("ok") is True:
            terminal = result.get("terminal")
            if isinstance(terminal, str) and terminal in {"expired", "stopped", "failed", "conflict"}:
                # The core had already retired this item. Its own terminal state is the fact here,
                # and reporting it as a fresh settlement would claim an outcome — and a credit —
                # the document never recorded.
                raise SettlementError("settlement_%s" % terminal)
            return result
        code = result.get("code") or "learning_unavailable"
        # A temporary gate keeps its original deadline and waits for the explicit resume; a
        # terminal answer has already been recorded by the core and must stop here.
        raise SettlementError(code)

    def recover_settlements(self):
        """Re-drive the pending settlements this process did not acknowledge.

        Only the durable file is used: no memory from a previous process, and no prepare, accept,
        model, tool, reflection or evaluation is replayed. The original deadline travels with the
        entry, so a restart continues the same window instead of a fresh one.
        """
        status = self._durable("settlementStatus", {})
        if status.get("ok") is not True:
            return {"ok": False, "code": status.get("code") or "store_failure", "restored": 0}
        restored = 0
        for entry in status.get("pending") or []:
            key = entry.get("key")
            handle = {"key": key, "payloadHash": entry.get("payloadHash")}
            remaining = max(0.0, (float(entry.get("deadline", 0)) - float(self.wall_ms())) / 1000.0)
            deadline = self.settlement.now() + remaining
            # The core's own public session hash travels with the restored entry: it is the only
            # identity an entry without a raw session id has, and an exact stop matches on it.
            # It is read from the document, never derived here.
            state = self.settlement.enqueue(key, {"_durable": dict(handle), "_key": key}, None,
                                            deadline=deadline, durable=True,
                                            session_key=entry.get("sessionHash"))
            if state not in {"queued", "duplicate"}:
                continue
            if self.settlement.attempt(key).get("state") == "settled":
                restored += 1
        self.recovery = {"at": self.wall_ms(), "restored": restored,
                         "pending": len(status.get("pending") or []),
                         "expired": (status.get("counts") or {}).get("expired", 0)}
        return {"ok": True, "restored": restored, "pending": len(status.get("pending") or [])}

    def durable_status(self):
        """The durable queue as the core sees it, plus this process's control/recovery facts."""
        status = self._durable("settlementStatus", {})
        with self.control_lock:
            local = sorted(self.local_control_pending)
            stops = [{"identity": list(key), "sessionId": record["sessionId"], "reason": record["reason"],
                      "confirmed": record["confirmed"], "state": record["state"], "attempts": record["attempts"],
                      "deadline": record["deadline"], "error": record["error"]}
                     for key, record in self.pending_stops.items()]
            history = [dict(row) for row in self.stop_history]
            refusals = self.stop_capacity_refusals
        return {"core": status, "control": self.control, "recovery": self.recovery,
                "localPending": local, "unconfirmedStops": stops, "stopHistory": history,
                "stopCapacityRefusals": refusals}

    def _on_settlement_event(self, event):
        self.settlement_events.append(event)
        if len(self.settlement_events) > 64:
            del self.settlement_events[:-64]

    def _foreground_call(self, op, value):
        """One foreground core call, with a bounded retry for a transiently busy store.

        `prepare` is idempotent for the same turn and query, so repeating it after a
        transient `lock_busy` cannot double-learn or double-charge a receipt. The backoff
        re-reads the same lifecycle boundary as the background path: a host that withdraws
        permission or unloads during the short wait ends the retries instead of issuing
        another core call. A permanent failure is returned as-is: the hook injects nothing.
        """
        result = self.call(op, value)
        for delay in FOREGROUND_RETRY_DELAYS:
            if result.get("ok") is True or result.get("code") not in TRANSIENT_CODES:
                return result
            if self._permitted() is not None:
                return result
            time.sleep(delay)
            if self._permitted() is not None:
                return result
            result = self.call(op, value)
        return result

    def settlement_status(self):
        return self.settlement.status()

    def settlement_history(self):
        return self.settlement.history()

    def _settlement_deadline(self, receipt_expires_at):
        """Core epoch-millisecond receipt deadline expressed on the queue's own clock."""
        return SettlementQueue.deadline_from_receipt(receipt_expires_at, self.wall_ms(), self.settlement.now(),
                                                    self.settlement.max_age_seconds)

    def _settle_cancelled(self, ids, row):
        """Freeze the cancelled outcome for one turn; an already frozen outcome is never rewritten."""
        payload = dict(row["base"], outcome="cancelled", _key=ids)
        queued = self.settlement.enqueue(ids, payload, row["base"]["sessionId"],
                                         deadline=self._settlement_deadline(row.get("receipt_expires_at")))
        if queued in {"queued", "duplicate"}:
            self.settlement.attempt(ids)
        return queued

    def _call(self, op, value):
        node = os.environ.get("MSE_NODE_EXECUTABLE") or shutil.which("node")
        cli = os.environ.get("MSE_LEARN_CLI") or str(Path(__file__).parent / "runtime" / "src" / "cli.mjs")
        if not node or not cli or not Path(cli).is_absolute() or not Path(cli).is_file():
            return {"ok": False, "code": "runtime_unavailable"}
        try:
            result = subprocess.run([node, cli], input=json.dumps({"config": self.config, "op": op, "input": value}),
                                    text=True, capture_output=True, timeout=2, check=False)
            if len(result.stdout) > 8192:
                return {"ok": False, "code": "invalid_runtime_response"}
            return json.loads(result.stdout)
        except Exception:
            return {"ok": False, "code": "runtime_unavailable"}

    @staticmethod
    def _ids(kwargs):
        session, turn = kwargs.get("session_id"), kwargs.get("turn_id")
        if not isinstance(session, str) or not session or len(session) > 512:
            return None
        if not isinstance(turn, (str, int)) or not str(turn) or len(str(turn)) > 512:
            return None
        return session, str(turn)

    def _permitted(self, entry=None):
        """The host's latest permission for this entry, read without `_active`'s pause side effect.

        The settlement queue calls this immediately before every write, so a host that withdraws
        permission while no hook is firing still cannot have an old retry land.

        Returns `None` when the entry may write, else a code. Scope is deliberate: a user pause is
        global, while an unconfirmed exact stop blocks ONLY the session it names — by the raw id,
        by the core's own `sessionHash` (computed with the shared identity rule for a raw-id stop,
        read from the document for a restored entry), or by the acknowledged entry a handle
        addresses. One session's failed stop must never suspend every other session's learning.
        """
        try:
            with self.control_lock:
                if "pause" in self.local_control_pending:
                    return "learning_disabled"
                if entry is not None and self.pending_stops:
                    session = entry.get("sessionId")
                    session_hash = entry.get("sessionKey")
                    key = entry.get("key")
                    for record in self.pending_stops.values():
                        if record["confirmed"]:
                            continue
                        if session is not None and record["sessionId"] == session:
                            return SESSION_SCOPED_REFUSAL
                        if session_hash is not None and record.get("sessionHash") == session_hash:
                            return SESSION_SCOPED_REFUSAL
                        # A stop addressed by an acknowledged entry names that entry exactly, so
                        # its barrier is precise without any identity mapping.
                        handle = record.get("handle")
                        if handle is not None and key == handle.get("key"):
                            return SESSION_SCOPED_REFUSAL
            if self.closed or not self.running:
                return "learning_disabled"
            return None if self.enabled() else "learning_disabled"
        except Exception:
            return "learning_disabled"

    def _active(self, generation=None):
        active = not self.closed and self.running and self.enabled()
        if not active:
            # A legacy controller taking over returns False here exactly like an explicit
            # pause, so the settlement queue must stop with it instead of retrying on.
            self.cancel_pending()
            self.settlement.pause()
        elif self.settlement.paused and self.running and not self.closed:
            # Permission recovered: only unexpired local `complete` replays resume.
            self.settlement.resume()
        return active and (generation is None or generation == self.generation)

    def set_enabled(self, enabled):
        """Pause or resume learning AND persist the matching settlement control.

        The intent is registered before the heavy lock, so a queue waiting for it already sees the
        barrier. The durable control transaction is what turns the request into a confirmation:
        until the core commits, the state says `confirmed: False` with its cause, and the read-only
        surfaces report exactly that rather than an effective pause.
        """
        paused = enabled is not True
        if paused:
            # Leaf lock only: the intent is visible to a queue waiting on the write boundary
            # before this call takes that boundary.
            with self.control_lock:
                self.local_control_pending.add("pause")
        try:
            with self.lock:
                if self.running != (enabled is True):
                    self.generation += 1
                self.running = enabled is True and not self.closed
                if self.running:
                    # Only unexpired replays resume; no review or evaluation restarts.
                    self.settlement.resume()
                else:
                    self.settlement.pause()
                    self.cancel_pending()
            result = self._durable("settlementPause", {"paused": paused})
            confirmed = result.get("ok") is True
            self.control = {"userPaused": paused, "confirmed": confirmed,
                            "error": None if confirmed else (result.get("code") or "control_failed"),
                            "generation": result.get("generation")}
            if not confirmed:
                self.control_errors.append({"reason": "settlementPause",
                                            "code": self.control["error"]})
                del self.control_errors[:-8]
            return self.control
        except SettlementError as error:
            self.control = {"userPaused": paused, "confirmed": False, "error": error.code,
                            "generation": self.control.get("generation")}
            self.control_errors.append({"reason": "settlementPause", "code": error.code})
            del self.control_errors[:-8]
            return self.control
        finally:
            if paused:
                with self.control_lock:
                    self.local_control_pending.discard("pause")

    def pre_llm_call(self, **kwargs):
        try:
            if not self._active():
                return None
            # The real recovery entry point. The constructor and every read-only status call stay
            # side-effect free; a turn that is actually starting is the explicit lifecycle moment
            # at which acknowledged-but-unfinished settlements are re-driven from the durable file
            # alone. Config and legacy presence are already settled by `_active()` above.
            # A stop that never reached the core keeps its barrier and is retried here, still
            # bounded by its own original attempts and deadline.
            for intent in list(self.pending_stops):
                if not self.pending_stops[intent]["confirmed"]:
                    self.confirm_stop(intent)
            if self.recovery_attempted < 3:
                attempt = self.recovery_attempted
                self.recovery_attempted = attempt + 1
                try:
                    result = self.recover_settlements()
                    if result.get("ok") is True:
                        # Only a confirmed read of the durable file ends the recovery phase.
                        self.recovery_attempted = 3
                    else:
                        self.recovery = {"at": self.wall_ms(), "restored": 0, "pending": None,
                                         "error": result.get("code") or "store_failure"}
                except SettlementError as error:
                    # A failure keeps its exact cause and stays eligible for the next real
                    # lifecycle moment; the original deadlines are untouched.
                    self.recovery = {"at": self.wall_ms(), "restored": 0, "pending": None,
                                     "error": error.code}
            else:
                # The recovery phase above re-drives pending rows from the durable file, so it
                # already covers an unconfirmed item while it lasts. Afterwards, an acknowledged
                # item whose deadline attempt could not be confirmed gets exactly one more read of
                # the core per legitimate lifecycle moment: no successor is scheduled, the
                # original deadline is never refreshed, and a read-only status never comes here.
                for key, row in list(self.settlement.entries.items()):
                    if row.get("durable") is True and row["state"] == "unconfirmed":
                        self.settlement.attempt(key)
            ids = self._ids(kwargs)
            prompt = kwargs.get("user_message", kwargs.get("prompt"))
            if not ids or not isinstance(prompt, str) or len(prompt) > 32768 or not prompt.strip():
                return None
            if (ids[0] in self.children or kwargs.get("platform") in {"cron", "heartbeat", "diagnostic"}
                    or ids[0].startswith(("cron_", "heartbeat_", "diagnostic_"))
                    or any(os.environ.get(k, "").lower() in {"1", "true", "yes"} for k in ("HERMES_CRON_SESSION", "HERMES_MSE_INTERNAL"))
                    or kwargs.get("parent_session_id")
                    or INTERNAL_REVIEW.match(prompt.strip())):
                # Only a trusted internal marker pauses learning; a normal task that merely
                # mentions the product name is still learned from.
                return None
            with self.lock:
                if not self._active():
                    return None
                now = time.monotonic()
                self.turns = {key: row for key, row in self.turns.items() if now - row["created"] < 1800}
                if ids in self.turns or len(self.turns) >= 256:
                    return None
                # One stable environment identity, carried by record, reflection, evaluation
                # and recall alike. It stays the core default unless explicitly configured,
                # so methods recorded by an older version keep their identity.
                base = {"sessionId": ids[0], "turnId": ids[1]}
                environment = self.config.get("environmentId") or os.environ.get("HERMES_MSE_ENVIRONMENT")
                if environment:
                    base["environmentId"] = environment
                project = kwargs.get("project_key") or kwargs.get("projectKey") or os.environ.get("HERMES_MSE_PROJECT_KEY")
                if project:
                    base["projectKey"] = project
                result = self._foreground_call("prepare", dict(base, prompt=prompt, origin="user"))
                if result.get("ok") is not True:
                    return None
                context = result.get("context", "")
                if not isinstance(context, str) or len(context.encode("utf-8")) > self.config["maxContextBytes"]:
                    return None
                self.turns[ids] = {"base": base, "receipt": result.get("receipt"),
                                   "receipt_expires_at": result.get("receiptExpiresAt"),
                                   "lessons": result.get("lessons", []),
                                   "context": context, "request": None, "accepted": False, "task_failed": False,
                                   "lesson_versions": result.get("lessonVersions", []), "checks": {}, "generation": self.generation,
                                   "created": now, "prompt_hash": hashlib.sha256(prompt.encode()).hexdigest(), "prompt_size": len(prompt),
                                   "task_summary": prompt[:800], "result_summary": "", "model": kwargs.get("model"), "tools": 0}
                return {"context": context} if context else None
        except Exception:
            return None

    def pre_api_request(self, **kwargs):
        with self.lock:
            if not self._active():
                return
            row = self.turns.get(self._ids(kwargs))
            if not row or not row["receipt"] or row["accepted"]:
                return
            messages = kwargs.get("request_messages") or []
            user = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), {})
            text = user.get("content")
            if isinstance(text, list):
                text = "\n".join(p.get("text", "") for p in text if isinstance(p, dict)
                                 and p.get("type") in {"text", "input_text"} and isinstance(p.get("text"), str))
            n = row["prompt_size"]
            matched = (isinstance(text, str) and len(text) <= 131072
                       and hashlib.sha256(text[:n].encode()).hexdigest() == row["prompt_hash"]
                       and text[n:n + 2] == "\n\n" and row["context"] in text[n + 2:])
            request = kwargs.get("api_request_id")
            row["request"] = request if matched and isinstance(request, str) and 0 < len(request) <= 512 else None

    def post_api_request(self, **kwargs):
        with self.lock:
            if not self._active():
                return
            row = self.turns.get(self._ids(kwargs))
            if not row or row["accepted"] or not row["request"] or row["request"] != kwargs.get("api_request_id"):
                return
            if kwargs.get("failed") or kwargs.get("error") or kwargs.get("interrupted"):
                return
            result = self.call("accept", {"receipt": row["receipt"], "lessonIds": row["lessons"]})
            row["accepted"] = result.get("ok") is True

    def post_tool_call(self, **kwargs):
        with self.lock:
            if not self._active():
                return
            row = self.turns.get(self._ids(kwargs))
            if not row:
                return
            row["tools"] += 1
            failed = bool(kwargs.get("error") or kwargs.get("failed") or kwargs.get("success") is False
                          or kwargs.get("status") in {"error", "failed", "cancelled", "timeout"})
            # Only trusted host metadata can mark a tool read-only. Unknown writes invalidate checks.
            if kwargs.get("read_only") is not True or failed:
                row["checks"].clear()
            row["task_failed"] = row["task_failed"] or failed

    def verification(self, session_id, turn_id, check_id, passed, lesson_ids=None, expected_version=None):
        """Trusted checker callback; deliberately not registered as an Agent tool."""
        with self.lock:
            row = self.turns.get((session_id, str(turn_id)))
            if (not row or not row["accepted"] or not self._active(row["generation"])
                    or not isinstance(check_id, str) or not check_id or len(check_id) > 256
                    or type(passed) is not bool or not isinstance(lesson_ids, list) or not lesson_ids
                    or any(not isinstance(value, str) for value in lesson_ids)
                    or len(set(lesson_ids)) != len(lesson_ids)
                    or any(value not in row["lessons"] for value in lesson_ids)):
                return False
            versions = [next((item for item in row["lesson_versions"] if item.get("id") == lesson), None)
                        for lesson in lesson_ids]
            if any(item is None or (expected_version is not None and item["version"] != expected_version)
                   or (item.get("methodId") and (expected_version is None or item.get("checkId") != check_id)) for item in versions):
                return False
            for item in versions:
                row["checks"][item["id"]] = {"lessonId": item["id"], "passed": passed,
                                               "version": item["version"], "checkId": check_id}
            row["check_id"] = check_id
            return True

    def verify_artifact(self, session_id, turn_id, lesson_id, source, artifact):
        with self.lock:
            row = self.turns.get((session_id, str(turn_id)))
            if not row or not row["accepted"] or not self._active(row["generation"]) or lesson_id not in row["lessons"]:
                return {"ok": False, "code": "lesson_not_adopted"}
            value = {"lessonId": lesson_id, "source": source, "artifact": artifact}
            if row["base"].get("projectKey"):
                value["projectKey"] = row["base"]["projectKey"]
            version = next((item.get("version") for item in row["lesson_versions"] if item.get("id") == lesson_id), None)
            if version is not None:
                value["expectedVersion"] = version
            result = self.call("checkArtifact", value)
            if result.get("ok") and result.get("status") in {"pass", "fail"}:
                self.verification(session_id, turn_id, result.get("checkId"), result["status"] == "pass", [lesson_id], result.get("version"))
            return result

    def post_llm_call(self, **kwargs):
        with self.lock:
            if not self._active():
                return
            ids = self._ids(kwargs)
            row = self.turns.get(ids)
            if row and isinstance(kwargs.get("assistant_response"), str):
                row["result_summary"] = kwargs["assistant_response"][:1200]
            if not row or not (kwargs.get("completed") is True or kwargs.get("failed") or kwargs.get("interrupted")):
                return
            row["task_failed"] = row["task_failed"] or bool(kwargs.get("failed"))
            checks = list(row["checks"].values())
            outcome = ("cancelled" if kwargs.get("interrupted") else "failed" if any(not item["passed"] for item in checks)
                       else "verified" if checks else "unknown")
            evidence = ({"evidence": {"source": "host_verifier", "checkId": row["check_id"],
                                      "lessonIds": list(row["checks"]), "checks": checks}}
                        if checks and outcome != "cancelled" else {})
            payload = dict(row["base"], outcome=outcome, _key=ids, **evidence)
            queued = self.settlement.enqueue(ids, payload, row["base"]["sessionId"],
                                             deadline=self._settlement_deadline(row.get("receipt_expires_at")))
            attempt = self.settlement.attempt(ids) if queued in {"queued", "duplicate"} else {"state": queued}
            # A retry only replays `complete`; the turn's own review stays a single original job.
            if attempt.get("state") in {"settled", "retrying", "duplicate"}:
                self.turns.pop(ids, None)
                if (outcome != "cancelled" and (checks or row["task_failed"] or row["tools"] >= 2)
                        and row["result_summary"] and not self.reviewing
                        and os.environ.get("MSE_REFLECTION_ENABLED", "1") != "0"):
                    self.reviewing = True
                    job = {"generation": self.generation, "session": row["base"]["sessionId"],
                           "cancel": threading.Event(), "ticket": None}
                    self.jobs.append(job)
                    review_outcome = "failed" if row["task_failed"] else outcome
                    threading.Thread(target=self._reflect, args=(row, review_outcome, job), daemon=True).start()

    def _reflect(self, row, outcome, job=None):
        job = job or {"generation": self.generation, "session": row["base"]["sessionId"],
                      "cancel": threading.Event(), "ticket": None}
        try:
            with self.lock:
                if job["cancel"].is_set() or not self._active(job["generation"]):
                    return
                if job not in self.jobs:
                    self.jobs.append(job)
                prepared = self.call("reflectionRequest", dict(row["base"], taskSummary=row["task_summary"],
                                     resultSummary=row["result_summary"], outcome="supported" if outcome == "unknown" else outcome))
                job["ticket"] = prepared.get("ticket")
                if not job["ticket"] or job["cancel"].is_set() or not self._active(job["generation"]):
                    return
            text = self.review(prepared["request"], row["model"], job["cancel"])
            if not isinstance(text, str) or len(text.encode("utf-8")) > 2048:
                return
            value = json.loads(text)
            with self.lock:
                if job["cancel"].is_set() or not self._active(job["generation"]):
                    return
                self.call("reflectionResult", {"ticket": job["ticket"], "result": value})
        except Exception:
            pass
        finally:
            with self.lock:
                if job.get("ticket"):
                    self.call("reflectionCancel", {"ticket": job["ticket"]})
                if job in self.jobs:
                    self.jobs.remove(job)
                self.reviewing = bool(self.jobs)

    @staticmethod
    def _review(request, task_model, cancel_event=None):
        if cancel_event is not None and cancel_event.is_set():
            return None
        # Reuse Hermes's configured route; an unknown session override degrades to no reflection.
        from hermes_cli.config import load_config_readonly
        from hermes_cli.runtime_provider import resolve_runtime_provider
        from agent.auxiliary_client import call_llm
        from hermes_constants import resolve_reasoning_config
        config = load_config_readonly()
        model_config = config.get("model", {})
        raw_model = model_config if isinstance(model_config, str) else model_config.get("default", model_config.get("model"))
        from hermes_cli.config import split_model_config_default
        model, default_provider = split_model_config_default(raw_model)
        if not isinstance(task_model, str) or model != task_model:
            return None
        provider = (model_config.get("provider") if isinstance(model_config, dict) else None) or default_provider or None
        route = resolve_runtime_provider(requested=provider, target_model=model)
        response = call_llm(task=None, provider=route["provider"], model=model,
                           api_key=route.get("api_key"), base_url=route.get("base_url"), api_mode=route.get("api_mode"),
                           reasoning_config=resolve_reasoning_config(config, model),
                           tools=None, timeout=60.0, max_tokens=request["maxTokens"],
                           messages=[{"role": "system", "content": request["system"]}, {"role": "user", "content": request["text"]}])
        if cancel_event is not None and cancel_event.is_set():
            return None
        choices = getattr(response, "choices", [])
        if len(choices) != 1 or getattr(choices[0].message, "tool_calls", None):
            return None
        return getattr(choices[0].message, "content", None)

    def on_session_end(self, **kwargs):
        ids = self._ids(kwargs)
        if ids and ("completed" in kwargs or "failed" in kwargs or "interrupted" in kwargs):
            # Hermes fires on_session_end once per turn with authoritative completion flags.
            self.post_llm_call(**kwargs)
            if kwargs.get("completed") is not True and not kwargs.get("failed") and not kwargs.get("interrupted"):
                self.post_llm_call(**dict(kwargs, interrupted=True))
            return
        with self.lock:
            for job in self.jobs:
                if job["session"] == kwargs.get("session_id"):
                    job["cancel"].set()
                    if job.get("ticket"):
                        self.call("reflectionCancel", {"ticket": job["ticket"]})
            for ids, row in list(self.turns.items()):
                if ids[0] == kwargs.get("session_id"):
                    self._settle_cancelled(ids, row)
                    self.turns.pop(ids, None)

    def on_session_finalize(self, **kwargs):
        """The Host's own session-boundary notification.

        The CLI rotates its session id in `new_session`: it first announces the OLD id with
        `platform="cli", reason="session_boundary"`, and only then rotates. That exact combination
        is the one shape this adapter treats as a permanent stop of that one session — the later
        reset carries the NEW id and must never be mistaken for the old one.

        A normal exit arrives here with `reason="shutdown"`: it stops this process only, and the
        acknowledged settlements stay durable so a later run can settle them legitimately.
        Plugin unload does not reach here at all.
        """
        platform = kwargs.get("platform")
        reason = kwargs.get("reason")
        session = kwargs.get("session_id")
        if platform == "cli" and reason == "session_boundary" and isinstance(session, str) and session:
            self.request_stop(session, "session_reset")
        return None

    def request_stop(self, session_id, reason, handle=None):
        """Publish one exact stop intent, then confirm it against the core.

        The intent goes up under the leaf control lock, BEFORE any lock that can wait and before
        any core call, so no attempt of that session can start while the stop is unconfirmed. It
        comes down only when the core's own control transaction committed. A refusal (`ok: false`)
        and a throw both stay visibly unconfirmed and are retried — bounded by this intent's own
        attempts and original deadline, never by a fresh one.

        The session is named either by its raw id or by an acknowledged entry handle (the form a
        recovered entry without a raw id must use); either way the CORE derives the identity, and
        the hash it returns is what this process matches its own queue entries on.
        """
        intent = self.intent_stop(session_id, reason, handle=handle)
        if intent is None:
            return {"confirmed": False, "state": "capacity", "code": "stop_capacity",
                    "sessionId": session_id, "attempts": 0, "error": "stop_capacity"}
        return self.confirm_stop(intent)

    def intent_stop(self, session_id, reason, handle=None):
        """Phase one: make the barrier visible without waiting on anything.

        Returns the intent key, or None when the unconfirmed-control capacity is full (an explicit,
        counted refusal — never a silent drop of a session that still needs blocking, and never an
        unbounded map of them).
        """
        raw = session_id if isinstance(session_id, str) and session_id else None
        ack = handle if isinstance(handle, dict) and isinstance(handle.get("key"), str) \
            and isinstance(handle.get("payloadHash"), str) else None
        if raw is None and ack is None:
            return None
        intent = ("session", raw) if raw is not None else ("entry", ack["key"])
        refused = False
        with self.control_lock:
            record = self.pending_stops.get(intent)
            if record is None:
                if len(self.pending_stops) >= self.max_pending_stops:
                    self.stop_capacity_refusals += 1
                    # Recorded inline: `control_lock` is a leaf lock and the helper takes it too.
                    self.control_errors.append({"reason": "settlementStop", "sessionId": raw,
                                                "code": "stop_capacity"})
                    del self.control_errors[:-8]
                    refused = True
                else:
                    record = {"sessionId": raw, "handle": ack, "reason": reason, "attempts": 0,
                              "deadline": self.settlement.now() + self.stop_confirm_seconds,
                              "error": None, "confirmed": False, "state": "pending",
                              # The identity the core itself would derive, computed with the shared
                              # rule, so a raw-id stop already blocks exactly that session's
                              # restored entries — before, and independently of, the confirmation.
                              "sessionHash": session_identity(raw) if raw is not None else None,
                              "inflight": False}
                    self.pending_stops[intent] = record
            if not refused:
                # A repeated event for the SAME session never resets the original attempts or deadline.
                self.local_control_pending.add("%s:%s" % (intent[0], intent[1]))
        if refused:
            return None
        # Outside the leaf lock: holding this session's in-process scheduling may need the write
        # boundary, and it must never hold up the publication above. The entries are HELD, not
        # retired: their frozen payloads and deadlines stay, they remain visible, and they cannot
        # start an attempt — which is what keeps the stop intent in force until the core confirms.
        if raw is not None:
            # Both forms of the same identity: the raw id names this process's own entries, and the
            # core-consistent hash names the entries restored from the durable document (which have
            # no raw id of their own). Either way only THIS session is held.
            self.settlement.hold_session(session_id=raw)
            identity = session_identity(raw)
            if identity is not None:
                self.settlement.hold_session(session_hash=identity)
        elif ack is not None:
            self.settlement.hold_session(entry_key=ack["key"])
        return intent

    def confirm_stop(self, intent):
        """Submit one unconfirmed stop, bounded, and keep its barrier until the core commits it."""
        exhausted = False
        with self.control_lock:
            record = self.pending_stops.get(intent)
            if record is None or record["confirmed"] or record["inflight"]:
                return record
            now = self.settlement.now()
            if record["attempts"] >= self.max_stop_attempts or now >= record["deadline"]:
                if record["state"] != "exhausted":
                    record["state"] = "exhausted"
                    exhausted = True
                record_to_report = record
                record = None
            else:
                record["inflight"] = True
                record["attempts"] += 1
                attempt = record["attempts"]
                session_id, reason = record["sessionId"], record["reason"]
        if record is None:
            if exhausted:
                # Recorded outside the leaf lock: the helper takes it, and it is not re-entrant.
                self._record_control_error("settlementStop", record_to_report["sessionId"],
                                           record_to_report["error"] or "control_unconfirmed")
            return record_to_report
        result, code = self.stop_session_durably(record, attempt)
        ok = isinstance(result, dict) and result.get("ok") is True
        with self.control_lock:
            record["inflight"] = False
            if ok:
                record["confirmed"] = True
                record["state"] = "confirmed"
                record["error"] = None
                # The core's own answer carries the session identity; it is what the local queue
                # entries of a recovered session are matched on. It is never guessed here.
                session_hash = result.get("sessionHash")
                record["sessionHash"] = session_hash if isinstance(session_hash, str) else None
                self.local_control_pending.discard("%s:%s" % (intent[0], intent[1]))
                self.pending_stops.pop(intent, None)
                self.stop_history.append({"identity": list(intent), "sessionId": session_id,
                                          "reason": reason, "state": "confirmed", "attempts": attempt,
                                          "sessionHash": record["sessionHash"], "at": self.settlement.now()})
                del self.stop_history[:-MAX_STOP_HISTORY]
            else:
                record["error"] = code or "control_failed"
                record["state"] = "pending" if attempt < self.max_stop_attempts else "exhausted"
        if ok:
            # The core retired this session's pending rows in its own transaction; the local
            # scheduling for exactly that session stops here, and only for that session. The
            # hash is the core's own answer when it named one, otherwise the shared rule's.
            answered = result.get("sessionHash") if isinstance(result, dict) else None
            for identity in (answered, record.get("sessionHash")):
                if isinstance(identity, str) and identity:
                    self.settlement.stop_session(session_hash=identity)
            if isinstance(session_id, str):
                self.settlement.stop_session(session_id=session_id)
            if isinstance(record.get("handle"), dict):
                self.settlement.stop_session(entry_key=record["handle"].get("key"))
            return record
        if code in TRANSIENT_CODES:
            self._schedule_stop_retry(intent, attempt)
        if record["state"] == "exhausted":
            self._record_control_error("settlementStop", record["sessionId"],
                                       record["error"] or "control_unconfirmed")
        else:
            self._record_control_error("settlementStop", record["sessionId"], record["error"])
        return record

    def _schedule_stop_retry(self, intent, attempt):
        """One bounded background retry, so an unconfirmed stop can finish without a new turn."""
        with self.control_lock:
            record = self.pending_stops.get(intent)
            if record is None or record["confirmed"] or record["inflight"]:
                return
            if attempt >= self.max_stop_attempts:
                return
            delay = STOP_RETRY_DELAYS[min(attempt - 1, len(STOP_RETRY_DELAYS) - 1)]
            if self.settlement.now() + delay >= record["deadline"]:
                return
        # The queue's own injectable scheduler: same clock, same determinism as the retries.
        schedule = getattr(self.settlement, "schedule", None) or SettlementQueue._timer

        def fire():
            if self.closed or not self.running:
                return
            self.confirm_stop(intent)

        schedule(fire, delay)

    def _record_control_error(self, reason, session_id, code):
        with self.control_lock:
            self.control_errors.append({"reason": reason, "sessionId": session_id, "code": code})
            del self.control_errors[:-8]

    def on_session_reset(self, **kwargs):
        old = kwargs.get("old_session_id")
        if isinstance(old, str) and old:
            # A Gateway reset names the session it is ending, so it can be stopped exactly — with
            # the same barrier and the same bounded confirmation as the CLI boundary. The barrier
            # is published FIRST: the teardown below takes the write boundary, which may be busy.
            intent = self.intent_stop(old, "session_reset")
            self.on_session_end(session_id=old)
            self.close_session(old)
            return self.confirm_stop(intent) if intent is not None else None
        # No old id: the CLI boundary already stopped the old session through
        # `on_session_finalize`, and the id here is the NEW one. Stopping it would kill a session
        # that has just started, so this handler only drops its own per-turn state.
        session = kwargs.get("session_id")
        if isinstance(session, str) and session:
            self.on_session_end(session_id=session)
        return None

    def stop_session_durably(self, record, attempt):
        """Submit one exact, owner-scoped stop through the shared core.

        Addressing follows the core's own contract: a raw session id when there is one, otherwise
        the acknowledged entry handle (the core derives the session hash from that entry inside its
        lock, for this owner only). Nothing here derives an identity itself.
        """
        value = {"reason": record["reason"]}
        if isinstance(record["sessionId"], str):
            value["sessionId"] = record["sessionId"]
        elif isinstance(record.get("handle"), dict):
            value["key"] = record["handle"]["key"]
            value["payloadHash"] = record["handle"]["payloadHash"]
        else:
            return None, "control_unaddressed"
        try:
            result = self._durable("settlementStop", value)
        except SettlementError as error:
            return None, error.code
        if result.get("ok") is not True:
            return result, result.get("code") or "control_failed"
        return result, None

    def cancel_pending(self):
        with self.lock:
            self.generation += 1
            for job in self.jobs:
                job["cancel"].set()
                if job.get("ticket"):
                    self.call("reflectionCancel", {"ticket": job["ticket"]})
            for ids, row in list(self.turns.items()):
                self._settle_cancelled(ids, row)
            self.turns.clear()

    def close_session(self, session_id):
        """Stop one session's pending settlements; frozen outcomes keep their state."""
        with self.lock:
            for job in self.jobs:
                if job["session"] == session_id:
                    job["cancel"].set()
                    if job.get("ticket"):
                        self.call("reflectionCancel", {"ticket": job["ticket"]})
            return self.settlement.stop_session(session_id)

    def dispose(self):
        with self.lock:
            self.closed = True
            self.running = False
            self.cancel_pending()
            self.settlement.dispose()
            self.children.clear()

    def subagent_start(self, **kwargs):
        value = kwargs.get("child_session_id") or kwargs.get("session_id")
        if isinstance(value, str) and len(self.children) < 256:
            self.children.add(value)

    def subagent_stop(self, **kwargs):
        self.children.discard(kwargs.get("child_session_id") or kwargs.get("session_id"))
