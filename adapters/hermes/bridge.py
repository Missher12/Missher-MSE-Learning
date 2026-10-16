"""Hermes event translation only; persistence, matching and attribution live in the Node core."""
import hashlib
import json
import os
import re
import stat as stat_module
from pathlib import Path
try:
    from .guards import check_guard, validate_guard
except ImportError:  # Support the repository's direct-file test/smoke loaders.
    import importlib.util
    _guard_path = Path(__file__).with_name("guards.py")
    _guard_spec = importlib.util.spec_from_file_location("mse_hermes_guards", _guard_path)
    _guard_module = importlib.util.module_from_spec(_guard_spec)
    _guard_spec.loader.exec_module(_guard_module)
    check_guard, validate_guard = _guard_module.check_guard, _guard_module.validate_guard
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


# --- Native tool-failure normalization ---------------------------------------
# The host's `post_tool_call` reports `status` ("ok" | "error" | "blocked"), an `error_type`
# (the string "tool_error" for a result the host's own detector judged failed, otherwise an
# exception class name) and a stable `tool_call_id`. What may become METHOD EVIDENCE is decided
# here, once, from that structure — never from raw args, results or error text, none of which is
# kept. Everything below is a bounded classifier plus a bounded roster.
STATUS_FAILED = frozenset({"error", "failed", "failure"})
STATUS_CANCELLED = frozenset({"cancelled", "canceled", "aborted", "interrupted"})
STATUS_BLOCKED = frozenset({"blocked", "denied", "forbidden", "permission_denied", "guardrail"})
STATUS_TIMEOUT = frozenset({"timeout", "timed_out", "deadline_exceeded"})
# Availability facts: they are recorded so the turn's outcome is honest, but they are never a
# refutation of a METHOD, so they never enter the roster (mirrors the core's own exclusion).
AVAILABILITY_FAILURES = frozenset({"cancelled", "foreground_yield", "provider_unavailable"})
# Restricted exception vocabulary, mapped onto the classes the shared core already understands
# (`failureCodeOf`). Anything outside it degrades to `unknown_tool_failure`, so an exception name
# from a provider or an unrelated library never leaks into a durable class or a prompt. Two
# distinct tools stay two distinct problems regardless, because the tool name is part of the
# problem's own identity.
PYTHON_FAILURE_CLASSES = frozenset({
    "timeouterror": "tool_timeout", "asyncio.timeouterror": "tool_timeout", "concurrent.futures.timeouterror": "tool_timeout",
    "connectionerror": "provider_unavailable", "connectionrefusederror": "provider_unavailable",
    "connectionresetederror": "provider_unavailable", "brokenpipeerror": "provider_unavailable",
    "permissionerror": "provider_unavailable", "importerror": "provider_unavailable",
    "modulenotfounderror": "provider_unavailable",
    "keyboardinterrupt": "cancelled", "asyncio.cancellederror": "cancelled",
})
# Per-turn failure roster bound. Overflow is dropped, never an unbounded memory or ledger.
FAILURE_ROSTER = 16
# The human-readable, screen-safe Chinese name of each restricted failure class. Used ONLY in the
# host-fact summary; the internal identifier never reaches a prompt or a stored summary.
FAILURE_CLASS_LABELS = {
    "tool_nonzero_exit": "工具退出码非零", "tool_error_flag": "工具报错", "tool_timeout": "工具超时",
    "provider_unavailable": "工具不可用", "checker_contract_failure": "校验不通过",
    "unknown_tool_failure": "未知工具失败", "cancelled": "已取消", "foreground_yield": "前台让出",
}
# Bounded route-fact cache: the trusted provider/model a real pre_api_request reported, keyed by
# the turn that ran on it. It only ever holds three short strings per turn.
ROUTE_FACTS = 64
# The CORE's own limits for the three optional route fields (`routeValid` in src/index.mjs).
# Measured in UTF-16 code units, exactly as the core measures them.
# The recovery-plan refusals that are a WAIT on a source fact, mapped onto the core's own
# `PROBLEM_DEFER_CODES`. `source_route_unavailable` is the plan's code for a route this host could
# not keep; the shared core has no equivalent defer code yet, so it is parked under the closest
# released one (`source_route_unbound`) — the wait is what matters and it is never zero.
SOURCE_WAIT_CODES = {
    'source_route_unbound': 'source_route_unbound',
    'source_route_unavailable': 'source_route_unbound',
    'source_unbound': 'source_unbound',
    'scope_mismatch': 'scope_mismatch',
    'environment_mismatch': 'environment_mismatch',
    'recovery_summary_unsafe': 'recovery_summary_unsafe',
    # Stage 4b. `problemRecoveryPlan` now answers the source-IDENTITY questions too, and the shared
    # core accepts these same strings as `problemDefer` codes, so the wait travels verbatim instead
    # of being squeezed into the closest released one.
    'source_route_changed': 'source_route_changed',
    'source_reasoning_unavailable': 'source_reasoning_unavailable',
    'source_endpoint_unavailable': 'source_endpoint_unavailable',
    'provider_driver_unsupported': 'provider_driver_unsupported',
    'source_capacity': 'source_capacity',
}
ROUTE_PROVIDER_UNITS = 32
ROUTE_MODEL_UNITS = 64
ROUTE_EFFORT_UNITS = 16
# How many turns' worth of real `pre_api_request` dispatch facts are kept. A fact is only needed
# while its own turn can still produce a problem observation, and each entry is five bounded scalars.
PRE_API_FACTS = 64
# How many real host facts a single turn may persist as problems (one per distinct failure).
PROBLEM_ROSTER = 16


def _reasoning_effort(kwargs):
    """The reasoning effort the host actually put on the wire, or None when it did not say.

    This is deliberately NOT read from the hook's top level. The real `pre_api_request` emitter
    passes `request=agent._api_request_payload_for_hook(api_kwargs)`, i.e. `{"method": "POST",
    "body": {...}}`, and the reasoning field the provider really receives is inside that body. Only
    these two bounded scalars are ever looked at — the rest of the request (messages, tools,
    headers, credentials) is never touched, let alone stored.

    `None` means "this host did not report an effort"; it is NEVER filled in from a profile default,
    so a route recorded here claims exactly what the host said and nothing more. Distinguishing
    "explicitly unspecified" from "not applicable" from "unconfirmable" is 4b's route identity work.
    """
    body = kwargs.get("request")
    if not isinstance(body, dict):
        return None
    inner = body.get("body")
    if not isinstance(inner, dict):
        return None
    for name in ("reasoning_effort", "reasoningEffort"):
        value = inner.get(name)
        if isinstance(value, str):
            return value
    return None


def _effective_terminal_backend():
    """Read Hermes' current session-scoped terminal backend, or refuse when unavailable.

    The terminal tool's own `_session_scope()` first applies profile config bridging and then calls
    the scope-aware `_tenv`; reading os.environ here can mistake the process launch profile for the
    current session in a multiplexed host.
    """
    try:
        from tools.terminal_tool import _session_scope
        value = _session_scope().env_type
    except Exception:  # noqa: BLE001 — unsupported/unreadable host capability is unknown
        return None
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower()


def _tool_call_id(kwargs):
    """The host's stable call identity, or "" when this host did not provide one.

    Empty means the caller must degrade its de-duplication; it is never replaced by a freshly
    minted identifier, because that would turn a replay into fake independent evidence.
    """
    value = kwargs.get("tool_call_id")
    if not isinstance(value, str) or value == "" or len(value) > 512:
        return ""
    if IDENTITY_CONTROL.search(value):
        return ""
    return value


def _bounded_scalar(value, maximum):
    """One bounded, control-character-free scalar from a host hook, or None when it is not one."""
    if not isinstance(value, str) or value == "" or len(value) > maximum or IDENTITY_CONTROL.search(value):
        return None
    return value


def _turn_identity(kwargs):
    """`(session_id, turn_id, task_id)` with the same validity rule the rest of the bridge uses."""
    ids = Hooks._ids(kwargs)
    if ids is None:
        return None
    task = kwargs.get("task_id")
    task = task if isinstance(task, str) and 0 < len(task) <= 512 and not IDENTITY_CONTROL.search(task) else ""
    return ids[0], ids[1], task


class ToolFailure:
    """One bounded, host-classified tool failure. No args, results or error text are retained."""

    __slots__ = ("identity", "event_id", "tool_name", "failure_class", "degraded")

    def __init__(self, identity, event_id, tool_name, failure_class, degraded):
        self.identity = identity
        self.event_id = event_id
        self.tool_name = tool_name
        self.failure_class = failure_class
        self.degraded = degraded


def classify_tool_error_type(value):
    """Map a host `error_type` onto the restricted vocabulary, or None when it is not a failure."""
    if not isinstance(value, str) or value == "":
        return None
    name = value.strip().lower()
    if len(name) > 128:
        return "unknown_tool_failure"
    if name in {"tool_error", "tool_failed", "tool_failure"}:
        return "tool_error_flag"
    if name in {"timeout", "timed_out", "timeout_error"}:
        return "tool_timeout"
    if name in {"cancelled", "canceled", "cancelled_error"}:
        return "cancelled"
    if name in {"blocked", "permission", "permission_denied", "forbidden", "guardrail"}:
        return "provider_unavailable"
    if name in {"connection_error", "connectionerror", "provider_unavailable", "runtime_unavailable",
                "service_unavailable", "transport_error", "api_error", "authentication_error",
                "rate_limit_error", "permission_denied_error"}:
        return "provider_unavailable"
    if name in {"unknown_tool_failure", "tool_nonzero_exit"}:
        return name
    return PYTHON_FAILURE_CLASSES.get(name, "unknown_tool_failure")


def classify_tool_failure(kwargs):
    """`(failure_class, availability)` for one `post_tool_call` payload, from host structure only.

    Precedence is deliberate: an explicit cancellation or block ends the question (an availability
    fact is never method evidence), then the host's own failure flag, then the structured
    `error_type`, then a reported non-zero exit status. A payload the host marked successful with
    no error is not a failure at all, and a generic recorded failure with no usable classifier
    degrades to the bounded `unknown_tool_failure` rather than inventing a class.
    """
    status = kwargs.get("status")
    status = status.strip().lower() if isinstance(status, str) else ""
    if status in STATUS_CANCELLED or kwargs.get("interrupted") is True or kwargs.get("cancelled") is True:
        return "cancelled", True
    if kwargs.get("error_type") == "KeyboardInterrupt":
        return "cancelled", True
    if status in STATUS_BLOCKED or kwargs.get("blocked") is True:
        return "provider_unavailable", True
    failed = (status in STATUS_FAILED or status in STATUS_TIMEOUT or kwargs.get("failed") is True
              or kwargs.get("success") is False or kwargs.get("error") not in (None, False, "", {}))
    if not failed:
        return None, False
    if status in STATUS_TIMEOUT:
        return "tool_timeout", False
    mapped = classify_tool_error_type(kwargs.get("error_type"))
    if mapped is not None:
        return mapped, mapped in AVAILABILITY_FAILURES
    exit_status = kwargs.get("exit_status", kwargs.get("exit_code"))
    if isinstance(exit_status, int) and not isinstance(exit_status, bool) and exit_status != 0:
        return "tool_nonzero_exit", False
    return "unknown_tool_failure", False


def tool_failure_of(kwargs):
    """One `ToolFailure` for this call, or None when the host's fact is not method evidence.

    Identity is the host's stable call id, and the event id is that same call id: a replayed
    `post_tool_call` for one physical call IS the same event, and the roster below drops it. With
    no call id the identity degrades to ONE slot per turn/tool/class, so a flood of anonymous
    failures can never look like fresh independent evidence — the fact is reported as degraded
    instead of being given a fabricated uuid.
    """
    identity = _turn_identity(kwargs)
    if identity is None:
        return None
    failure_class, availability = classify_tool_failure(kwargs)
    if failure_class is None or availability or failure_class in AVAILABILITY_FAILURES:
        return None
    tool = kwargs.get("tool_name")
    tool = tool.strip() if isinstance(tool, str) else ""
    tool = tool if 0 < len(tool) <= 64 and not IDENTITY_CONTROL.search(tool) else "unknown_tool"
    call_id = _tool_call_id(kwargs)
    degraded = call_id == ""
    event_id = call_id or "degraded:%s:%s:%s" % (identity[1], tool, failure_class)
    return ToolFailure(event_id, event_id, tool, failure_class, degraded)




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
# How long an unload waits for the driver's tracked cleanup before it reports an UNCONFIRMED
# shutdown. It is a bound on the FOREGROUND wait, never on the cleanup itself: the loop stays alive
# and the close keeps running, and the state says which of the two happened.
DISPOSE_DRAIN_SECONDS = 10.0
# ── Stage 4c: the two paid tracks' own per-run reservations ──────────────────────────────────────
# These are the CORE's reservation amounts, not a local budget: the core freezes them into the
# ticket and drives every `budget_exceeded` decision from what it really measured. They are stated
# here (rather than computed) so the reservation a host asks for is visible and bounded.
REVIEW_TOKENS_BOUND = 4000
OBJECTIVE_TOKENS_BOUND = 12000
# The paid REQUEST transactions get a bounded window of their own (see `Hooks._call`): they are the
# two operations that freeze an attempt identity, and a timeout would be reported as a refusal.
PAID_REQUEST_OPS = frozenset({"reviewRequest", "evaluationRequest"})
PAID_REQUEST_TIMEOUT_SECONDS = 10
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
    @staticmethod
    def _problem_turn_hash(session, turn):
        """Recompute the opaque checker-ledger turn key for comparison, never for disclosure."""
        session_hash = hashlib.sha256(session.encode("utf-8")).hexdigest()
        encoded = json.dumps([session_hash, str(turn)], ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def __init__(self, config=None, call=None, review=None, enabled=None, driver=None, driver_factory=None,
                 schedule=None, cancel=None):
        self.config = config or {
            "stateRoot": str(Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser() / "mse-learning"),
            "adapterId": "hermes", "maxContextBytes": 768,
        }
        self.config = dict(self.config)
        raw_guards = self.config.get("guardTemplates", [])
        self.guard_templates = [rule for rule in raw_guards[:32] if validate_guard(rule)] if isinstance(raw_guards, list) else []
        self.guard_shadow = {}
        # The effective Host resolver is capability-based and scope-aware; tests may replace only
        # this narrow seam, while production defaults to Hermes' actual `_session_scope()`.
        self.terminal_backend_resolver = _effective_terminal_backend
        # The ONE timer seam this instance resolves: either supplied here, or this instance's own
        # attribute (which a host or a test may set before construction completes), or a REAL
        # daemon-thread timer. The default is production behaviour, not a placeholder: both the
        # settlement retry and the automatic pass build their wake-ups from it, so an instance with
        # no injection at all still owns exactly one chain (one timer per arm).
        self.schedule = getattr(self, "schedule", None) or schedule or self._timer
        self.cancel = getattr(self, "cancel", None) or cancel or self._cancel_timer
        self.config.setdefault("evaluationTokensPerDay", _bounded_env("MSE_EVALUATION_TOKENS_PER_DAY", 0, 1000000))
        self.config.setdefault("evaluationCallsPerDay", _bounded_env("MSE_EVALUATION_CALLS_PER_DAY", 2, 8))
        self.call = call or self._call
        self.turns = {}
        # Candidate registration happens after post_llm_call retires its turn row. Retain only
        # the bounded, non-secret project identity observed for each session so a later
        # autoCandidates row can still be resolved in its original scope.
        self.plan_projects = {}
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

        # Whether this instance owns a real reflection driver, stated EXPLICITLY.
        #
        # `_reflect` asks BEFORE signing a ticket: signing one and then discarding it would consume
        # the problem's evidence revision for nothing. The production registration (adapters/hermes
        # `register`) passes NO reviewer at all, so the default is `capability_waiting` and no ticket
        # is ever signed until 4b wires a driver whose capability is actually proven. Nothing here
        # tries to infer capability from a callable's identity, closure or globals: a function object
        # is not a capability contract, and guessing one is how an unproven `call_llm` fallback would
        # get back in through the side door.
        # Whether a reviewer was installed EXPLICITLY. `self.review` always points at SOMETHING —
        # the released `_review` (profile default route + `call_llm`) is the default — so "review is
        # callable" is not a capability statement. 4b's clearing rule depends on this distinction:
        # dropping an unproven driver must return the instance to `capability_waiting`, never promote
        # the built-in default into a proven one.
        self._injected_review = callable(review)
        self._driver = self._injected_review if driver is None else bool(driver)
        # The capability record must EXIST before anything can publish into it: `set_driver_factory`
        # below calls `_refreshDriverCapability`, which reads `self.capabilities`. Registering a
        # factory in the constructor is the production path, so building it here (rather than after
        # the whole object is assembled) is what keeps that path working without a fixture having to
        # pre-fill attributes.
        self.capabilities = {}
        # Stage 4b: a REAL single-attempt provider driver. It is a factory rather than an instance
        # because the driver owns a loop thread and must be built lazily, with the profile its
        # factory was created for. Installing a factory IS the capability claim — the same explicit
        # rule as `review`: nothing here infers capability from a callable's shape.
        self._driver_factory = None
        self.reflection_driver = None
        # Everything `_refreshDriverCapability` reports, before it is ever called.
        self.capabilities.update({"requestAdoption": "post_api_request_success", "providerWireEvidence": False,
                                  "trustedLessonChecks": True, "artifactChecks": True,
                                  "reflectionCancellation": "result_discard", "boundedSettlementRetry": True,
                                  "problemLedger": True, "routeCapture": "provider_model_reasoning",
                                  "reflectionDriver": "capability_waiting"})
        if driver_factory is not None:
            self.set_driver_factory(driver_factory)
        # The trusted provider/model a REAL `pre_api_request` reported, keyed by
        # `(session_id, turn_id)`. It is captured even when the turn recalled nothing (the cold
        # start has no receipt), because a later problem observation must carry the route the turn
        # actually ran on instead of borrowing a default one. It holds three short strings per turn
        # and is bounded; a turn that never reported a route simply binds nothing.
        self.routes = {}
        # File-tool backend facts captured before dispatch and consumed by the matching result.
        # A path that exists locally is not proof that a remote tool edited that local file.
        self.terminal_calls = {}
        # Stage 4b: the FULL dispatch facts of the last real `pre_api_request` for a turn — the
        # five identity scalars plus the request body, so the driver can prove what the host was
        # about to send instead of re-deriving it. Bounded, same lifetime as `routes`, and cleared
        # by the same invalidation rule.
        self.pre_api = {}
        # Route facts really bound vs refused for being outside the core's own bounds. Read-only
        # observability: a refusal means the turn binds NOTHING, never a truncated route.
        self.route_bound = 0
        self.route_rejections = 0
        self.route_rejection = None
        # Problem-ledger facts this process really observed: how many host failures it attempted to
        # persist, how many the core accepted as new evidence, and the LAST bounded capability wait.
        # Observable, never a claim that a reflection happened.
        self.problems = {"observed": 0, "accepted": 0, "degraded": 0, "last": None, "waiting": 0}
        self.enabled = enabled or (lambda: True)
        self.closed = False
        self.generation = 0
        self.running = True
        self.jobs = []
        # The unload's own outcome: `None` until a dispose runs, then the real record of what it
        # drained, closed and could not finish. Read by `local_status` and by tests.
        self.shutdown = None
        self._shutdown_drain = None
        # Wall clock used only to convert the core's epoch-millisecond receipt deadline into
        # this queue's monotonic seconds. Injectable for clock-controlled tests.
        self.wall_ms = getattr(self, 'wall_ms', None) or (lambda: time.time() * 1000.0)
        self.settlement = SettlementQueue(self._settle_payload, now=getattr(self, 'monotonic', time.monotonic),
                                          schedule=getattr(self, 'schedule', None), cancel=getattr(self, 'cancel', None),
                                          on_event=self._on_settlement_event, permitted=self._permitted,
                                          interlock=self._write_boundary, lock_timeout=SETTLEMENT_LOCK_TIMEOUT)
        # The driver capability is whatever `_refreshDriverCapability` last decided; every other
        # capability above is static for this build.
        self._refreshDriverCapability()
        # ── Stage 4c: the ONE automatic-advance pass ───────────────────────────────────────────────
        # Its mutable facts live HERE, beside the rest of this instance's bookkeeping: the last pass's
        # bounded audit, the persisted fair offset, and whether the single wake-up is armed. Nothing
        # in this document is lesson text, a credential or a route.
        self.plan = {"autoArmed": False, "autoReason": None, "lastPass": None, "passes": 0,
                     "steps": {"used": 0}, "offset": 0}
        self._plan = None
        # The automatic pass's OWN timer resolves the same injectable seams the settlement queue uses,
        # so a controlled verification can drive the REAL timer without a wall-clock wait. They are
        # constructor seams (not assignments after the fact) because both timers are built here.
        self._plan_schedule = getattr(self, "schedule", None) or schedule or self._timer
        self._plan_cancel = getattr(self, "cancel", None) or cancel or self._cancel_timer
        self.plan["schedule"] = self._plan_schedule
        self.plan["cancelTimer"] = self._plan_cancel

    @staticmethod
    def _timer(fn, delay):
        """The real wake-up: one daemon thread per armed timer, never joined by the foreground."""
        timer = threading.Timer(max(delay, 0.0), fn)
        timer.daemon = True
        timer.start()
        return timer

    @staticmethod
    def _cancel_timer(handle):
        cancel = getattr(handle, "cancel", None)
        if callable(cancel):
            cancel()

    # ── the automatic-advance pass ───────────────────────────────────────────────────────────────
    def set_plan_pass(self, factory):
        """Install (or clear) the bounded automatic pass. Installing it IS the capability claim."""
        if factory is None:
            old, self._plan = self._plan, None
            if old is not None:
                try:
                    old.stop("cleared")
                except Exception:  # noqa: BLE001
                    pass
            return None
        self._plan = factory(self)
        return self._plan

    def auto_pass_allowed(self):
        """Whether the pass may write at all right now. READ-ONLY, no core call.

        It is the same permission the paid work answers to — an unloaded instance, a user pause, an
        exact stop, the legacy controller taking over — expressed once so the pass cannot invent a
        second reading of it. `status`/`why` never reach this method.
        """
        if self.closed or not self.running:
            return False
        if not self.enabled():
            return False
        with self.control_lock:
            if "pause" in self.local_control_pending:
                return False
        return True

    def problem_recovery_attempt(self, row):
        """ONE due problem, through the SAME recovery path a live turn already uses.

        It is deliberately NOT a second reflection implementation. The attempt is the existing
        `_reflect`: the same source proof and CAS publication, the same `problemRecoveryPlan`
        admission, the same ONE driver/slot/cleanup and the same ticket accounting. What the timer
        adds is the WAKE-UP — a due problem no longer has to wait for the next user message.

        Every precondition is checked against facts this process really holds, and a fact it cannot
        prove is a DEFER, never a fabricated one:

          * the problem must name a ready `(id, evidenceRevision)` pair;
          * the turn that produced the evidence must still be in this process's bounded turn record,
            because `_reflect` reads that turn's own dispatch facts — a cold process that never saw
            the turn cannot prove its route, so it defers with `host_state_unknown` and the row waits
            for a real new event instead of being dispatched on a guess.

        A problem that was already attempted is refused by the CORE, not here: the signed-ticket
        revision is consumed, so a due row that was already paid for can never be replayed.
        """
        problem_id = row.get("id")
        revision = row.get("evidenceRevision")
        if not isinstance(problem_id, str) or not isinstance(revision, int):
            return {"slot": "skipped", "code": "problem_not_ready"}
        origin = row.get("origin") if isinstance(row.get("origin"), dict) else {}
        session = origin.get("sessionId")
        origin_turn_hash = origin.get("turnHash")
        if not isinstance(session, str) or session == "":
            return {"slot": "skipped", "code": "problem_not_ready"}
        with self.lock:
            turn = None
            for candidate in self.turns.values():
                base = candidate.get("base") if isinstance(candidate, dict) else None
                if not isinstance(base, dict) or base.get("sessionId") != session:
                    continue
                exact_turn = (str(base.get("turnId")) == str(origin.get("turnId"))
                              if origin.get("turnId") is not None
                              else isinstance(origin_turn_hash, str)
                              and self._problem_turn_hash(session, base.get("turnId")) == origin_turn_hash)
                if exact_turn:
                    turn = candidate
                    break
            if turn is None or self.jobs:
                # No turn record for the evidence's own session, or this instance is already running
                # an attempt: the row is parked with a POSITIVE wait so the fair cursor moves past it
                # and a later wake-up can still try.
                code = "host_state_unknown" if turn is None else "slot_busy"
                return {"slot": "deferred", "code": code}
        job = self._reflection_job(session, {"id": problem_id, "evidenceRevision": revision,
                                             "ready": True, "base": dict(turn.get("base") or {})})
        self.jobs.append(job)
        try:
            self._set_reflecting(True)
            # The turn's OWN captured summary, resolved exactly as the live path resolves it: the
            # reflection carries the facts that produced the evidence, never a synthesized one.
            summaries = self._resolveSummaries(turn, turn.get("result_summary")
                                               if isinstance(turn.get("result_summary"), str) else "")
            self._reflect(turn, "failed", job, summaries)
            return {"slot": "ran", "code": problem_id}
        except Exception as error:  # noqa: BLE001
            return {"slot": "skipped", "code": getattr(error, "code", None) or "recovery_failed"}
        finally:
            with self.lock:
                if job in self.jobs:
                    self.jobs.remove(job)
                self.reviewing = bool(self.jobs)

    def plan_project_of(self, session):
        """Return the consistent project identity observed for this session, if any."""
        if not isinstance(session, str) or session == "":
            return None
        with self.lock:
            remembered = self.plan_projects.get(session)
            if remembered is not None:
                project, ambiguous, created = remembered
                if time.monotonic() - created < 1800:
                    return project if not ambiguous else None
                self.plan_projects.pop(session, None)
            for row in self.turns.values():
                base = row.get("base") if isinstance(row, dict) else None
                if not isinstance(base, dict) or base.get("sessionId") != session:
                    continue
                value = base.get("projectKey")
                if isinstance(value, str) and value:
                    return value
        configured = self.config.get("projectKey") or os.environ.get("HERMES_MSE_PROJECT_KEY")
        return configured if isinstance(configured, str) and configured else None

    def proven_route(self, session):
        """The route a REAL dispatch on this session reported, or `None`.

        It is the same bounded dispatch-fact map the reflection path proves its identity from, so an
        automatic attempt on that session runs on the route the evidence was really produced under —
        never on the newest session's route and never on a profile default. `None` means this host
        cannot describe that session's execution today, which the caller reports as `source_unknown`
        instead of guessing one.
        """
        if not isinstance(session, str) or session == "":
            return None
        with self.lock:
            facts = None
            for key in reversed(list(self.pre_api.keys())):
                if key[0] == session:
                    candidate = self.pre_api.get(key)
                    if isinstance(candidate, dict):
                        facts = candidate
                        break
            if facts is None:
                return None
            provider = facts.get("provider")
            model = facts.get("model")
            if not isinstance(provider, str) or not isinstance(model, str):
                return None
            route = {"provider": provider, "model": model}
            effort = _reasoning_effort({"request": facts.get("request")})
            if isinstance(effort, str) and effort:
                route["reasoningEffort"] = effort
            return route

    def job_for_plan(self, plan, lesson):
        """Build the ONE driver's job document for one due plan, or `None` when it cannot be proved.

        Every field is a fact: the plan's own frozen identity (queueKey/planHash/version/environment),
        the LESSON the core reports for this edition, and the ORIGINAL session's proven dispatch facts
        (provider, model, endpoint, protocol, reasoning). A session this host cannot describe is
        `None` — the caller parks the plan as `source_unknown` and NOTHING is charged.
        """
        if not isinstance(plan, dict) or not isinstance(lesson, dict):
            return None
        session = plan.get("source", {}).get("sessionId") if isinstance(plan.get("source"), dict) else None
        if not isinstance(session, str) or session == "":
            session = lesson.get("sessionId")
        if not isinstance(session, str) or session == "":
            return None
        route = self.proven_route(session)
        if route is None:
            return None
        with self.lock:
            facts = None
            for key in reversed(list(self.pre_api.keys())):
                if key[0] == session:
                    candidate = self.pre_api.get(key)
                    if isinstance(candidate, dict):
                        facts = candidate
                        break
        if not isinstance(facts, dict):
            return None
        base_url = facts.get("base_url")
        api_mode = facts.get("api_mode")
        request_body = facts.get("request")
        if not isinstance(base_url, str) or not isinstance(api_mode, str):
            return None
        provider = route["provider"]
        model = route["model"]
        body = dict(request_body) if isinstance(request_body, dict) else {}
        body["model"] = model
        effort = route.get("reasoningEffort")
        if isinstance(effort, str) and effort:
            body["reasoning_effort"] = effort
        else:
            body.pop("reasoning_effort", None)
        row = self.row_for_plan(plan)
        source = self.source_row(session)
        if row is None or source is None:
            return None
        replay_cases = []
        if plan.get("track") == "objective":
            try:
                if isinstance(plan.get("ticket"), str) and plan.get("ticket"):
                    replay = self.call("taskEvidenceReplayCases", {"projectKey": self._plan_project(plan),
                        "ticket": plan["ticket"]})
                else:
                    replay = self.call("taskEvidenceReplayCases", {"projectKey": self._plan_project(plan), "limit": 2})
            except Exception:  # noqa: BLE001 — no objective material means no paid attempt
                replay = None
            replay_cases = replay.get("cases") if isinstance(replay, dict) and replay.get("ok") is True else []
            if plan.get("packId") == "package-json-structure-v1" and not replay_cases:
                ticket = plan.get("ticket")
                if isinstance(ticket, str) and ticket:
                    try:
                        self.call("evaluationCancel", {"ticket": ticket})
                    except Exception:  # noqa: BLE001 — cancellation is retried by core recovery
                        pass
                return None
        return {"kind": plan.get("track"), "route_provider": provider, "route_model": model,
                "pre_api": {"provider": provider, "model": model, "base_url": base_url,
                            "api_mode": api_mode, "request": {"method": "POST", "body": body}},
                "base": dict(row.get("base") or {"sessionId": session}), "source_session": session,
                "problem": {}, "ticket": plan.get("ticket"), "queueKey": plan.get("queueKey"),
                "planHash": plan.get("planHash"), "lessonId": plan.get("lessonId"),
                "version": plan.get("version"), "projectKey": self._plan_project(plan),
                "instruction": lesson.get("instruction"),
                "packId": plan.get("packId"),
                "environmentId": plan.get("environment"), "planTrack": plan.get("track"),
                "source": {"revision": source.get("revision"), "bindingHash": source.get("bindingHash"),
                           "controlGeneration": self._control_generation()},
                "review": {"maxTokens": REVIEW_TOKENS_BOUND},
                "objective": {"maxTokens": OBJECTIVE_TOKENS_BOUND, "cursor": 0,
                              "progress": plan.get("progress")},
                "taskReplayCases": replay_cases if isinstance(replay_cases, list) else []}

    def row_for_plan(self, plan):
        """The turn row a plan's attempt belongs to, or `None` when this process has no such row.

        An automatic run is bound to the lesson's ORIGINAL session, so the row is looked up by that
        session and is deliberately allowed to be absent: the driver only needs the session identity
        for its own source bookkeeping, and a missing local row is not a licence to borrow another.
        """
        session = plan.get("source", {}).get("sessionId") if isinstance(plan.get("source"), dict) else None
        if not isinstance(session, str) or session == "":
            return None
        with self.lock:
            for row in self.turns.values():
                base = row.get("base") if isinstance(row, dict) else None
                if isinstance(base, dict) and base.get("sessionId") == session:
                    return row
        return {"base": {"sessionId": session}}

    def _plan_project(self, plan):
        source = plan.get("source") if isinstance(plan.get("source"), dict) else {}
        project = source.get("projectKey")
        return project if isinstance(project, str) and project else None

    def source_row(self, session):
        """The READ-ONLY published source fact for one session, or `None`. Writes nothing."""
        answer = self._durable("sourceStatus", {"limit": 32})
        rows = answer.get("rows") if isinstance(answer, dict) else None
        if not isinstance(rows, list):
            return None
        hashed = hashlib.sha256(str(session).encode()).hexdigest()
        for row in rows:
            if isinstance(row, dict) and row.get("sessionHash") == hashed:
                return row
        return None

    def _control_generation(self):
        """The control generation the core currently holds, or `None` when it cannot be read."""
        try:
            value = self.call("controlGeneration", {})
        except Exception:  # noqa: BLE001
            return None
        return value if isinstance(value, int) else None

    def run_plan(self, plan, lesson):
        """Run ONE due plan on the ONE driver. Returns the driver's bounded outcome, or a wait.

        The pass never signs anything itself and never decides an outcome: it builds the job from
        proven facts, hands it to the `ReflectionDriver`, and reports what came back.
        """
        driver = self.reflection_driver
        if driver is None:
            return {"ran": False, "wait": "provider_driver_unsupported"}
        job = self.job_for_plan(plan, lesson)
        if job is None:
            return {"ran": False, "wait": "source_unknown"}
        job["invalidated"] = False
        cancel = threading.Event()
        try:
            return driver.run(job, "failed", ("", ""), cancel, self.call)
        except Exception as error:  # noqa: BLE001
            return {"ran": False, "wait": getattr(error, "code", None) or "provider_driver_unsupported"}

    def plan_run(self, plan, lesson):
        """The `plan.py` PREPARE seam: may this plan run, and with WHICH job document?

        It is deliberately a separate step from the execution below, because the ORDER is the
        contract: the caller registers the plan as `running` in the core FIRST, and only then hands
        this document to the driver. A prepare that also dispatched would make "the attempt really
        started" invisible to a crash recovery, and a plan marked running afterwards would describe
        a step that had already been paid for.

        Returns `{"ok": True, "job": {...}}` or `{"ok": False, "wait": code}`. It dispatches nothing.
        """
        if not self.auto_pass_allowed():
            return {"ok": False, "wait": "driver_disabled"}
        if self.reflection_driver is None:
            return {"ok": False, "wait": "provider_driver_unsupported"}
        job = self.job_for_plan(plan, lesson)
        if job is None:
            return {"ok": False, "wait": "source_unknown"}
        return {"ok": True, "job": job}

    def plan_execute(self, job):
        """The `plan.py` EXECUTE seam: ONE physical run of ONE prepared job on the ONE driver.

        Returns the driver's own bounded outcome (`{"ran": ..., "wait": ..., "result": ...}`). It
        never decides a stage, never signs anything itself and never retries: a stopped run is
        reported to the caller, which writes the plan's bounded bookkeeping from the core's codes.
        """
        driver = self.reflection_driver
        if driver is None:
            return {"ran": False, "wait": "provider_driver_unsupported"}
        if not self.auto_pass_allowed():
            return {"ran": False, "wait": "driver_disabled"}
        value = dict(job)
        value["invalidated"] = False
        cancel = threading.Event()
        try:
            return driver.run(value, "failed", ("", ""), cancel, self.call)
        except Exception as error:  # noqa: BLE001
            return {"ran": False, "wait": getattr(error, "code", None) or "provider_driver_unsupported"}

    def startup_recovery(self):
        """The CONTROLLED start-of-process recovery: run it ONCE, before any pass advances work.

        `recoverAutoPlans` voids EVERY ticket the previous process signed and releases its `running`
        plans. That is exactly right once, at startup, on a library no live process is working in —
        and catastrophically wrong on a timer: a pass that ran it every minute would void the tickets
        of attempts that are still in flight in THIS process and wipe their jobs. So it is its own
        entry point, called from the real start path, never from `pass_once`.
        """
        if self._plan is None:
            return {"ok": False, "code": "no_pass"}
        return self._plan.startup_recovery()

    def request_auto_pass(self, reason="event"):
        """A REAL event asks for the pass. It merges into the one wake-up; it never starts a second."""
        if self._plan is None:
            return {"ok": False, "code": "no_pass"}
        return self._plan.request(reason)

    def auto_pass(self, reason="manual"):
        """Run ONE bounded pass now (the manual/native entry point). Never called by a read."""
        if self._plan is None:
            return {"ok": False, "code": "no_pass"}
        return self._plan.pass_once(reason)

    def start_auto_pass(self, reason="startup"):
        """Start the single wake-up chain. Called from the real registration path, never by a read."""
        if self._plan is None:
            return {"ok": False, "code": "no_pass"}
        return self._plan.start(reason)

    def auto_pass_status(self):
        """Read-only: the pass's own bounded state. Writes nothing, scans nothing, wakes no model."""
        if self._plan is None:
            return {"installed": False}
        return {"installed": True, **self._plan.status()}
    def _reflectionDriverReady(self):
        """Whether a real single-attempt provider driver is wired for THIS instance.

        `self._driver` alone is not the answer: only an EXPLICITLY installed reviewer or the real
        provider driver counts, never the built-in default that a cleared factory leaves behind.
        """
        if self.reflection_driver is not None:
            return True
        return self._driver is True and self._injected_review and callable(self.review)

    def set_review(self, review):
        """Install a controlled reviewer, or clear it. The ONLY supported way to swap one.

        Passing a callable is what makes this instance able to ask for a reflection ticket at all;
        clearing it returns the instance to the explicit `capability_waiting` state. It exists so a
        controlled reviewer (a test, or a controlled tracer) can be wired without the production
        default silently standing in for it — assigning `self.review` directly leaves the capability
        flag alone, which is exactly the mistake the flag is here to prevent.

        Clearing it does NOT fall back to the built-in `_review`: that method resolves the profile's
        default route and calls `call_llm`, whose retry/fallback chain is precisely what 4b replaced,
        so treating it as an installed driver would re-enable an unproven capability by the side door.
        """
        self._injected_review = callable(review)
        self.review = review if self._injected_review else self._review
        self._driver = self._injected_review
        self._refreshDriverCapability()
        return self._driver

    def set_driver_factory(self, factory):
        """Install (or clear) the REAL single-attempt PROVIDER driver.

        Stage 4b's production driver is installed here and nowhere else. Building it is deferred to
        the first real attempt because it owns a loop thread and has to be created with the profile
        its factory captured. Clearing the factory returns the instance to the honest
        `capability_waiting` state: no ticket, no spend, no reviewer.
        """
        if not callable(factory):
            self.reflection_driver = None
            self._driver_factory = None
            # Only an explicitly installed reviewer keeps the instance able to sign; the built-in
            # default never becomes a proven driver just because a factory was removed.
            self._driver = self._injected_review
            self._refreshDriverCapability()
            return None
        self._driver_factory = factory
        self.reflection_driver = factory(self)
        self._driver = True
        self._refreshDriverCapability()
        return self.reflection_driver

    def _refreshDriverCapability(self):
        """Publish what this instance can really do, in the one vocabulary the surfaces share."""
        if self.reflection_driver is not None:
            self.capabilities["reflectionDriver"] = "async_openai_single_attempt"
            self.capabilities["providerWireEvidence"] = True
        elif self._injected_review and callable(self.review):
            self.capabilities["reflectionDriver"] = "injected_reviewer"
        else:
            self.capabilities["reflectionDriver"] = "capability_waiting"
            self.capabilities["providerWireEvidence"] = False

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
            # The transport's own bound. It is the same 2-second window the released contract states,
            # EXCEPT for the two paid tracks' request transactions: those settle an attempt identity
            # and write the plan's own attempt marker inside one Node process, and a busy build machine
            # can push a correct write past the shorter bound. A timeout here would look like a refusal
            # to the driver while the core may have signed nothing at all — so the paid REQUEST
            # operations get a bounded, still-finite window of their own.
            bound = PAID_REQUEST_TIMEOUT_SECONDS if op in PAID_REQUEST_OPS else 2
            result = subprocess.run([node, cli], input=json.dumps({"config": self.config, "op": op, "input": value}),
                                    text=True, capture_output=True, timeout=bound, check=False)
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

    def task_context(self, session_id, turn_id):
        """Trusted route/scope facts for one live turn; no prompt, content or credentials."""
        key = (session_id, str(turn_id))
        with self.lock:
            row = self.turns.get(key)
            route = self.routes.get(key)
            if row is None or not isinstance(route, dict):
                return None
            return {"sessionId": session_id, "turnId": key[1],
                    "projectKey": row["base"].get("projectKey"),
                    "environmentId": row["base"].get("environmentId"),
                    "provider": route.get("provider"), "model": route.get("model"),
                    "reasoningEffort": route.get("reasoningEffort")}

    @staticmethod
    def _project_manifest_write(kwargs, row, route):
        """Read back one successful root package.json write from the real file-tool result."""
        if (kwargs.get("tool_name") not in {"write_file", "patch"}
                or kwargs.get("status") != "ok" or kwargs.get("failed") is True
                or kwargs.get("error") not in (None, False, "", {})):
            return None
        call_id = _tool_call_id(kwargs)
        # Hermes terminal/file tools may dispatch into SSH, Docker, or another remote backend.
        # The project path is host-local only when the effective terminal backend says local.
        # `TERMINAL_ENV` is the backend selector consumed by Hermes' terminal dispatcher; unknown
        # values fail closed instead of treating a same-named local path as remote evidence.
        if kwargs.get("_mse_terminal_backend") != "local":
            return None
        if not call_id or not isinstance(route, dict):
            return None
        project = row.get("base", {}).get("projectKey")
        if not isinstance(project, str) or not os.path.isabs(project):
            return None
        try:
            root = Path(project).resolve(strict=True)
            if not root.is_dir():
                return None
            expected = root / "package.json"
            result = kwargs.get("result")
            result_doc = result if isinstance(result, dict) else json.loads(result) if isinstance(result, str) else None
            if not isinstance(result_doc, dict) or result_doc.get("error") or result_doc.get("resolved_path") != str(expected):
                return None
            modified = result_doc.get("files_modified")
            if modified != [str(expected)]:
                return None
            args = kwargs.get("args")
            if not isinstance(args, dict) or args.get("path") is None:
                return None
            if kwargs.get("tool_name") == "write_file" and not isinstance(args.get("content"), str):
                return None
            path = Path(result_doc["resolved_path"]).resolve(strict=True)
            if path != expected or not path.is_relative_to(root):
                return None
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(path, flags)
            try:
                before = os.fstat(fd)
                if not stat_module.S_ISREG(before.st_mode) or before.st_size > 32_000:
                    return None
                chunks = bytearray()
                while len(chunks) < 32_001:
                    chunk = os.read(fd, min(8192, 32_001 - len(chunks)))
                    if not chunk:
                        break
                    chunks.extend(chunk)
                after = os.fstat(fd)
                if len(chunks) > 32_000 or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                    return None
            finally:
                os.close(fd)
            encoded = bytes(chunks)
            content = encoded.decode("utf-8", errors="strict")
            if kwargs.get("tool_name") == "write_file" and args["content"] != content:
                return None
            recalled_methods = [item for item in row.get("lesson_versions", [])
                                if isinstance(item, dict) and isinstance(item.get("id"), str)
                                and isinstance(item.get("version"), int)]
            adopted = recalled_methods[0] if row.get("accepted") is True and len(recalled_methods) == 1 else None
            return {"adapterId": "hermes", "content": content,
                    "environmentId": row["base"].get("environmentId"), "eventId": call_id,
                    "fileHash": hashlib.sha256(encoded).hexdigest(), "filename": path.name,
                    "lessonId": adopted.get("id") if adopted else None,
                    "lessonVersion": adopted.get("version") if adopted else None,
                    "model": route.get("model"), "projectKey": project,
                    "provider": route.get("provider"), "reasoningEffort": route.get("reasoningEffort"),
                    "sessionId": row["base"]["sessionId"], "toolchain": "hermes-file-tools-v1",
                    "turnId": row["base"]["turnId"]}
        except (OSError, UnicodeError, ValueError, TypeError):
            return None

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
            # A permission change is exactly the REAL event that may have changed an allowance or
            # ended a foreground turn, so it asks the one pass for a wake-up. A pause is not asked to
            # start anything: the pass reads the same permission before it writes.
            if not paused:
                try:
                    self.request_auto_pass("resumed")
                except Exception:  # noqa: BLE001
                    pass
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
            # ── FOREGROUND PREEMPTION, published by the REAL hook ─────────────────────────────────
            # A turn that is really starting on a session owns that session. If a background
            # reflection for the SAME session is still in flight — its provider call may even be
            # waiting on the wire — it is invalidated HERE, before this hook does anything else:
            #   • the local cancel intent is published first, so the driver's own last local check
            #     (which runs after its final await and immediately before the submission) sees it;
            #   • the job is marked invalidated so the fact survives even if the flag is missed; and
            #   • the CORE's ticket is closed through `reflectionCancel`, which is a durable record
            #     that this attempt is over. That is not a refund and not a replay: the revision stays
            #     consumed, the usage stays measured-or-unknown, and a late provider answer can only
            #     be discarded.
            # Everything else this hook does — settlement recovery, the adoption queue, the turn's own
            # recall — is deliberately left intact: preempting a background reflection must not clear
            # the durable settlement queue or forget a real adoption.
            if ids is not None:
                self._preempt_background(ids[0])
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
                remembered = self.plan_projects.get(ids[0])
                if remembered is not None and now - remembered[2] < 1800:
                    previous, ambiguous, _created = remembered
                    self.plan_projects[ids[0]] = (previous if previous == project else None,
                                                   ambiguous or previous != project, now)
                else:
                    if len(self.plan_projects) >= 256:
                        oldest = min(self.plan_projects, key=lambda key: self.plan_projects[key][2])
                        self.plan_projects.pop(oldest, None)
                    self.plan_projects[ids[0]] = (project, False, now)
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
        """The host's own dispatch of the FINAL request: capture its route, then evaluate adoption.

        Route capture is unconditional and does NOT need a receipt: in a cold library `prepare`
        returns nothing, and a failure discovered in that same turn must still be able to name the
        provider/model it really ran on. What still needs a receipt is the ADOPTION half — the
        offered context has to be in the messages the host is about to send, and the success has to
        come back for the same API request id.
        """
        publish = None
        with self.lock:
            if not self._active():
                return
            ids = self._ids(kwargs)
            # The route is a fact about the request that is being dispatched, so it is recorded
            # before any adoption question is asked. It carries no credential and no endpoint.
            self._remember_route(ids, kwargs)
            row = self.turns.get(ids)
            if ids is not None and row is not None:
                publish = (ids, dict(row.get("base") or {}), self.pre_api.get(ids))
            if row and row["receipt"] and not row["accepted"]:
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
                # An explicit record of WHAT was refused: a request whose offered context was trimmed
                # away, and a request that carried no usable id, are different refusals.
                row["request_check"] = "matched" if row["request"] else ("context_trimmed" if not matched else "no_request_id")
        if publish is not None:
            self._publish_source_for_turn(*publish)

    def _publish_source_for_turn(self, ids, base, facts):
        """Publish the driver's proven dispatch identity before a checker can bind evidence to it."""
        driver = self.reflection_driver
        if driver is None or not isinstance(facts, dict):
            return {"ok": False, "wait": "provider_driver_unsupported"}
        source = driver.prepare_source(self.call, {
            "route_provider": facts.get("provider"), "route_model": facts.get("model"),
            "pre_api": {"provider": facts.get("provider"), "model": facts.get("model"),
                        "base_url": facts.get("base_url"), "api_mode": facts.get("api_mode"),
                        "request": facts.get("request")},
            "base": base, "source_session": ids[0], "problem": {"base": base}})
        if source.get("ok") is not True:
            self.problems["last"] = source.get("wait") or "source_route_unbound"
        return source

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
        """Normalize ONE trusted host tool event. No core call, no persistence, no raw payload.

        The turn row keeps a bounded roster of distinct host-classified failures (with their stable
        call identity) plus an availability count, and only trusted host metadata can mark a tool
        read-only. `args`, `result` and `error_message` are read for nothing and stored nowhere.
        """
        manifest_evidence = None
        checker_recovery = None
        checker_turn = None
        with self.lock:
            event_generation = self.generation
            if not self._active():
                return
            call_id = _tool_call_id(kwargs)
            backend_fact = self.terminal_calls.pop(call_id, None) if call_id else None
            row = self.turns.get(self._ids(kwargs))
            if not row:
                return
            row["tools"] += 1
            failure = tool_failure_of(kwargs)
            failed = classify_tool_failure(kwargs)[0] is not None
            # Availability facts are counted so the close is honest, but they are never roster
            # entries: a cancellation or a provider outage does not refute a method.
            if failed and failure is None:
                row["availability"] = row.get("availability", 0) + 1
            if failure is not None:
                roster = row.setdefault("failures", [])
                if not any(item.identity == failure.identity for item in roster) and len(roster) < FAILURE_ROSTER:
                    roster.append(failure)
                    if failure.degraded:
                        row["degraded"] = row.get("degraded", 0) + 1
                        self.problems["degraded"] += 1
            # Only trusted host metadata can mark a tool read-only. Unknown writes invalidate checks.
            if kwargs.get("read_only") is not True or failed:
                row["checks"].clear()
            row["task_failed"] = row["task_failed"] or bool(kwargs.get("failed")) or failed
            ids = self._ids(kwargs)
            if (ids is not None and backend_fact is not None
                    and backend_fact == (event_generation, "local")
                    and self.terminal_backend_resolver() == "local"):
                manifest_evidence = self._project_manifest_write(
                    {**kwargs, "_mse_terminal_backend": "local"}, row, self.routes.get(ids))
        if manifest_evidence is not None:
            # Keep the final lease check and evidence write under the same state lock. A pause,
            # close, or generation change cannot slip between the permission read and core commit.
            with self.lock:
                if self.generation != event_generation or not self._active(event_generation):
                    return
                try:
                    recorded = self.call("recordPackageJsonArtifact", manifest_evidence)
                    evidence = recorded.get("evidence") if isinstance(recorded, dict) else None
                    observation = evidence.get("problem") if isinstance(evidence, dict) else None
                    problem = observation.get("problem") if isinstance(observation, dict) else None
                    if (isinstance(recorded, dict) and recorded.get("status") == "fail"
                            and isinstance(observation, dict) and isinstance(problem, dict)):
                        ids = self._ids(kwargs)
                        turn = self.turns.get(ids) if ids is not None else None
                        if turn is not None:
                            turn["task_failed"] = True
                            if not isinstance(turn.get("result_summary"), str) or not turn["result_summary"].strip():
                                turn["result_summary"] = "package.json 结构检查未通过，需要核对字段类型并保留扩展字段。"
                            turn["checker_problem"] = {"id": problem.get("id"),
                                "evidenceRevision": problem.get("evidenceRevision"),
                                "ready": observation.get("ready") is True}
                            if observation.get("ready") is True:
                                checker_recovery = {"id": problem.get("id"),
                                    "evidenceRevision": problem.get("evidenceRevision"),
                                    "origin": problem.get("origin")}
                                checker_turn = ids
                except Exception:  # noqa: BLE001 — an unreadable/failed checker remains unknown
                    pass
        # A ready checker problem is reflected while its exact source turn is still live. The
        # session-end generic path must never substitute an unbound reflection for this evidence.
        if checker_recovery is not None:
            attempt = self.problem_recovery_attempt(checker_recovery)
            with self.lock:
                turn = self.turns.get(checker_turn)
                if turn is not None:
                    turn["checker_recovery"] = {"slot": (attempt or {}).get("slot"),
                                                "code": (attempt or {}).get("code")}

    def pre_tool_call(self, **kwargs):
        """Apply registered guards and capture the effective backend for file-tool attribution."""
        with self.lock:
            if self.closed or not self._active():
                return None
            tool_name, args = kwargs.get("tool_name"), kwargs.get("args")
            call_id = _tool_call_id(kwargs)
            if tool_name in {"write_file", "patch"} and call_id:
                if len(self.terminal_calls) >= 64:
                    self.terminal_calls.pop(next(iter(self.terminal_calls)))
                backend = self.terminal_backend_resolver()
                self.terminal_calls[call_id] = (self.generation, backend)
        for rule in self.guard_templates:
            message, matched = check_guard(rule, tool_name, args)
            if matched and rule["mode"] == "shadow":
                self.guard_shadow[rule["guardId"]] = min(4096, self.guard_shadow.get(rule["guardId"], 0) + 1)
            if message:
                return {"action": "block", "message": message}
        return None

    def _remember_route(self, ids, kwargs):
        """Bind the route a REAL `pre_api_request` reported to its own turn. Bounded, no secrets.

        Only the three identity fields the shared core's `route` contract accepts are kept: provider,
        model and reasoning effort. The base URL, headers, api key and the request itself are never
        read into this map — an endpoint fingerprint is not an identity this stage can prove, and 4b
        owns that decision.

        Each field is bounded by the CORE's own limits (`routeValid`: provider 32, model 64,
        reasoningEffort 16 UTF-16 units). A value over its bound is NOT truncated — truncating would
        store a route the host never reported and let a later attempt claim a binding it does not
        have. The whole route is cleared instead, and the refusal is recorded locally so the host can
        see that it had nothing to bind rather than reading a partial match as a match.

        The reasoning effort is read from the REAL wire shape (`request.body`), which is where the
        host's `_api_request_payload_for_hook` puts it; the hook's top level never carries it. Only
        that one bounded scalar is looked at inside the request.
        """
        if ids is None:
            return
        fields = (("provider", kwargs.get("provider"), ROUTE_PROVIDER_UNITS),
                  ("model", kwargs.get("model"), ROUTE_MODEL_UNITS),
                  ("reasoningEffort", _reasoning_effort(kwargs), ROUTE_EFFORT_UNITS))
        key = (ids[0], ids[1])
        route = {}
        for name, value, bound in fields:
            if value is None:
                continue
            if not isinstance(value, str) or value == "" or len(value) > bound or IDENTITY_CONTROL.search(value):
                # A route this host cannot keep REPLACES any earlier route for this turn. Keeping the
                # previous one would let a later observation bind a permit the last real dispatch no
                # longer supports, which is exactly the hole a top-level-only bounds check leaves.
                self.routes.pop(key, None)
                self.pre_api.pop(key, None)
                self.route_rejections += 1
                self.route_rejection = "route_%s_unusable" % name
                return
            route[name] = value
        if not route:
            # No usable route arrived at all (or nothing was reported): also clear, so an earlier
            # capture can never outlive the dispatch that superseded it.
            self.routes.pop(key, None)
            self.pre_api.pop(key, None)
            return
        if key not in self.routes and len(self.routes) >= ROUTE_FACTS:
            # Bounded, oldest-out: a route fact is only needed while its turn can still produce a
            # problem observation, and the turn table has its own expiry.
            self.routes.pop(next(iter(self.routes)), None)
        self.routes[key] = route
        # The same bounded store keeps the dispatch facts the driver needs to PROVE the identity
        # rather than re-derive it: base_url, api_mode and the real request body. They are the
        # host's own values (never credentials — the body is the SDK kwargs, and every sensitive key
        # inside it is already `<redacted>`), and they live exactly as long as the route does.
        facts = {"provider": route.get("provider"), "model": route.get("model"),
                 "base_url": _bounded_scalar(kwargs.get("base_url"), 2048),
                 "api_mode": _bounded_scalar(kwargs.get("api_mode"), 32),
                 "request": kwargs.get("request") if isinstance(kwargs.get("request"), dict) else None}
        if key not in self.pre_api and len(self.pre_api) >= PRE_API_FACTS:
            self.pre_api.pop(next(iter(self.pre_api)), None)
        self.pre_api[key] = facts
        self.route_bound += 1

    def _route_for(self, base):
        """The captured route for one turn, or None when this host never reported a usable one."""
        route = self.routes.get((base.get("sessionId"), base.get("turnId")))
        return dict(route) if route else None

    def _observe(self, base, payload):
        """One trusted `observeProblem` call. Never raises, never invents a failure class."""
        try:
            value = dict(base, **payload)
            route = self._route_for(base)
            if route is not None:
                value["route"] = route
            return self.call("observeProblem", value)
        except Exception as error:  # noqa: BLE001 - a missing runtime is never a new problem
            return {"ok": False, "code": getattr(error, "code", None) or "runtime_unavailable"}

    def _persist_problems(self, row):
        """Persist this turn's host-verified failures into the shared problem ledger.

        Called BEFORE the settlement path and independently of it, so an empty library (`prepare`
        returns no receipt) or a refused settlement can no longer stop problem discovery. The
        reference is the LAST observation the core accepted as new evidence, and a READY
        observation locks its exact `(id, evidenceRevision)` tuple against a later, unready one:
        a turn that ends with one more immature failure must never re-point the reflection at it.
        """
        base = dict(row["base"])
        result = {"id": None, "evidenceRevision": None, "ready": False, "accepted": 0, "duplicates": 0,
                  "degraded": row.get("degraded", 0)}
        observed = 0
        for failure in row.get("failures", ()):
            observed += 1
            outcome = self._observe(base, {
                "eventId": failure.event_id, "kind": "tool_failure", "source": "host_event",
                "toolName": failure.tool_name, "failureCode": failure.failure_class,
                "summary": "工具失败：%s（%s）" % (failure.tool_name, failure.failure_class)})
            self.problems["observed"] += 1
            if not isinstance(outcome, dict) or outcome.get("ok") is not True:
                continue
            if outcome.get("skipped") is not None or outcome.get("duplicate") is True:
                result["duplicates"] += 1
                continue
            result["accepted"] += 1
            self.problems["accepted"] += 1
            revision = outcome.get("evidenceRevision")
            if revision is None and isinstance(outcome.get("problem"), dict):
                revision = outcome["problem"].get("evidenceRevision")
            if outcome.get("ready") is True:
                result["id"] = outcome.get("id")
                result["evidenceRevision"] = revision
                result["ready"] = True
            elif result["ready"] is False and result["id"] is None:
                result["id"] = outcome.get("id")
                result["evidenceRevision"] = revision
        result["count"] = observed
        # The trusted identity the admission gate binds against: the core re-derives scope and
        # environment from it inside `problemRecoveryPlan`, so a drifted project or environment is
        # refused there rather than assumed here.
        result["base"] = dict(base)
        return result if observed > 0 else None

    def _resolveSummaries(self, row, assistant):
        """The `(taskSummary, resultSummary)` pair one reflection carries, or None when it may not.

        The core requires BOTH halves to be non-blank after trimming (`insufficient_summary`), and a
        real turn's prompt can be shorter than that on its own — a terse command is a completely
        normal turn. So the summary the HOST produced is completed with a bounded, data-only
        continuation that names only the turn's own failure facts. Nothing from a tool result, an
        error body, a path or an assistant transcript is ever added; the assistant's own text, when
        the host produced one, is used verbatim.
        """
        task = row.get("task_summary") if isinstance(row.get("task_summary"), str) else ""
        if assistant:
            return (task, assistant) if task.strip() and assistant.strip() else None
        if not row.get("failures"):
            return None
        host = self._problemSummary(row)
        # The core requires BOTH halves non-blank and the task half at least 8 characters. A terse
        # real command ("导出金额并排序") is shorter than that on its own, so the host fact is stated
        # in full here instead of letting the core refuse the request — and this is still refused
        # locally (a visible `host_fact_summary_too_short`) rather than sent as a doomed attempt.
        if not task.strip() or len(task.strip()) < 8:
            task = "宿主记录到工具失败、需要复盘的回合"
        if len(host.strip()) < 8:
            return None
        return task, host

    def _problemSummary(self, row):
        """The bounded host-fact summary used when the assistant produced none.

        It names only counts and the restricted failure classes in the vocabulary the core's own
        sensitivity screen accepts — never a tool output, a path or an error message. The internal
        class identifiers are deliberately NOT echoed: they carry separators the shared screen
        treats as credential markers, so writing them here would make the core refuse its own
        host-fact summary (`insufficient_summary`). This is the ONLY summary the automatic path
        synthesizes, and it exists because a hard provider failure leaves no assistant text.
        """
        classes = []
        for failure in row.get("failures", ()):
            name = FAILURE_CLASS_LABELS.get(failure.failure_class)
            if name is not None and name not in classes:
                classes.append(name)
        shown = "、".join(classes[:3]) if classes else "未知工具失败"
        return ("宿主验证收集到 %d 条工具失败（%s），未收到助手总结，需要复盘失败条件"
                % (len(row.get("failures", ())), shown))[:1200]

    def _note_waiting(self, code, job=None):
        """Record a bounded capability wait: no ticket was signed and nothing was consumed."""
        if job is not None:
            job["waiting"] = code
        self.problems["last"] = code
        self.problems["waiting"] += 1

    def local_status(self):
        """Read-only local facts of THIS process: nothing is written and no core call is made.

        Deliberately NOT named `status`: this bridge's `status` is the DISPLAY surface the rest of
        the plugin (and the existing tests) uses, and shadowing it here would silently replace it.
        """
        with self.lock:
            driver = self.reflection_driver
            return {"ok": True, "capabilities": dict(self.capabilities), "problems": dict(self.problems),
                    "routes": len(self.routes), "routesBound": self.route_bound,
                    "preApiFacts": len(self.pre_api),
                    "routeRejections": self.route_rejections, "routeRejection": self.route_rejection,
                    "pendingJobs": len(self.jobs),
                    # The physical side of the driver, as it really is: a busy slot, a draining slot
                    # and the high-water mark are the ONLY evidence that one attempt at a time was
                    # ever in flight, and no read here starts or stops anything.
                    "driver": None if driver is None else driver.status(),
                    "settlement": {"size": self.settlement.size(), "paused": self.settlement.paused}}

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
        """Close one turn: persist host facts, settle the adoption, then — separately — reflect.

        The ORDER is the contract. Problem discovery is persisted from the host's own failure
        roster BEFORE the settlement path, and it does not depend on that path succeeding: an empty
        library has no receipt, so `settlementEnqueue` answers `settlement_no_receipt` by design, and
        letting that refusal end the turn is what used to hide every cold-start failure. Nothing is
        faked to get past it either — the settlement is attempted only when it can be, and a
        settlement that fails is reported as pending while the problems stay recorded.
        """
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
            cancelled = bool(kwargs.get("interrupted"))
            # A cancelled turn is an availability fact: it is settled, never reflected on, and its
            # host failures are not turned into method problems.
            problems = None if cancelled else self._persist_problems(row)
            checks = list(row["checks"].values())
            outcome = ("cancelled" if cancelled else "failed" if row["task_failed"] or any(not item["passed"] for item in checks)
                       else "verified" if checks else "unknown")
            evidence = ({"evidence": {"source": "host_verifier", "checkId": row["check_id"],
                                      "lessonIds": list(row["checks"]), "checks": checks}}
                        if checks and not cancelled else {})
            payload = dict(row["base"], outcome=outcome, _key=ids, **evidence)
            queued = self.settlement.enqueue(ids, payload, row["base"]["sessionId"],
                                             deadline=self._settlement_deadline(row.get("receipt_expires_at")))
            attempt = self.settlement.attempt(ids) if queued in {"queued", "duplicate"} else {"state": queued}
            row["settle_state"] = attempt.get("state")
            if attempt.get("code"):
                row["settle_error"] = attempt.get("code")
            self.turns.pop(ids, None)
            # Reflection is a SEPARATE path, taken whether or not settlement could happen. The
            # trigger facts are the host's own: trusted checker verdicts, a recorded task failure,
            # or two or more real tool failures. It is never decided by a settlement write.
            reflectable = (not cancelled and (checks or row["task_failed"] or row["tools"] >= 2)
                           and os.environ.get("MSE_REFLECTION_ENABLED", "1") != "0")
            # A FAILURE-observed turn may only reflect through the problem ledger, bound to a
            # problem that really crossed the independent-evidence threshold. A single failure with
            # an assistant summary is refused here — the summary is not independent evidence, and
            # this is the gate the old generic reflection path used to bypass.
            hasFailure = row["task_failed"] or bool(row.get("failures"))
            blockedByProblem = hasFailure and (problems is None or problems.get("ready") is not True)
            if not reflectable or blockedByProblem or self.jobs:
                return
            summaries = self._resolveSummaries(row, row["result_summary"])
            if summaries is None:
                return
            job = self._reflection_job(row["base"]["sessionId"], problems if hasFailure else None)
            self.jobs.append(job)
            self._set_reflecting(True)
            review_outcome = "failed" if row["task_failed"] else outcome
            threading.Thread(target=self._reflect, args=(row, review_outcome, job, summaries), daemon=True).start()

    def _reflecting(self):
        with self.lock:
            return bool(self.jobs)

    def _set_reflecting(self, value):
        with self.lock:
            self.reviewing = bool(value) or bool(self.jobs)

    def _reflectionAdmission(self, problem, require_source=None):
        """The core's verdict on the source, with the stage-4b gate applied where it applies.

        `require_source` defaults to "is a real provider driver wired for this instance". That is the
        exact boundary of the new guarantee rather than a convenience: an attempt is source-gated when
        the code that can PROVE and PUBLISH an identity is the code that will dispatch — which is the
        driver, and only the driver. A controlled reviewer injected by a test or a tracer is not a
        supported production path and has no resolver, so it cannot publish one; the gate is not
        relaxed for it, it simply never applied to it. (The core enforces the other half: a ticket
        signed WITHOUT a `sourceBinding` carries no source freeze at all.)

        Nothing here is bypassable by a caller that DOES have a driver: `require_source` is derived
        from the instance's own state, never from an argument a caller chose.
        """
        if require_source is None:
            require_source = self.reflection_driver is not None
        return self._admission(problem, require_source)

    def _admission(self, problem, require_source):
        """The core's OWN verdict on whether this problem's source may be reflected on at all.

        `problemRecoveryPlan` re-reads the row inside the core and answers with the binding a real
        attempt needs: the trusted session/turn identity, the summary text AND the route the evidence
        was recorded under. Asking it BEFORE the ticket is what makes a route this host could not
        keep — no provider/model reported, out of the core's bounds, or an unusable value — an
        explicit WAIT instead of a reflection. A local string check at capture time is not enough:
        it decides what to store, not what may spend.

        Returns `{"ok": True, "reflection": {...}}` or `{"ok": False, "wait": code}`.
        """
        if not isinstance(problem, dict) or not isinstance(problem.get("id"), str):
            return {"ok": False, "wait": "problem_not_ready"}
        value = {"problemId": problem["id"]}
        base = problem.get("base")
        if isinstance(base, dict):
            for name in ("projectKey", "environmentId"):
                if base.get(name) is not None:
                    value[name] = base[name]
        try:
            plan = self.call("problemRecoveryPlan", value)
        except Exception:
            return {"ok": False, "wait": "host_state_unknown"}
        if not isinstance(plan, dict) or plan.get("ok") is not True:
            return {"ok": False, "wait": "host_state_unknown"}
        if plan.get("recoverable") is True and isinstance(plan.get("reflection"), dict):
            # The route the plan resolved is the one the EVIDENCE was recorded under, and it is
            # re-checked against the core's own bounds here as well: a stored value that predates a
            # bound change must not open a ticket.
            route = plan.get("route")
            if not isinstance(route, dict) or not isinstance(route.get("provider"), str) \
                    or not isinstance(route.get("model"), str):
                return {"ok": False, "wait": "source_route_unbound"}
            for name, bound in (("provider", ROUTE_PROVIDER_UNITS), ("model", ROUTE_MODEL_UNITS),
                                ("reasoningEffort", ROUTE_EFFORT_UNITS)):
                if name in route and (not isinstance(route[name], str) or not route[name]
                                      or len(route[name]) > bound or IDENTITY_CONTROL.search(route[name])):
                    return {"ok": False, "wait": "source_route_unbound"}
            # Stage 4b: this adapter's reflections are SOURCE-GATED, so the plan's source report is a
            # precondition, not a bonus. The report is a READ of what the host published (the exact
            # revision and binding a ticket must freeze); `gateReady` false means the identity is
            # either unproven for this build or no longer agrees with the evidence. Either way the
            # answer is a WAIT before anything is signed, so the revision stays unspent.
            source = plan.get("source")
            if require_source:
                if not isinstance(source, dict):
                    return {"ok": False, "wait": "source_unbound"}
                if source.get("gateReady") is not True:
                    return {"ok": False, "wait": source.get("code") or "provider_driver_unsupported"}
                for name in ("revision", "bindingHash", "routeId"):
                    if source.get(name) is None:
                        return {"ok": False, "wait": "provider_driver_unsupported"}
            return {"ok": True, "reflection": plan["reflection"], "route": route, "source": source}
        code = plan.get("code")
        return {"ok": False, "wait": SOURCE_WAIT_CODES.get(code, "host_state_unknown"), "code": code}

    def _deferProblem(self, problem, code):
        """Park a problem on a source fact the host could not confirm. Nothing is consumed."""
        if not isinstance(problem, dict) or not isinstance(problem.get("id"), str):
            return None
        revision = problem.get("evidenceRevision")
        if not isinstance(revision, int):
            return None
        try:
            return self.call("problemDefer", {"problemId": problem["id"], "evidenceRevision": revision, "code": code})
        except Exception:
            return None

    def _preempt_background(self, session_id):
        """Invalidate every in-flight background reflection for ONE session. Bounded, local first.

        The order is the contract, exactly as it is for an exact stop: the LOCAL intent is published
        under the leaf control lock BEFORE any core call, so an attempt that is between its last await
        and its submission cannot slip through while this method waits for a lock or a subprocess.
        The durable half then closes the ticket in the core, which is what makes the invalidation
        survive a crash of this process.

        Returns the number of jobs it invalidated.
        """
        with self.control_lock:
            targets = [job for job in self.jobs if job.get("session") == session_id]
            for job in targets:
                job["invalidated"] = True
                job["cancel"].set()
                self.local_control_pending.add("foreground:%s" % session_id)
        closed = 0
        for job in targets:
            ticket = job.get("ticket")
            if isinstance(ticket, str) and ticket:
                # The core's own terminal record for THIS ticket. It cannot mint a candidate and it
                # cannot refund; it is the durable statement that the attempt is finished.
                try:
                    self.call("reflectionCancel", {"ticket": ticket})
                    closed += 1
                except Exception:  # noqa: BLE001 — the local intent already blocks the commit
                    pass
        if targets:
            self.problems["preempted"] = self.problems.get("preempted", 0) + len(targets)
        return {"invalidated": len(targets), "closed": closed}

    def _reflection_job(self, session, problem=None):
        """One bounded reflection job record for a turn: identity, its own cancel flag, its binding.

        `problem` is the READY `(id, evidenceRevision)` pair a failure-observed turn must carry.
        Building the job here keeps that tuple explicit at every entrance instead of being
        reconstructed from loose arguments.
        """
        return {"generation": self.generation, "session": session, "cancel": threading.Event(),
                "ticket": None, "problem": problem, "waiting": None}

    def _reflect(self, row, outcome, job=None, summaries=None):
        """One bounded reflection attempt for ONE turn, bound to its own host problem reference.

        Three rules make this the 4b seam and not the old generic path:
        1. No driver, no ticket. With no proven driver this refuses BEFORE signing: signing a ticket
           and discarding it would consume the problem's evidence revision for nothing and lose the
           only chance the new evidence bought. A controlled reviewer or the real single-attempt
           driver turns it on, and nothing is inferred from a callable's shape.
        2. A failure-observed turn is refused unless it carries a READY `(problemId, revision)`
           pair, which rides into `reflectionRequest` as an explicit binding. The automatic path
           therefore cannot fall back to a candidate that never crossed the gate — including when
           the core reports the binding itself as unusable.
        3. Stage 4b: when the REAL provider driver is installed, the whole attempt — the source
           CAS, the ticket, the single dispatch and the commit — happens inside the driver, which
           owns the asyncio Task, the client, the shared physical slot and the draining state. This
           method never signs a ticket on that path, and it never closes one either: the driver
           closes exactly what it signed.
        """
        job = job or self._reflection_job(row["base"]["sessionId"], None)
        driver = None
        try:
            if not self._reflectionDriverReady():
                # Capability waiting, said out loud: this is the honest state when no proven driver
                # is wired, and it is reported, never passed off as a completed reflection.
                self._note_waiting(self.capabilities.get("reflectionDriver") or "driver_unavailable", job)
                return
            problem = job.get("problem") or {}
            failure_driven = outcome != "supported" and outcome != "verified"
            if failure_driven and (not problem.get("ready") or not isinstance(problem.get("id"), str)):
                # A failure with no ready problem is not reflected: the ledger remains the only
                # entrance to a failure-driven candidate.
                self._note_waiting("problem_not_ready", job)
                return
            admission = {"ok": True, "reflection": None, "source": None}
            if failure_driven:
                # ── (a) The lifecycle PROVES and PUBLISHES the source identity, from real facts ──
                # The gate is enforced by asking the core, and the core can only answer about an
                # identity this host has really published. On a COLD library nothing published yet,
                # so the driver proves the identity from the turn's own captured `pre_api_request`
                # facts and publishes it through the core's bounded CAS register — the same
                # `sourcePublish` every other publication goes through, never a pre-seeded row and
                # never a skipped gate. Only the driver can do this, and only IT can: proving needs
                # the real resolver, and a controlled reviewer is not a resolver.
                if self.reflection_driver is not None:
                    prepared = self._prepareSourceIdentity(row, job)
                    if prepared.get("ok") is not True:
                        wait = prepared.get("wait") or "host_state_unknown"
                        self._deferProblem(problem, wait)
                        self._note_waiting(wait, job)
                        return
                    # The dispatch step of THIS SAME attempt reuses the binding this lifecycle step
                    # just published, so both halves act on one identity instead of each resolving
                    # its own and hoping they agree.
                    job["prepared_source"] = prepared["source"]
                # ── (b) Now the core's OWN verdict on this problem's source ──────────────────────
                # A route the host could not keep, an identity that disagrees with the evidence, or
                # a driver this build has not proved is a WAIT here — the review is not called, no
                # ticket is signed, and the revision is not consumed, so new evidence can still buy
                # a real attempt.
                admission = self._reflectionAdmission(problem)
                if admission.get("ok") is not True:
                    wait = admission.get("wait") or "host_state_unknown"
                    self._deferProblem(problem, wait)
                    self._note_waiting(wait, job)
                    return
            with self.lock:
                if job["cancel"].is_set() or not self._active(job["generation"]):
                    return
                if job not in self.jobs:
                    self.jobs.append(job)
                # The pair resolved by `_resolveSummaries` is what travels: both halves already
                # satisfy the core's own screening, so a terse real command cannot turn a
                # legitimate reflection into a refused request.
                resolved = summaries if isinstance(summaries, tuple) else None
                if resolved is None:
                    cell = row.get("result_summary") if isinstance(row.get("result_summary"), str) else ""
                    resolved = self._resolveSummaries(row, cell)
                if resolved is None:
                    self._note_waiting("host_fact_summary_too_short", job)
                    return
                driver = self.reflection_driver
                if driver is None:
                    task_summary, result_summary = resolved
                    value = dict(row["base"], taskSummary=task_summary, resultSummary=result_summary,
                                 outcome="supported" if outcome == "unknown" else outcome)
                    if problem.get("ready") and isinstance(problem.get("id"), str):
                        value["problemId"] = problem["id"]
                        if isinstance(problem.get("evidenceRevision"), int):
                            value["evidenceRevision"] = problem["evidenceRevision"]
                    prepared = self.call("reflectionRequest", value)
                    if not isinstance(prepared, dict) or prepared.get("ok") is not True or not prepared.get("ticket"):
                        self._note_waiting("reflection_refused", job)
                        return
                    job["ticket"] = prepared.get("ticket")
                    if job["cancel"].is_set() or not self._active(job["generation"]):
                        return
            if driver is not None:
                self._reflectWithDriver(driver, row, outcome, job, resolved, problem)
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
                # A ticket the driver signed is the driver's to close: it knows whether the request
                # was dispatched, and a second `reflectionCancel` from here could not refund anything
                # — it would only hide which component really finished the attempt.
                if job.get("ticket") and job.get("driver_owned") is not True:
                    self.call("reflectionCancel", {"ticket": job["ticket"]})
                if job in self.jobs:
                    self.jobs.remove(job)
                self.reviewing = bool(self.jobs)

    def _prepareSourceIdentity(self, row, job):
        """Prove and publish this turn's source identity, through the REAL lifecycle.

        It runs on the background reflection thread with the turn's own captured dispatch facts, and
        it goes through the driver's own `prove` and `_bind_source`: the resolver is consulted for the
        CURRENT authorized route, the hook's endpoint and protocol are required to agree with it, and
        the result is published with an explicit compare-and-set. An identity that cannot be proved
        is a bounded WAIT that leaves the problem's evidence revision unspent.

        Returns `{"ok": True, "source": {...}}` or `{"ok": False, "wait": code}`.
        """
        driver = self.reflection_driver
        if driver is None:
            return {"ok": False, "wait": "provider_driver_unsupported"}
        base = dict(row["base"])
        facts = self.pre_api.get((base.get("sessionId"), base.get("turnId")))
        if not isinstance(facts, dict):
            # No real dispatch was ever observed for this turn: there is nothing to prove, and a
            # default route is exactly what must not be substituted for one.
            return {"ok": False, "wait": "source_unbound"}
        job["driver_owned"] = True
        return driver.prepare_source(self.call, {
            "route_provider": facts.get("provider"), "route_model": facts.get("model"),
            "pre_api": {"provider": facts.get("provider"), "model": facts.get("model"),
                        "base_url": facts.get("base_url"), "api_mode": facts.get("api_mode"),
                        "request": facts.get("request")},
            "base": base, "source_session": base.get("sessionId"),
            "problem": {"id": job.get("problem", {}).get("id"),
                        "evidenceRevision": job.get("problem", {}).get("evidenceRevision"),
                        "base": base} if isinstance(job.get("problem", {}).get("id"), str) else {}})

    def _reflectWithDriver(self, driver, row, outcome, job, summaries, problem):
        """Hand one attempt to the REAL provider driver, with this turn's own dispatch facts.

        Everything the driver is given is a fact this process really observed: the route the turn's
        own `pre_api_request` reported, the request body the host was about to send, and the READY
        problem reference. The driver resolves and re-checks the rest itself; if it cannot prove the
        identity, it reports a bounded wait and NOTHING is signed.
        """
        base = dict(row["base"])
        facts = self.pre_api.get((base.get("sessionId"), base.get("turnId"))) or {}
        value = {"invalidated": bool(job["cancel"].is_set()) or not self._active(job["generation"]),
                 "route_provider": facts.get("provider"), "route_model": facts.get("model"),
                 "pre_api": {"provider": facts.get("provider"), "model": facts.get("model"),
                             "base_url": facts.get("base_url"), "api_mode": facts.get("api_mode"),
                             "request": facts.get("request")},
                 "base": base, "outcome": "failed" if outcome in ("failed", "cancelled") else outcome,
                 "source_session": base.get("sessionId"),
                 "problem": {"id": problem.get("id"), "evidenceRevision": problem.get("evidenceRevision"),
                             "base": base} if isinstance(problem.get("id"), str) else {},
                 "ticket": None}
        job["driver_owned"] = True
        if isinstance(job.get("prepared_source"), dict):
            value["prepared_source"] = job["prepared_source"]
        result = driver.run(value, outcome, summaries, job["cancel"], self.call)
        if isinstance(result, dict):
            wait = result.get("wait")
            if isinstance(wait, str) and wait:
                self.problems["last"] = wait
                if result.get("ran") is not True and isinstance(problem.get("id"), str):
                    # Nothing was signed: the revision is untouched, so the problem is parked as a
                    # visible wait instead of being silently skipped.
                    self._deferProblem(problem, wait)
        return result

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
        """Withdraw everything in flight: local intent first, then the durable ticket close.

        This is the ORDINARY withdrawal — a pause, a foreground preemption, a session boundary or a
        control change. It ends the attempts that are in flight and invalidates their stale results,
        and it deliberately does NOT refuse the work that becomes eligible once the lifecycle
        recovers: a pause that could only ever be resumed into a driver that refuses every new
        attempt would turn "paused" into "unloaded for good". The permanent refusal is the unload's
        own half and lives in `dispose()`.
        """
        with self.lock:
            self.generation += 1
            targets = list(self.jobs)
            for job in targets:
                # `invalidated` is the durable half of the same fact: the driver re-reads it after its
                # last await, so a transport that ignored the cancellation still cannot commit.
                job["invalidated"] = True
                job["cancel"].set()
            for ids, row in list(self.turns.items()):
                self._settle_cancelled(ids, row)
            self.turns.clear()
        for job in targets:
            if job.get("ticket"):
                # The core's own terminal record for THIS ticket: not a refund, not a replay, and the
                # durable statement that the attempt is over.
                self.call("reflectionCancel", {"ticket": job["ticket"]})
        # The driver keeps its OWN registry of what is really in flight, and that is the one an
        # unload must reach even after this list has been cleared. This reaches it too, but only to
        # withdraw the CURRENT work: the registered attempt is invalidated, and a later, qualified
        # attempt is still allowed to be signed.
        if self.reflection_driver is not None:
            self.reflection_driver.cancel_in_flight()

    def close_session(self, session_id):
        """Stop one session's pending settlements; frozen outcomes keep their state."""
        with self.lock:
            for job in self.jobs:
                if job["session"] == session_id:
                    job["invalidated"] = True
                    job["cancel"].set()
                    if job.get("ticket"):
                        self.call("reflectionCancel", {"ticket": job["ticket"]})
            return self.settlement.stop_session(session_id)

    def dispose(self):
        """Unload: refuse new work, withdraw what is in flight, then DRAIN — never close early.

        The order is the whole contract, and it is the same one an exact stop follows:

          1. `closed`/`running` and the driver's own shutdown flag make every new attempt a bounded
             refusal. Nothing new can be signed.
          2. The local cancel intent and the job invalidation are published for the work already in
             flight, and each signed ticket is closed in the core. That is a durable statement that
             the attempt is over: the revision stays consumed, the usage is recorded, and no late
             answer can become a candidate.
          3. The driver's loop KEEPS RUNNING until its tracked cleanup really finishes. The loop is
             the only place that cleanup can run, so closing it first would abandon an open transport,
             leave the job Task pending and lose the accounting of an attempt that already happened.
          4. The drain runs on its OWN thread. This method publishes the intent and returns: a
             foreground unload must not block on a provider that is still finishing. `self.shutdown`
             reports what really happened, and `cleanup_settled()` is the predicate a caller waits on.
             A drain that cannot finish in its window is reported as UNCONFIRMED — the loop stays
             alive to finish it, and nothing is claimed or discarded.
        """
        with self.lock:
            self.closed = True
            self.running = False
            self.cancel_pending()
            # The ONE wake-up chain stops with the instance, BEFORE the drain begins: a pass that
            # re-armed itself while the driver is going away would ask for work nobody may sign.
            # Stopping it is idempotent and never touches the cleanup already in flight.
            pass_chain, self._plan = self._plan, None
            if pass_chain is not None:
                try:
                    pass_chain.stop("disposed")
                except Exception:  # noqa: BLE001
                    pass
            self.settlement.dispose()
            self.children.clear()
            driver, self.reflection_driver = self.reflection_driver, None
            self._driver_factory = None
            # (1) The PERMANENT refusal is published HERE, still under the instance lock, and that
            # placement is load-bearing: an attempt that already read this driver (`_reflect` reads it
            # under this same lock) must not be able to slip one dispatch into a driver that is going
            # away. `cancel_pending` above only withdrew what was in flight — refusing new work for
            # good is the unload's own half, and no ordinary pause or foreground cancel may publish it.
            invalidated = 0
            if driver is not None:
                try:
                    invalidated = driver.begin_shutdown()
                except Exception:  # noqa: BLE001
                    invalidated = 0
            self._refreshDriverCapability()
        if driver is None:
            self.shutdown = {"at": self.wall_ms(), "invalidated": 0, "ticketsClosed": 0,
                             "settled": True, "driver": None}
            return {"ok": True, "settled": True, "drained": True}
        # (2) the work in flight was withdrawn locally above; now close the signed tickets durably.
        closed_tickets = 0
        for job in list(driver.jobs.values()):
            ticket = job.get("ticket")
            if isinstance(ticket, str) and ticket:
                try:
                    self.call("reflectionCancel", {"ticket": ticket})
                    closed_tickets += 1
                except Exception:  # noqa: BLE001 — the local intent already blocks the commit
                    pass
        self.shutdown = {"at": self.wall_ms(), "invalidated": invalidated,
                         "ticketsClosed": closed_tickets, "settled": None, "driver": driver.status()}
        # (3)+(4) drain and close on a background thread; the foreground is never blocked for it.
        drain = threading.Thread(target=self._drain_then_close,
                                 args=(driver, invalidated, closed_tickets),
                                 name="mse-shutdown-drain", daemon=True)
        drain.start()
        self._shutdown_drain = drain
        return {"ok": True, "settled": None, "invalidated": invalidated,
                "ticketsClosed": closed_tickets, "draining": driver.cleanup_pending()}

    def _drain_then_close(self, driver, invalidated, closed_tickets):
        """Run the drain to completion, then close the loop it was protecting."""
        settled = False
        try:
            settled = driver.close(timeout=DISPOSE_DRAIN_SECONDS)
        except Exception:  # noqa: BLE001
            settled = False
        self.shutdown = {"at": self.wall_ms(), "invalidated": invalidated,
                         "ticketsClosed": closed_tickets, "settled": settled,
                         "drained": not driver.cleanup_pending(), "driver": driver.status()}
        if not settled:
            self.control_errors.append({"reason": "dispose", "code": "cleanup_still_draining"})
            del self.control_errors[:-8]

    def cleanup_settled(self, timeout=30.0):
        """Wait for the unload's own drain to reach a final answer. Read-only: never writes."""
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            state = self.shutdown
            if state is not None and state.get("settled") is not None:
                return state
            time.sleep(0.005)
        return self.shutdown

    def subagent_start(self, **kwargs):
        value = kwargs.get("child_session_id") or kwargs.get("session_id")
        if isinstance(value, str) and len(self.children) < 256:
            self.children.add(value)

    def subagent_stop(self, **kwargs):
        self.children.discard(kwargs.get("child_session_id") or kwargs.get("session_id"))
