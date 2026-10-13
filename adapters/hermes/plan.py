"""Stage 4c — the Hermes automatic-advance pass: the ONE bounded timer, the fair cursor, recovery.

This module is a SCHEDULER SHAPE, not a second policy engine. Every decision it appears to make is
the core's:

  * which lessons may be worked on, which official case a plan is for, whether a reservation is
    allowed, what a verdict means, whether a lesson may be promoted — all of it lives in the Node
    core, inside its own transactions, and this file only asks.
  * it never signs a ticket itself (the ONE `ReflectionDriver` does that), never calls a model
    (the driver dispatches), and never decides that work is `done`.
  * it owns exactly ONE wake-up chain and ONE serial guard, so "a second pass cannot overlap the
    first" is a property of this object rather than a convention.

The three things it really does:

  1. **Merging triggers into one bounded timer.** Startup, a real event (permission/settings change,
     a turn boundary) and the repeating timer all call `request()`. A request only ever brings the
     next pass FORWARD, never doubles it, and the timer is re-armed only after the pass returned —
     a pass that outlives its interval therefore cannot pile up behind itself.
  2. **The persistent fair cursor.** New registrations rotate through the core's own consideration
     cursor (`autoConsiderAdvance`), the problem ledger rotates through its own bounded due feed
     (`problemDueFeed`), and the plans this pass advanced rotate through a persisted local offset, so
     a due plan behind a prefix of blocking ones is still reached on a later pass instead of the
     first N being retried for ever. Expired licences go through the core's own rotated maintenance
     window (`maintainLearning`).
  3. **Recovery, honestly split.** `recoverAutoPlans` releases what a DEAD process left behind
     (its tickets are voided and never replayed); an UNSIGNED wait — a budget, a cooldown, a source
     the host could not confirm — is left exactly as it is and simply becomes due again when its own
     `nextAttemptAt` arrives.

A process that is not running has no timer; nothing here claims the system works in the background.
"""
from __future__ import annotations

import os
import threading

# At most this many NEW plans are registered in one pass (the core's own registration window is
# bounded too; this is the per-pass quota on top of it).
PER_PASS_REGISTRATIONS = 2
# At most this many plans are ADVANCED in one pass. One plan holds the physical slot for its whole
# run, so this is also the bound on how long one pass may occupy the provider.
PER_PASS_PLANS = 2
# The bounded candidate window the fair cursor rotates over each pass.
CONSIDER_WINDOW = 8
# The bounded problem-ledger window one pass works through.
PROBLEM_WINDOW = 4
# The bounded maintenance window (expired licences retired per pass).
MAINTENANCE_WINDOW = 8
# The reservation each track asks the core for. They are the CORE's amounts, frozen into the ticket;
# this side only has to state the same number when it asks whether the allowance exists at all.
REVIEW_TOKENS = 2  # initial ticket floor; each wire request is reserved atomically by the driver
OBJECTIVE_TOKENS = 2
# How many paid steps may be handed to the driver per pass, across all tracks.
PER_PASS_STEPS = 24
# The one wake-up cadence. Bounded, and the only timer this adapter owns.
DEFAULT_INTERVAL_SECONDS = 60.0
MIN_INTERVAL_SECONDS = 5.0
MAX_INTERVAL_SECONDS = 3600.0
# A request may not schedule sooner than this after the pass that just ran. It is what keeps a burst
# of real events from turning into a busy loop of scans.
MIN_GAP_SECONDS = 1.0

# Terminal reasons that really mean "wait for the allowance to change" — a plan parked for one of
# them keeps its attempts and is retried when its own due time arrives. Nothing here is a local
# policy: the codes are the core's own.
WAIT_CODES = frozenset({
    "review_budget", "evaluation_budget", "evaluation_budget_calls", "review_budget_calls", "review_budget_tokens",
    "review_budget_disabled", "renewal_waiting_evidence", "review_not_allowed",
    "auto_plan_unknown", "auto_plan_stale", "slot_busy", "plan_not_runnable",
})
# A stopped run is not a failed attempt: the world moved (a pause, a stop, the switch), so the plan
# asks again later instead of spending its bounded retry budget.
CANCELLED_CODES = frozenset({
    "cancelled", "control_paused", "control_source_stopped", "control_changed", "driver_shutting_down",
    "driver_disabled", "learning_disabled", "review_yielded",
})
# A host fact could not be CONFIRMED. The reservation (if any) is never refunded, and the plan is
# retried on its waiting cadence rather than counted as a failure.
UNKNOWN_CODES = frozenset({
    "source_unknown", "source_changed", "source_binding_mismatch", "source_stale_revision",
    "source_session_mismatch", "source_route_changed", "source_reasoning_unavailable",
    "source_endpoint_unavailable", "source_capacity", "scope_mismatch", "environment_mismatch",
    "control_unavailable", "provider_driver_unsupported", "host_state_unknown", "host_fact_unknown",
})
# Real provider trouble: this is what a bounded retry budget is for.
TRANSIENT_CODES = frozenset({
    "provider_unavailable", "provider_timeout", "response_too_large", "judge_material_too_large",
    "objective_step_budget", "reflection_refused",
})

# The waiting cadences (seconds). `nextAttemptAt` is in the core's own epoch milliseconds.
YIELD_RETRY_SECONDS = 15.0
BUDGET_RETRY_SECONDS = 120.0
BACKOFF_SECONDS = (30.0, 120.0, 600.0)


def _bounded_seconds(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if value < MIN_INTERVAL_SECONDS or value > MAX_INTERVAL_SECONDS:
        return default
    return value


class AutoPass:
    """The ONE automatic-advance pass: one wake-up chain, one serial guard, bounded work per pass.

    It is deliberately constructed with injectable seams (`now`, `schedule`, `cancel`) so the real
    control flow can be driven by a controlled clock in tests without a wall-clock wait, exactly as
    the settlement queue is.
    """

    def __init__(self, hooks, *, call, clock, state, interval=None, allow_reads=True,
                 now=None, schedule=None, cancel=None):
        self.hooks = hooks
        self.call = call
        # `state` is the bridge's own mutable document for the facts the pass publishes: the last
        # pass audit, the counts, the fair offset. It is never a second store.
        self.state = state
        self.allow_reads = allow_reads
        self.interval = interval if isinstance(interval, float) and interval >= MIN_INTERVAL_SECONDS \
            else _bounded_seconds("MSE_AUTO_PASS_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS)
        self.now = now or (lambda: clock())
        self.schedule = schedule
        self.cancel = cancel
        self.running = False
        self.busy = False
        self.handle = None
        self.due_at = None
        self.passes = 0
        # TWO cursors, deliberately not one: `offset` is the REGISTRATION window rotation (a length
        # that changes as the candidate feed changes), while `due_offset` rotates over the PLANS that
        # are currently due — the category that would otherwise be pinned by a prefix of plans that
        # cannot run. Neither is advanced by a read.
        self.offset = 0
        self.due_offset = 0
        self.recovered = False
        self.last = None
        self.events = []
        self.started_at = None
        # The wake-up chain's own generation. Every arm (and every disarm) moves it, so a request
        # that lands WHILE a pass is running cannot leave two chains behind: the pass's own re-arm
        # only happens if the chain it was part of is still the current one.
        self.chain = 0
        self._lock = threading.Lock()

    # ── the ONE wake-up chain ──────────────────────────────────────────────────────────────────
    def request(self, reason="event"):
        """Ask for a pass now-ish from ANY real trigger. Merges; never starts a second chain.

        EVERYTHING that touches the chain happens under `self._lock` and through the generation
        counter, which is what makes "exactly one chain" true even when a real event arrives while a
        pass is running: the request disarms the pending timer and arms a new one, and the running
        pass's own re-arm is then refused because its generation is no longer current.
        """
        if self.schedule is None:
            return {"ok": False, "code": "no_timer"}
        at = self.now() + MIN_GAP_SECONDS
        with self._lock:
            if not self.running:
                return {"ok": False, "code": "not_running"}
            if self.state.get("autoArmed") is not True:
                return self._arm(at, reason)
            if self.due_at is not None and self.due_at <= at:
                return {"ok": True, "moved": False, "reason": reason}
            self._disarm()
            return self._arm(at, reason)

    def start(self, reason="startup"):
        """Start the chain. It is the ONLY place the chain begins, and it arms exactly one timer.

        It performs the CONTROLLED startup recovery first — once, before any work is advanced — because
        that is the one moment at which releasing the previous process's attempts is both safe and
        necessary. A failure there is recorded, never fatal: the chain still starts.
        """
        if self.schedule is None:
            return {"ok": False, "code": "no_timer"}
        with self._lock:
            if self.running:
                return {"ok": False, "code": "already_started"}
            self.running = True
            self.started_at = self.now()
            self._note(reason)
        recovered = None
        try:
            recovered = self.startup_recovery()
        except Exception:  # noqa: BLE001 — the chain itself does not depend on the recovery
            recovered = {"ok": False, "code": "recovery_failed"}
        # The startup recovery's own bounded counts are published with the chain, so what it released
        # is visible in the read-only status instead of being lost with the one call that ran it.
        if isinstance(recovered, dict) and isinstance(recovered.get("recovery"), dict):
            audit = recovered["recovery"]
            self.state["startupRecovery"] = {
                "at": self.now(),
                "interrupted": audit.get("interrupted") if isinstance(audit.get("interrupted"), int) else 0,
                "releasedTickets": audit.get("releasedTickets")
                if isinstance(audit.get("releasedTickets"), int) else 0}
        with self._lock:
            armed = self._arm(self.now() + MIN_GAP_SECONDS, reason)
        return {**armed, "recovery": recovered}

    def stop(self, reason="stop"):
        """Stop the chain for good. Idempotent, and never touches work already in flight."""
        with self._lock:
            self.running = False
            self._note(str(reason))
            self._disarm()
        return {"ok": True, "stopped": True}

    def startup_recovery(self):
        """Release what a DEAD process left behind. ONCE per chain, never from a pass.

        `recoverAutoPlans` voids every ticket of the previous process and releases its `running`
        plans. Calling it on a timer would void the tickets of attempts that are still in flight in
        THIS process, so it runs exactly once, at the start, and is idempotent afterwards.
        """
        with self._lock:
            if self.recovered:
                return {"ok": True, "duplicate": True}
            self.recovered = True
        answer = self._safe("recoverAutoPlans", {}, {})
        return {"ok": True, "recovery": answer if isinstance(answer, dict) else {}}

    def status(self):
        """Read-only: what this pass is doing, without running it."""
        return {"running": self.running, "busy": self.busy, "intervalSeconds": self.interval,
                "armed": self.state.get("autoArmed") is True, "passes": self.passes,
                "offset": self.offset, "events": list(self.events[-8:]), "last": self.last}

    def _note(self, reason):
        if isinstance(reason, str) and reason:
            self.events.append(reason)
            del self.events[:-8]

    def _arm(self, at, reason):
        """Arm ONE wake-up and return its generation. The caller holds `self._lock`."""
        self.chain += 1
        generation = self.chain
        self.state["autoArmed"] = True
        self.state["autoGeneration"] = generation
        self.due_at = at
        self.state["autoReason"] = reason
        delay = max(0.0, at - self.now())
        handle = self.schedule(self._fire, delay)
        self.handle = handle
        return {"ok": True, "armed": True, "generation": generation, "delay": delay, "reason": reason}

    def _disarm(self):
        """Cancel the pending wake-up and move the generation. The caller holds `self._lock`."""
        self.chain += 1
        self.state["autoArmed"] = False
        self.state["autoGeneration"] = self.chain
        self.due_at = None
        handle, self.handle = self.handle, None
        if handle is not None and self.cancel is not None:
            try:
                self.cancel(handle)
            except Exception:  # noqa: BLE001 — a stale handle is not a reason to lose the chain
                pass

    def _fire(self):
        """The timer's own body: run ONE pass, then re-arm — UNLESS the chain already moved on.

        The generation this callback was armed under is captured first. A real event that arrived
        while the pass was running disarmed this chain and armed a new one, which bumps the
        generation; the re-arm below is then refused, so the two can never become two live chains.
        """
        with self._lock:
            generation = self.state.get("autoGeneration")
            self.state["autoArmed"] = False
            self.handle = None
        try:
            if self.running:
                self.pass_once("timer")
        except Exception:  # noqa: BLE001 — a failed pass is recorded, never a dead chain
            self.last = {"ok": False, "code": "pass_failed", "at": self.now()}
        finally:
            with self._lock:
                current = self.state.get("autoGeneration")
                if self.running and self.schedule is not None and generation == current:
                    self._arm(self.now() + self.interval, "timer")

    # ── one bounded pass ───────────────────────────────────────────────────────────────────────
    def pass_once(self, reason="manual"):
        """Run ONE bounded pass. Serial by construction: a second call while one is running returns.

        The order is the design, not a convenience:

          1. the problem ledger's own bounded due feed — the reflection side of the same wake-up.
          2. `maintainLearning`: the natural expiry of a trial licence, through the core's rotated
             window, BEFORE new registrations (a version this pass retired must not be registered).
          3. registration of NEW work from the bounded, rotating candidate window.
          4. the DUE plans, advanced one at a time on the ONE physical slot.

        `recoverAutoPlans` is deliberately NOT in this sequence. It voids every ticket the previous
        process signed and releases its `running` plans, which is correct exactly ONCE, at process
        start, on a library nothing live is working in — and would be catastrophic on a timer, where
        it would void the tickets of attempts still in flight in THIS process. It runs in
        `startup_recovery()` instead.
        """
        if self.busy:
            return {"ok": False, "code": "busy"}
        if not self.running:
            return {"ok": False, "code": "not_running"}
        if not self.allow_reads:
            return {"ok": False, "code": "reads_disabled"}
        self.busy = True
        try:
            return self._pass(reason)
        finally:
            self.busy = False
            self.passes += 1

    def _pass(self, reason):
        token = self.state.setdefault("steps", {"used": 0})
        token["used"] = 0
        audit = {"ok": True, "reason": reason, "at": self.now(), "recovered": 0, "releasedTickets": 0,
                 "problems": None, "maintenance": None, "registered": 0, "advanced": 0,
                 "blocked": 0, "codes": [], "candidates": 0, "due": 0, "offset": self.offset,
                 "dueOffset": self.due_offset}

        def note(code):
            if isinstance(code, str) and code and len(audit["codes"]) < 8 and code not in audit["codes"]:
                audit["codes"].append(code)

        # (0) RECOVERY IS NOT HERE. `recoverAutoPlans` voids EVERY ticket of the previous process; on
        # a timer that would wipe the attempts still in flight in this one. It ran once, at start.

        # (1) THE PROBLEM LEDGER, on the SAME wake-up: its own bounded rotating due feed, and its own
        # persistent consideration cursor. This is the side that recovers a reflection whose first
        # attempt was stopped, and it deliberately answers to its own switch rather than to the paid
        # tracks' budget.
        audit["problems"] = self._problem_due()

        # (3) THE CORE'S OWN MAINTENANCE WINDOW: a trial licence that expired NATURALLY is retired
        # exactly once, which is what opens a renewal window and moves the edition's version.
        maintenance = self._safe("maintainLearning", {"limit": MAINTENANCE_WINDOW}, None)
        self._maintenance = maintenance if isinstance(maintenance, dict) else {}
        if isinstance(maintenance, dict):
            audit["maintenance"] = {"retired": maintenance.get("retired"), "reopened": maintenance.get("reopened"),
                                    "cursor": maintenance.get("cursor"), "backlog": maintenance.get("backlog")}
        retired = set()
        if isinstance(maintenance, dict) and isinstance(maintenance.get("rows"), list):
            for row in maintenance["rows"]:
                if isinstance(row, dict) and isinstance(row.get("lessonId"), str):
                    retired.add(row["lessonId"])

        # (4) NEW WORK from the bounded, rotating candidate window. A row whose edition this pass just
        # retired is DROPPED rather than registered: its plan would describe a version nobody answers
        # for, and the fresh row arrives on the next wake-up.
        feed = self._safe("autoCandidates", {"limit": CONSIDER_WINDOW}, None)
        rows = [row for row in (feed or {}).get("rows", []) if isinstance(row, dict)] \
            if isinstance(feed, dict) else []
        audit["candidates"] = len(rows)
        current = [row for row in rows if row.get("id") not in retired]
        if current:
            self._register(current, audit, note)

        # (5) THE DUE PLANS, through the persistent fair offset.
        self._advance(audit, note)

        # THE FAIR CURSOR IS ADVANCED WHENEVER THIS PASS REALLY CONSIDERED WORK, not only when it
        # managed to run some: a window of rows that were all skipped still moved the offset it
        # occupied, and a prefix of blocked rows must not pin the window for ever.
        considered = len(current)
        if considered > 0:
            self.offset = (self.offset + considered) % max(considered, 1)
            answer = self._safe("autoConsiderAdvance", {"step": considered}, None)
            if isinstance(answer, dict) and isinstance(answer.get("cursor"), int):
                audit["considerCursor"] = answer["cursor"]
            audit["offset"] = self.offset
        self.last = audit
        # The audit is ALSO published into the bridge's bounded pass document, which is what the
        # read-only surfaces report: one place the last pass can be read from, and no second scan.
        self.state["lastPass"] = audit
        self.state["passes"] = self.passes
        return audit

    # ── the problem side ───────────────────────────────────────────────────────────────────────
    def _problem_due(self):
        """Read the ledger's own bounded due window and publish the cursor it really reported.

        This pass does NOT attempt a reflection itself: the reflection attempt is driven by the
        problem's own recovery path in the bridge, which owns the source proof and the cancel flag
        for that session. What the pass publishes is the bounded, rotated VIEW — so the caller can
        see that due work exists without scanning the whole ledger, and the rotation really moves.
        """
        feed = self._safe("problemDueFeed", {"limit": PROBLEM_WINDOW}, None)
        if not isinstance(feed, dict):
            return {"ok": False, "code": "problem_feed_unavailable"}
        rows = [row for row in feed.get("rows", []) if isinstance(row, dict)]
        due = [row for row in rows if row.get("due") is True]
        summary = {"ok": True, "considered": len(rows), "due": len(due),
                   "dueTotal": feed.get("dueTotal") if isinstance(feed.get("dueTotal"), int) else 0,
                   "attempted": 0, "deferred": 0, "skipped": 0,
                   "ids": [row.get("id") for row in due if isinstance(row.get("id"), str)][:PROBLEM_WINDOW]}
        # AN ACTUAL ATTEMPT, on this same wake-up and on the SAME slot. A due row that this process can
        # still prove is handed to the bridge's existing recovery path (`problem_recovery_attempt`,
        # which is the same `_reflect` a live turn uses — source proof, admission, ONE driver, ticket
        # accounting); a row whose host facts are gone is DEFERRED with a positive wait rather than
        # dispatched on a guess, and a row the core already consumed is refused by the core itself, so
        # nothing is replayed. A stop switch, a pause or an unload ends the loop immediately.
        for row in due[:PROBLEM_WINDOW]:
            if not self._active():
                break
            if self.state["steps"]["used"] >= PER_PASS_STEPS:
                break
            attempt = self.hooks.problem_recovery_attempt(row) \
                if hasattr(self.hooks, "problem_recovery_attempt") else None
            slot = (attempt or {}).get("slot")
            if slot == "ran":
                summary["attempted"] += 1
                self.state["steps"]["used"] += 1
            elif slot == "deferred":
                summary["deferred"] += 1
                self.state["steps"]["used"] += 1
            else:
                summary["skipped"] += 1
        if rows and (due or summary["dueTotal"] > 0):
            self._safe("problemConsiderAdvance", {"step": len(rows)}, None)
        return summary

    # ── registration ───────────────────────────────────────────────────────────────────────────
    def _register(self, rows, audit, note):
        """Register the paid tracks for candidates that do not have a CURRENT plan yet.

        The plan identity is the CORE's: `autoPlanProposal` resolves the official pack, its own first
        case and the exact registration document, and `autoPlanRegister` is what writes it. This pass
        never chooses a case, never copies criteria and never names a pack.
        """
        budget = self.state["steps"]
        for row in rows:
            if audit["registered"] >= PER_PASS_REGISTRATIONS or budget["used"] >= PER_PASS_STEPS:
                break
            if not self._active():
                break
            lesson_id = row.get("id")
            version = row.get("version")
            environment = row.get("environment")
            if not isinstance(lesson_id, str) or not isinstance(version, int):
                continue
            if self._has_plan(lesson_id, version, row):
                continue
            source = self._plan_source(row)
            if source is None:
                # A candidate without a source session the host really observed cannot be registered:
                # there is nothing to prove the route from, and borrowing the newest session or a
                # profile default is exactly what must not happen.
                note("source_unknown")
                continue
            # Ordinary methods can be eligible for the same evidence backed reference trial as the
            # DSH scheduler. The core rechecks independent host evidence, domain coverage, checker
            # availability, version and scope; Hermes supplies identity only. Refusal is an expected
            # wait and never substitutes for the registered paid plan below.
            trial_value = {"lessonId": lesson_id, "expectedVersion": version}
            if isinstance(source.get("projectKey"), str) and source.get("projectKey"):
                trial_value["projectKey"] = source["projectKey"]
            trial = self._safe("grantEvidenceTrial", trial_value, None)
            if isinstance(trial, dict) and trial.get("ok") is True:
                audit["evidenceTrialsGranted"] = audit.get("evidenceTrialsGranted", 0) + 1
            elif isinstance(trial, dict) and isinstance(trial.get("code"), str):
                note("evidence_trial_" + trial["code"][:48])
            for track in ("review", "objective"):
                if audit["registered"] >= PER_PASS_REGISTRATIONS:
                    break
                # The SCOPE travels with the proposal: the core resolves the lesson by the scope its
                # own `projectKey` rule derives, so a proposal that omitted it would look for the
                # edition in the instance scope and report a perfectly registrable candidate as
                # unavailable. `environment` stays the core's own normalised value.
                proposal_value = {"lessonId": lesson_id, "version": version, "track": track,
                                  "source": source, "environment": environment}
                # THE SOURCE'S OWN PROVEN PROJECT IDENTITY, not the candidate row's. A candidate row
                # does not carry a raw project key (only the scope hash), so re-reading it here would
                # throw away exactly the identity `_plan_source` just proved from the original session
                # and downgrade the proposal to the instance scope. The project therefore travels WITH
                # the source through proposal, registration and the run.
                project = source.get("projectKey")
                if isinstance(project, str) and project:
                    proposal_value["projectKey"] = project
                proposal = self._safe("autoPlanProposal", proposal_value, None)
                if not isinstance(proposal, dict) or proposal.get("ok") is not True:
                    note((proposal or {}).get("code") if isinstance(proposal, dict) else "proposal_failed")
                    continue
                register_value = {"lessonId": lesson_id, "version": version, "environment": environment,
                                  "track": track, "source": source, "suite": proposal.get("suite"),
                                  "criteria": proposal.get("criteria"), "caseId": proposal.get("caseId")}
                if "projectKey" in proposal_value:
                    register_value["projectKey"] = proposal_value["projectKey"]
                answer = self._safe("autoPlanRegister", register_value, None)
                if not isinstance(answer, dict) or answer.get("ok") is not True:
                    note((answer or {}).get("code") if isinstance(answer, dict) else "register_failed")
                    continue
                if answer.get("duplicate") is not True:
                    audit["registered"] += 1

    def _has_plan(self, lesson_id, version, row):
        """Whether this edition already has a plan for EITHER track (a duplicate is not new work)."""
        try:
            plans = self.call("autoPlans", {})
        except Exception:  # noqa: BLE001
            return True
        if not isinstance(plans, list):
            return True
        tracks = {plan.get("track") for plan in plans if isinstance(plan, dict)
                  and plan.get("lessonId") == lesson_id and plan.get("version") == version}
        return {"review", "objective"}.issubset(tracks)

    def _plan_source(self, row):
        """The plan's SOURCE, from facts this host really observed — never a borrowed session.

        The session is the lesson's own origin session; the route is that session's proven dispatch
        facts (provider/model/api_mode/endpoint), which the caller looks up in its bounded map. A
        candidate whose session the host cannot describe today keeps `source_unknown`: the plan is
        not created, so nothing is ever charged for work nobody could prove.
        """
        session = row.get("sessionId")
        if not isinstance(session, str) or session == "":
            return None
        route = self.hooks.proven_route(session) if hasattr(self.hooks, "proven_route") else None
        if route is None:
            return None
        source = {"kind": "turn", "sessionId": session, "route": route}
        # THE ORIGINAL PROJECT IDENTITY, from the SAME trusted turn context the lesson came from.
        #
        # A candidate ROW does not carry the raw project key (only the scope hash), so reading it from
        # the row alone would silently lose the project. But the turn this session really ran DID state
        # it: the lifecycle writes the hook's own `project_key` (or the configured
        # `HERMES_MSE_PROJECT_KEY`) into that turn's `base`, and that is the identity the core hashed
        # into the lesson's scope. `plan_project_of` reads it back for ONE named session — no project
        # table is exposed and no scope is ever downgraded: a session that never stated a project stays
        # instance-scoped, exactly as before.
        project = self.hooks.plan_project_of(session) if hasattr(self.hooks, "plan_project_of") else None
        if not isinstance(project, str) or project == "":
            project = row.get("projectKey")
        if isinstance(project, str) and project:
            source["projectKey"] = project
        return source

    # ── plan advancement ───────────────────────────────────────────────────────────────────────
    def _advance(self, audit, note):
        """Advance the DUE plans, oldest attempt first, through the persistent fair offset.

        Every step here is a fact read from the core, and every paid run happens inside the ONE
        `ReflectionDriver` (same slot, same cleanup, same cancel). This pass never decides a stage: it
        asks the driver to run the plan and writes back the plan's own bounded bookkeeping.
        """
        try:
            plans = self.call("autoPlans", {})
        except Exception:  # noqa: BLE001
            note("plans_unavailable")
            return
        if not isinstance(plans, list):
            note("plans_unavailable")
            return
        now = self._now_ms()
        due = [plan for plan in plans if isinstance(plan, dict)
               and plan.get("track") in ("review", "objective")
               and plan.get("stage") in ("queued", "interrupted")
               and self._attempts_left(plan) and isinstance(plan.get("nextAttemptAt"), (int, float))
               and plan["nextAttemptAt"] <= now]
        # STABLE, DETERMINISTIC ORDER, then rotated by the persistent offset: the same pass over the
        # same document always makes the same choices, and a plan that keeps failing cannot pin the
        # front of the queue.
        due.sort(key=lambda plan: (plan.get("nextAttemptAt"), plan.get("planHash") or ""))
        audit["due"] = len(due)
        if not due:
            return
        # THE DUE-PLAN CURSOR IS ITS OWN, and it really moves. The rotation is over the plans that are
        # due RIGHT NOW (a length that changes as work arrives and finishes), so it is stored as an
        # absolute count of plans already taken from the front and reduced modulo the live length —
        # which is what makes a due plan behind a prefix of plans that cannot run reachable on a later
        # pass instead of the same head being retried for ever.
        # THE DUE-PLAN CURSOR IS PERSISTED IN THE CORE, not in this process: it lives in the core's
        # own scheduler document beside the registration cursor, so a rebuilt bridge resumes the
        # rotation instead of starting from the same head. It is read back here (a plain read) and
        # moved AFTER the pass, by the caller that really advanced plans, together with the window
        # width it observed.
        persisted = self._due_cursor()
        offset = persisted % len(due)
        ordered = due[offset:] + due[:offset]
        taken = 0
        audit["taken"] = []
        audit["dueCursor"] = persisted
        for plan in ordered[:PER_PASS_PLANS]:
            if not self._active():
                break
            if self.state["steps"]["used"] >= PER_PASS_STEPS:
                note("step_budget")
                break
            outcome = self._run_plan(plan)
            taken += 1
            # The IDENTITIES this pass really considered, so a caller can see that the window moved to
            # plans an earlier pass never reached instead of inferring it from a counter.
            audit["taken"].append(plan.get("planHash"))
            audit["advanced" if outcome in ("done", "queued") else "blocked"] += 1
            note(outcome)
        if taken > 0:
            # One transaction, through the same real caller that moved the registration cursor: it
            # advances the stored rotation by exactly the plans this pass took, modulo the window it
            # really saw.
            answer = self._safe("autoConsiderAdvance", {"step": 0, "due": taken, "dueCount": len(due)}, None)
            if isinstance(answer, dict) and isinstance(answer.get("dueCursor"), int):
                audit["dueCursor"] = answer["dueCursor"]
            self.due_offset = audit["dueCursor"]

    def _budget_allows(self, plan, lesson):
        """The CORE's own read-only verdict on whether this track may buy anything right now.

        A zero budget is a terminal "do not ask": the registration itself stays visible, but no paid
        request is ever issued. A view that cannot be read is treated exactly the same way — an
        unknown allowance is not permission.
        """
        value = {"lessonId": plan.get("lessonId"), "maxTokens": self._reservation(plan)}
        project = plan.get("source", {}).get("projectKey") if isinstance(plan.get("source"), dict) else None
        if isinstance(project, str) and project:
            value["projectKey"] = project
        # `environmentId` is deliberately NOT stated: the core's `environmentId` is a raw identity it
        # hashes itself, while a lesson row carries the already-NORMALISED environment. Passing the
        # normalised value back would hash it a second time and refuse the plan as an environment
        # mismatch. The lesson identity is what this view needs, and the plan already carries the
        # environment it was registered under.
        if plan.get("track") == "objective":
            value["expectedVersion"] = plan.get("version")
            answer = self._safe("evaluationPlan", value, None)
        else:
            answer = self._safe("reviewPlan", value, None)
        if not isinstance(answer, dict) or answer.get("ok") is not True:
            return False
        return answer.get("allowed") is True

    def _due_cursor(self):
        """The core's OWN persisted due-plan rotation offset, from THIS pass's maintenance answer.

        It rides with the registration cursor in one bounded response, so resuming the rotation costs
        no extra read; 0 means nothing is stored yet (a first run), which is a legitimate start.
        """
        maintenance = self._maintenance or {}
        value = maintenance.get("dueCursor") if isinstance(maintenance, dict) else None
        return value if isinstance(value, int) and value >= 0 else 0

    @staticmethod
    def _reservation(plan):
        return OBJECTIVE_TOKENS if plan.get("track") == "objective" else REVIEW_TOKENS

    def _attempts_left(self, plan):
        attempts = plan.get("attempts")
        maximum = plan.get("maxAttempts")
        if not isinstance(attempts, int) or not isinstance(maximum, int):
            return True
        return attempts < maximum

    def _run_plan(self, plan):
        """Hand ONE plan to the ONE driver and write back the plan's own bounded bookkeeping.

        THE ORDER IS THE CONTRACT, and it is in three explicit phases:

          1. ask the instance to PREPARE the job (may this plan run, and with which proven facts);
          2. register the plan as `running` in the CORE — once, before any physical call, so an
             attempt that really started is visible to crash recovery and to the fairness window;
          3. EXECUTE the prepared document on the one driver.

        A plan marked running after its dispatch would describe a step that was already paid for, and
        a prepare that also executed would make phase 2 impossible to place at all.
        """
        lesson = self._lesson_of(plan)
        if lesson is None:
            self._park(plan, "review_missing_criteria")
            return "review_missing_criteria"
        # THE ALLOWANCE IS ASKED BEFORE ANYTHING IS PREPARED. The gate is the CORE's own read-only
        # plan view, so a device whose paid budget is zero registers its work and buys NOTHING — no
        # request document, no reservation, no provider call — and the plan keeps its identity and its
        # attempts for the wake-up that may find the allowance changed.
        if not plan.get("ticket") and not self._budget_allows(plan, lesson):
            self._settle_stopped(plan, "review_budget")
            return "review_budget"
        prepared = self.hooks.plan_run(plan, lesson)
        if not isinstance(prepared, dict) or prepared.get("ok") is not True:
            code = (prepared or {}).get("wait") if isinstance(prepared, dict) else "plan_not_runnable"
            return self._settle_stopped(plan, code or "plan_not_runnable")
        started = self._safe("autoPlanUpdate", {"queueKey": plan.get("queueKey"), "planHash": plan.get("planHash"),
                                                "stage": "running", "ticket": plan.get("ticket"),
                                                "attempts": self._next_attempts(plan) if not plan.get("ticket")
                                                else plan.get("attempts", 0), "reason": None}, None)
        if not isinstance(started, dict) or started.get("ok") is not True:
            self._park(plan, (started or {}).get("code") if isinstance(started, dict) else "auto_plan_stale")
            return "auto_plan_stale"
        result = self.hooks.plan_execute(prepared["job"])
        if isinstance(result, dict) and isinstance(result.get("ticket"), str):
            plan = {**plan, "ticket": result["ticket"]}
        code = result.get("wait") if isinstance(result, dict) else None
        if isinstance(result, dict) and result.get("completed") is True and result.get("wait") is None:
            self._finish(plan, result)
            return "done"
        return self._settle_stopped(plan, code or "review_interrupted")

    def _finish(self, plan, result):
        """Write the plan's outcome from the CORE's own answer, never from this side's opinion."""
        verdict = result.get("result") if isinstance(result.get("result"), dict) else {}
        objective = plan.get("track") == "objective"
        decision = result.get("decision") if objective else verdict.get("state")
        evidence = "host_pack" if objective else "model_review"
        reason = None
        if isinstance(decision, str) and decision not in ("accepted", "reviewed"):
            reason = decision
        self._safe("autoPlanUpdate", {"queueKey": plan.get("queueKey"), "planHash": plan.get("planHash"),
                                      "stage": "done", "evidence": evidence, "ticket": None,
                                      "reason": reason}, None)

    def _park(self, plan, code):
        self._safe("autoPlanUpdate", {"queueKey": plan.get("queueKey"), "planHash": plan.get("planHash"),
                                      "stage": "blocked", "ticket": None, "reason": code}, None)

    def _settle_stopped(self, plan, code):
        """One stopped run, written back ONCE, with the core's own waiting semantics.

        The four outcomes stay apart on purpose: a cancelled or yielded run must not spend the plan's
        bounded retry budget, a host fact that could not be confirmed keeps the reservation and waits,
        and only a real provider failure consumes an attempt.
        """
        cancelled = code in CANCELLED_CODES
        unknown = code in UNKNOWN_CODES
        transient = code in TRANSIENT_CODES
        waiting = code in WAIT_CODES
        unmeasured = code == "ticket_usage_unknown"
        attempts = plan.get("attempts") if isinstance(plan.get("attempts"), int) else 0
        spend_attempt = not (cancelled or unknown or waiting or unmeasured)
        next_attempts = attempts + 1 if spend_attempt else attempts
        maximum = plan.get("maxAttempts") if isinstance(plan.get("maxAttempts"), int) else 2
        if unmeasured:
            stage = "blocked"
        elif cancelled or unknown or waiting:
            stage = "queued"
        elif transient and next_attempts < maximum:
            stage = "queued"
        else:
            stage = "blocked"
        if unmeasured:
            delay = BUDGET_RETRY_SECONDS
        elif cancelled:
            delay = YIELD_RETRY_SECONDS
        elif unknown or waiting:
            delay = BUDGET_RETRY_SECONDS
        else:
            index = min(max(next_attempts - 1, 0), len(BACKOFF_SECONDS) - 1)
            delay = BACKOFF_SECONDS[index]
        self._safe("autoPlanUpdate", {"queueKey": plan.get("queueKey"), "planHash": plan.get("planHash"),
                                      "stage": stage, "ticket": plan.get("ticket") if waiting else None,
                                      "reason": code,
                                      "attempts": next_attempts,
                                      "nextAttemptAt": self._now_ms() + int(delay * 1000)}, None)
        return code

    def _next_attempts(self, plan):
        attempts = plan.get("attempts") if isinstance(plan.get("attempts"), int) else 0
        return attempts + 1

    def _lesson_of(self, plan):
        """The COMPLETE facts of one plan's lesson, from the core's own per-id index.

        The candidate feed is a bounded registration window, so a live plan it did not carry must not
        be parked as "missing criteria": the facts are looked up by identity instead.
        """
        answer = self._safe("autoCandidateFacts", {"lessonId": plan.get("lessonId")}, None)
        if isinstance(answer, dict) and answer.get("ok") is True and isinstance(answer.get("row"), dict):
            return answer["row"]
        return None

    # ── seams ──────────────────────────────────────────────────────────────────────────────────
    def _active(self):
        try:
            return self.hooks.auto_pass_allowed()
        except Exception:  # noqa: BLE001 — an unreadable permission is not permission
            return False

    def _now_ms(self):
        hook = getattr(self.hooks, "wall_ms", None)
        if callable(hook):
            try:
                value = hook()
                if isinstance(value, (int, float)):
                    return int(value)
            except Exception:  # noqa: BLE001
                pass
        import time
        return int(time.time() * 1000)

    def _safe(self, op, value, fallback):
        try:
            answer = self.call(op, dict(value))
        except Exception:  # noqa: BLE001 — a transport failure is a wait, never a local guess
            return fallback
        return answer if answer is not None else fallback


def build_auto_pass(hooks, *, call, clock, state, interval=None, allow_reads=True, now=None,
                    schedule=None, cancel=None):
    return AutoPass(hooks, call=call, clock=clock, state=state, interval=interval,
                    allow_reads=allow_reads, now=now, schedule=schedule, cancel=cancel)
