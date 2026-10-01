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
        self.is_transient = is_transient or (lambda error: getattr(error, "code", None) in TRANSIENT_CODES)
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

    def enqueue(self, key, payload, session_id, deadline=None):
        if self.disposed:
            return "disposed"
        existing = self.entries.get(key)
        if existing is not None:
            return "duplicate" if existing["payload"] == payload else "conflict"
        if len(self.entries) >= self.max_items:
            self.on_event({"kind": "capacity", "sessionId": session_id, "turnId": payload.get("turnId")})
            return "capacity"
        self.entries[key] = {"key": key, "sessionId": session_id, "turnId": payload.get("turnId"),
                             "payload": dict(payload), "attempts": 0, "state": "pending", "lastError": None,
                             "queuedAt": self.now(), "deadline": self._deadline(deadline), "delivery": "pending"}
        return "queued"

    def _allowed(self):
        """Latest host permission, without the pause side effect `_active` performs."""
        try:
            return bool(self.permitted())
        except Exception:
            return False

    def attempt(self, key):
        entry = self.entries.get(key)
        if entry is None:
            return {"state": "missing"}
        if self.disposed or self.paused:
            return {"state": entry["state"]}
        if not self._allowed():
            # Permission disappeared while this retry was waiting. The frozen payload and
            # its deadline are kept exactly as they are — never rewritten to cancelled and
            # never re-derived — and the queue pauses, so only an explicit resume may
            # replay it, and only while it is still unexpired.
            self.pause()
            self.on_event({"kind": "blocked", "key": key, "sessionId": entry["sessionId"],
                           "turnId": entry["turnId"], "attempts": entry["attempts"],
                           "code": "learning_disabled"})
            return {"state": "paused", "entry": entry}
        now = self.now()
        if now > entry["deadline"]:
            entry["lastError"] = entry["lastError"] or "deadline_exceeded"
            record = self._retire(entry, "expired")
            self.on_event({"kind": "expired", "key": key, "sessionId": entry["sessionId"],
                           "turnId": entry["turnId"], "attempts": entry["attempts"],
                           "code": "deadline_exceeded", "record": record})
            return {"state": "expired", "entry": entry, "record": record}
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
                record = self._retire(entry, "failed")
                self.on_event({"kind": "failed", "key": key, "sessionId": entry["sessionId"],
                               "turnId": entry["turnId"], "attempts": entry["attempts"], "code": code, "record": record})
                return {"state": "failed", "entry": entry, "code": code, "record": record}
            delay = self.delays[min(entry["attempts"] - 1, len(self.delays) - 1)]
            if entry["attempts"] >= self.max_attempts or now + delay > entry["deadline"]:
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
        if self.paused or not self._allowed():
            return "learning_disabled"
        if self.now() > entry["deadline"]:
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
        self.pause()
        self.on_event({"kind": "blocked", "key": key, "sessionId": entry["sessionId"],
                       "turnId": entry["turnId"], "attempts": entry["attempts"], "code": refusal})
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
        if self.disposed or not self.paused:
            return
        self.paused = False
        now = self.now()
        for key, entry in list(self.entries.items()):
            if entry["state"] != "pending":
                continue
            if now > entry["deadline"]:
                record = self._retire(entry, "expired")
                self.on_event({"kind": "expired", "key": key, "sessionId": entry["sessionId"],
                               "turnId": entry["turnId"], "attempts": entry["attempts"],
                               "code": "deadline_exceeded", "record": record})
                continue
            self._schedule(entry, 0)

    def stop_session(self, session_id):
        stopped = []
        for key, entry in list(self.entries.items()):
            if entry["sessionId"] != session_id:
                continue
            handle = self.timers.pop(key, None)
            if handle is not None:
                self.cancel(handle)
            stopped.append(key)
            record = self._retire(entry, "stopped")
            self.on_event({"kind": "stopped", "key": key, "sessionId": session_id, "turnId": entry["turnId"],
                           "attempts": entry["attempts"], "record": record})
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

    def _settle_payload(self, payload):
        """Idempotent replay applied by the settlement queue; never re-runs model work.

        Called with the write boundary already held by the queue, so the frozen payload and
        the state it was validated against cannot drift apart between the check and the call.
        """
        result = self.call("complete", dict(payload))
        if result.get("ok"):
            return result
        raise SettlementError(result.get("code") or "learning_unavailable")

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
            if not self._permitted():
                return result
            time.sleep(delay)
            if not self._permitted():
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
        payload = dict(row["base"], outcome="cancelled")
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

    def _permitted(self):
        """The host's latest permission, read without the pause side effect of `_active`.

        The settlement queue calls this immediately before every write, so a host that
        withdraws permission while no hook is firing still cannot have an old retry land.
        """
        try:
            return not self.closed and self.running and bool(self.enabled())
        except Exception:
            return False

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
        with self.lock:
            if self.running != (enabled is True):
                self.generation += 1
            self.running = enabled is True and not self.closed
            if self.running:
                # Only unexpired local `complete` replays resume; no review or evaluation restarts.
                self.settlement.resume()
            else:
                self.settlement.pause()
                self.cancel_pending()

    def pre_llm_call(self, **kwargs):
        try:
            if not self._active():
                return None
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
            payload = dict(row["base"], outcome=outcome, **evidence)
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

    def on_session_reset(self, **kwargs):
        session = kwargs.get("old_session_id") or kwargs.get("session_id")
        if session:
            # Resetting a session ends it for real: the per-turn branch of on_session_end
            # would leave frozen settlements retrying for a session the host has abandoned.
            self.on_session_end(session_id=session)
            self.close_session(session)

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
