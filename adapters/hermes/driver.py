"""Stage 4b — the ONE reflection driver whose capability this build has actually proved.

What this module is allowed to be is narrow on purpose. It is not a policy engine, a budget, an
evidence gate or a scheduler: the Node core owns every one of those, inside its own write
transaction. What lives here is the part the core cannot have —

  * the REAL provider dispatch (one `chat.completions.with_raw_response.create`, `max_retries=0`,
    no `call_llm`, no tools, no model fallback),
  * the raw HTTP usage read that a typed response cannot prove,
  * the asyncio Task / client / cancellation boundary, including the rule that a cancelled call is
    still DRAINING until the underlying work is really over,
  * the shared physical slot every paid job goes through, and
  * the last local check after the last `await` and immediately before the dispatch.

Everything it learns about the source is a fact it can POINT AT in the host: `provider`, `model`,
`base_url`, `api_mode` from the real `pre_api_request`, and the final body's own reasoning field.
Nothing is filled in from a profile default, and a fact that cannot be proved is reported as such
(`unknown`) rather than guessed — a driver that guessed would make an unprovable route look bound.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time

# The bounded vocabulary this module may report. They are the shared core's own problem-defer codes
# plus the local "no work was done" states; a driver that invents a new string would put free text
# into a durable status surface.
DRIVER_WAITS = frozenset({
    "provider_driver_unsupported", "source_reasoning_unavailable", "source_endpoint_unavailable",
    "source_route_changed", "source_stale_revision", "source_unknown", "source_capacity",
    "control_changed", "control_paused", "control_source_stopped", "control_unavailable",
    "source_binding_mismatch", "reflection_refused", "reflection_no_ticket", "driver_disabled",
    "cancelled", "slot_busy",
})
# The reasoning states the CORE understands. This module only ever publishes `explicit` or
# `unspecified`, because those are the two it can prove from a real body it actually read.
REASONING_EXPLICIT = "explicit"
REASONING_UNSPECIFIED = "unspecified"
REASONING_UNKNOWN = "unknown"
# The reasoning field names the OpenAI-compatible wire accepts. A body carrying one of these with a
# readable string value is `explicit`; a body that exists and carries none of them is `unspecified`.
REASONING_FIELDS = ("reasoning_effort", "reasoningEffort")
# A single reflection's own deadline. The core's ticket lives 5 minutes; this stays well inside it.
DEFAULT_JOB_TIMEOUT = 60.0
# The paid tracks a review/objective run may execute in ONE job. A review is 4 steps and the objective
# track is two per frozen case, so this is a bounded SANITY ceiling, not a work budget: it exists so a
# provider that never lets the walk terminate cannot keep the slot for ever.
OBJECTIVE_MAX_STEPS = 256
MULTI_STEP_MAX = 24
# How long the loop thread may take to shut down before it is abandoned (never joined for ever).
LOOP_JOIN_SECONDS = 5.0


def decision_dispatch_deadline(timeout_ms):
    """Scale the coroutine's process deadline to the provider deadline plus finite drain overhead."""
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 100 <= timeout_ms <= 120_000:
        raise ValueError("invalid_timeout")
    return timeout_ms / 1000.0 + 10.0


def utf16_units(value):
    """The core measures every bounded string in UTF-16 code units; so does this side."""
    try:
        return len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return len(value.encode("utf-8", "surrogatepass").decode("utf-8", "replace").encode("utf-16-le")) // 2


def bounded(value, maximum):
    """A host-supplied identity scalar, or None when it is not one."""
    if not isinstance(value, str) or value == "":
        return None
    if utf16_units(value) > maximum:
        return None
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        return None
    return value


def request_body(kwargs):
    """The real `pre_api_request` request body, or None when this host did not hand one over.

    The emitter passes `request=agent._api_request_payload_for_hook(api_kwargs)`, whose shape is
    `{"method": "POST", "body": {...}}`. The sanitizer may REDACT a sensitive key or TRUNCATE the
    whole payload; both make the body unusable as proof, so they are reported as unusable instead of
    being read as "the field was absent".
    """
    request = kwargs.get("request")
    if not isinstance(request, dict):
        return None
    if request.get("_truncated") is True:
        return None
    body = request.get("body")
    if not isinstance(body, dict):
        return None
    return body


def reasoning_of(body):
    """`(state, value)` for one real request body. Never a guess, never a default.

    * `explicit`     — a bounded string value is present under one of the accepted names
    * `unspecified`  — the body is readable and carries none of those fields
    * `unknown`      — no body, a truncated one, or a value that is not a bounded string
      (`<redacted>` included: a redacted value is not evidence that nothing was sent)
    """
    if body is None:
        return REASONING_UNKNOWN, None
    present = [name for name in REASONING_FIELDS if name in body]
    if not present:
        return REASONING_UNSPECIFIED, None
    for name in REASONING_FIELDS:
        if name not in body:
            continue
        value = body[name]
        if isinstance(value, str) and value != "" and utf16_units(value) <= 16 \
                and not any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
            return REASONING_EXPLICIT, value
    return REASONING_UNKNOWN, None


def wire_conflicts(body):
    """Whether the body carries something that can change the FINAL wire and cannot be proved.

    `extra_body` is merged into the outgoing JSON by the SDK, so it can override `model` and the
    reasoning field after the hook has seen the body. `_truncated`/`_redacted` markers mean the hook
    payload was cut down. Neither can be reasoned about — the minimal supported branch WAITS.
    """
    if body is None:
        return True
    for name in ("extra_body", "extra_headers", "_truncated", "_truncated_items", "_redacted"):
        if name in body:
            value = body[name]
            if isinstance(value, dict) and not value and name in ("extra_body", "extra_headers"):
                continue
            if value in (None, False, "", 0):
                continue
            return True
    return False


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_endpoint(value):
    """The same canonical endpoint the core computes, or None when it must be REFUSED.

    This mirrors `src/sources.mjs` `normalizeEndpoint` exactly, including its conservative refusals:
    credentials in the URL, a query string, a fragment, a repeated slash, a non-HTTP scheme or an
    over-long value are all refused rather than cleaned. The PATH is kept in full — trimming it
    would make two different execution endpoints compare equal. The returned string is used only to
    compare an endpoint and to fingerprint it; it is never stored, echoed or logged.
    """
    if not isinstance(value, str) or value == "" or len(value) > 2048:
        return None
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        return None
    from urllib.parse import urlsplit
    try:
        parts = urlsplit(value)
    except Exception:  # noqa: BLE001
        return None
    if parts.scheme not in ("http", "https"):
        return None
    if parts.username is not None or parts.password is not None:
        return None
    if parts.query != "" or parts.fragment != "":
        return None
    host = (parts.hostname or "").lower()
    if host == "":
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    if port is None:
        port = 443 if parts.scheme == "https" else 80
    if not isinstance(port, int) or port < 0 or port > 65535:
        return None
    path = parts.path or ""
    if "//" in path:
        return None
    path = path.rstrip("/")
    text = "%s://%s:%d%s" % (parts.scheme, host, port, path)
    return text if len(text) <= 400 else None


def endpoint_fingerprint(value):
    """The core's domain-prefixed endpoint fingerprint, or None."""
    endpoint = canonical_endpoint(value)
    return None if endpoint is None else hashlib.sha256(
        ("mse-endpoint-v1:" + endpoint).encode("utf-8")).hexdigest()


def session_hash(session_id):
    """The core's own `sessionHash`: SHA-256 over the UTF-8 bytes of the raw id."""
    if not isinstance(session_id, str) or session_id == "" or utf16_units(session_id) > 512:
        return None
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in session_id):
        return None
    try:
        data = session_id.encode("utf-8")
    except UnicodeEncodeError:
        data = session_id.encode("utf-8", "surrogatepass").decode("utf-8", "replace").encode("utf-8")
    return hashlib.sha256(data).hexdigest()


class ProviderIdentity:
    """The proven identity of one dispatch.

    `base_url` is the ONE secret-bearing field here and it never leaves this process: it is passed
    straight into the client constructor and is deliberately absent from `publishable()` and
    `summary()`, which are what travel to the core and into status output. The core stores a
    domain-prefixed fingerprint of it instead, computed on the Node side from the value this class
    hands over for exactly one call.
    """

    __slots__ = ("provider", "model", "api_mode", "base_url", "reasoning_state", "reasoning_value",
                 "client_factory", "credential")

    def __init__(self, provider, model, api_mode, base_url, reasoning_state, reasoning_value,
                 client_factory=None, credential=None):
        self.provider = provider
        self.model = model
        self.api_mode = api_mode
        self.base_url = base_url
        self.reasoning_state = reasoning_state
        self.reasoning_value = reasoning_value
        # Held in memory only, for the lifetime of one dispatch. Never persisted, never returned.
        self.client_factory = client_factory
        self.credential = credential

    def publishable(self):
        """The fields the core may store: bounded identity scalars, never a credential.

        `baseUrl` is handed over so the CORE can fingerprint it; nothing else about the endpoint is
        sent, and nothing about it comes back.
        """
        return {"provider": self.provider, "model": self.model, "apiMode": self.api_mode,
                "baseUrl": self.base_url, "reasoningState": self.reasoning_state,
                "reasoningValue": self.reasoning_value if self.reasoning_state == REASONING_EXPLICIT else None,
                "driver": "async_openai_chat"}

    def summary(self):
        """The non-secret projection of this identity: no endpoint, in any form."""
        return {"provider": self.provider, "model": self.model, "apiMode": self.api_mode,
                "reasoningState": self.reasoning_state,
                "reasoningValue": self.reasoning_value if self.reasoning_state == REASONING_EXPLICIT else None}


# JavaScript cannot represent an integer above this exactly, and the usage crosses that boundary to
# the Node core. A larger value cannot be carried as the measurement it claims to be.
MAX_SAFE_INTEGER = 9007199254740991


def parse_usage(payload):
    """The RAW usage a response's own JSON carried, or `None` when it did not carry a usable one.

    This runs on the HTTP JSON, never on the typed completion: the SDK coerces a wire string
    (`"11"`) into an integer, so a typed-only check accepts a payload that was never valid.

    The measurement is usable only when it is COMPLETE and SELF-CONSISTENT: all three fields must be
    present, each must be a non-negative integer that fits a JavaScript safe integer (the number
    crosses into Node exactly as it is), and `total` must equal the sum of the other two. A partial
    payload, a missing field, a boolean, a float, a negative value, an integer too large to survive
    the crossing, or a `total` that disagrees with its own parts is `None` — never 0, and never a
    "known" row with a hole in it, because 0 is a measurement and "we could not read it" is not. An
    unknown usage still consumes the attempt: it is reported as unknown and blocks promotion instead
    of being rounded down to free.
    """
    if not isinstance(payload, dict):
        return None
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    counted = {}
    for name in ("prompt_tokens", "completion_tokens", "total_tokens"):
        if name not in usage:
            return None
        value = usage[name]
        # `bool` is an `int` in Python; a JSON `true` is not a token count.
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_SAFE_INTEGER:
            return None
        counted[name] = value
    prompt = counted["prompt_tokens"]
    completion = counted["completion_tokens"]
    total = counted["total_tokens"]
    if total != prompt + completion:
        return None
    return {"promptTokens": prompt, "completionTokens": completion, "totalTokens": total, "known": True}


class ReflectionSlot:
    """The ONE physical slot every paid job goes through, with an honest draining state.

    `peak` is the high-water mark of jobs that were simultaneously inside the slot. `draining` is
    true from the moment a job asks to stop until the underlying work is really finished: a
    cancellation is a REQUEST, not a fact, and a task that ignores it keeps the slot — which is the
    only way "the previous request is over" can ever be claimed.
    """

    def __init__(self):
        self.busy = False
        self.draining = False
        self.peak = 0
        self.active = 0
        self.completed = 0
        self.cancels = 0
        self.tasks = {}

    def acquire(self, key):
        if self.busy or self.draining:
            return False
        self.busy = True
        self.active += 1
        self.peak = max(self.peak, self.active)
        return True

    def release(self, key):
        self.busy = False
        self.active = max(0, self.active - 1)
        self.tasks.pop(key, None)

    def drain(self, key, task):
        """Mark the slot as draining until `task` is genuinely done."""
        self.draining = True
        self.cancels += 1
        self.tasks[key] = task

    def settle(self, key):
        self.tasks.pop(key, None)
        self.draining = False
        self.completed += 1

    def status(self):
        return {"busy": self.busy, "draining": self.draining, "peak": self.peak, "active": self.active,
                "completed": self.completed, "cancels": self.cancels, "pendingTasks": len(self.tasks)}


class ReflectionDriver:
    """A real single-attempt reflection driver over the shared Node core.

    `hooks` supplies the trusted core call and the host facts; everything else here is the physical
    side. The class is deliberately constructible with a fake `chat_factory` and a fake `resolve`,
    which is how the offline business tests exercise the REAL control flow without a network.
    """

    def __init__(self, hooks, resolver=None, client_factory=None, loop_factory=None,
                 job_timeout=DEFAULT_JOB_TIMEOUT, profile_home=None, allow_direct_client=True):
        self.hooks = hooks
        self.resolver = resolver or self._host_resolver
        self.client_factory = client_factory or self._client_for
        self.allow_direct_client = allow_direct_client
        self.job_timeout = job_timeout
        self.slot = ReflectionSlot()
        self.last = None
        self.waits = {}
        self.dispatches = 0
        self.cancelled = 0
        self._lock = threading.Lock()
        self._loop = None
        self._thread = None
        self._loop_factory = loop_factory
        # The profile this driver was created for, captured HERE (factory time, on the thread that
        # knows it). It is re-established inside the loop thread for the WHOLE await region, never
        # just around the synchronous entry point.
        self.profile_home = profile_home
        # Every job this driver has started and not yet finished, keyed by id. It survives a bridge
        # that clears its own job list during a pause, which is what lets an unload still find — and
        # withdraw — the work that is really in flight. An entry is released by `_retire` only once
        # the job Task AND its owner-side cleanup have really ended: while an attempt is in flight,
        # or still draining, it stays registered so it can still be reached and cancelled.
        self.jobs = {}
        # What the registry keeps AFTER an entry is released: bounded counters only — never a prompt,
        # a route or a session. A finished attempt leaves its dispatch facts behind with its entry.
        self.retired = {"jobs": 0, "committed": 0, "cancelled": 0, "closed": 0, "refused": 0,
                        "other": 0}
        self._shutting_down = False
        self.shutdown = None

    # ── host facts ────────────────────────────────────────────────────────────────────────────
    def _host_resolver(self, provider, model):
        """Resolve the CURRENT authorized runtime for this provider/model. Read-only, no dispatch."""
        from hermes_cli.runtime_provider import resolve_runtime_provider
        return resolve_runtime_provider(requested=provider, target_model=model)

    def _client_for(self, identity, runtime):
        """Build this job's OWN client for a runtime the caller already checked. Never shared.

        `resolve_provider_client` is the Host's own centralized router: it applies the provider's
        auth, headers and wire format and hands back an independent client (`_to_async_client` sets
        `max_retries=0` on the plain OpenAI path). Only the IN-MEMORY runtime the resolver just
        returned is passed in, and nothing is persisted: the credential exists for the lifetime of
        this one dispatch.
        """
        from agent.auxiliary_client import resolve_provider_client
        client, resolved_model = resolve_provider_client(
            identity.provider, model=identity.model, async_mode=True,
            explicit_base_url=runtime.get("base_url"), explicit_api_key=runtime.get("api_key"),
            api_mode=runtime.get("api_mode"))
        return client, resolved_model

    def _direct_client_for(self, identity, runtime):
        """The fallback: a plain `AsyncOpenAI` built from the SAME in-memory runtime.

        It exists because the Host router may answer `(None, None)` for a provider whose auxiliary
        lane is simply not configured — a text-only auxiliary task is not the same thing as "this
        provider cannot be called". The client is still built from the resolver's own credential and
        endpoint, never from a profile default, and it is still re-checked by `_bind_client`.
        """
        from openai import AsyncOpenAI
        kwargs = {"api_key": runtime.get("api_key") or "no-key-required",
                  "base_url": runtime.get("base_url"), "max_retries": 0}
        headers = runtime.get("extra_headers")
        if isinstance(headers, dict) and headers:
            kwargs["default_headers"] = {str(key): str(value) for key, value in headers.items()}
        return AsyncOpenAI(**kwargs), identity.model

    def build_client(self, identity, runtime):
        """The one place a client is chosen, so the fallback cannot bypass the re-check."""
        try:
            client, resolved = self.client_factory(identity, runtime)
        except Exception:  # noqa: BLE001 — a router failure is not a licence to guess
            client, resolved = None, None
        if client is not None:
            return client, resolved
        if self.allow_direct_client is not True:
            return None, None
        try:
            return self._direct_client_for(identity, runtime)
        except Exception:  # noqa: BLE001
            return None, None

    # ── identity ──────────────────────────────────────────────────────────────────────────────
    def prove(self, provider, model, kwargs):
        """Prove an identity from the host's own facts, or return the reason it cannot be proved.

        The order matters and is the whole safety argument:

          1. read the REAL `pre_api_request` facts (provider/model/base_url/api_mode, real body);
          2. refuse anything the hook itself cannot vouch for (`extra_body`, truncation);
          3. resolve the CURRENT authorized runtime for that provider/model;
          4. require the resolved provider to be the one that was asked for — a collapsed named
             custom provider (`custom`) or any other substitution is a DIFFERENT execution;
          5. build the job's own client and check it again: a real `AsyncOpenAI`, chat_completions,
             `max_retries=0`, and the same endpoint.

        A refusal is a WAIT. It never falls back to a profile default and never sends a credential
        to an endpoint the resolver did not just name.
        """
        route_provider = bounded(kwargs.get("provider"), 32)
        route_model = bounded(kwargs.get("model"), 64)
        if route_provider is None or route_model is None:
            return None, "provider_driver_unsupported"
        if provider is not None and route_provider != provider:
            # The turn's own record and the dispatch disagree: that is drift, not a source.
            return None, "source_route_changed"
        if model is not None and route_model != model:
            return None, "source_route_changed"
        body = request_body(kwargs)
        if wire_conflicts(body):
            return None, "provider_driver_unsupported"
        body_model = body.get("model") if body is not None else None
        if isinstance(body_model, str) and body_model != route_model:
            # The host's final body names a different model than its own attribute: middleware can
            # change the body, and the body is what actually goes on the wire.
            return None, "source_route_changed"
        state, value = reasoning_of(body)
        if state == REASONING_UNKNOWN:
            return None, "source_reasoning_unavailable"
        # ── The hook must have PROVEN the endpoint and the protocol itself ──────────────────────
        # The resolver cannot stand in for either: it answers what a NEW dispatch would use, not what
        # the evidence was produced under. Borrowing its endpoint would turn "we do not know which
        # execution this was" into a binding, which is exactly the substitution this gate exists to
        # prevent. A missing or unusable value is therefore an explicit WAIT, before any ticket.
        base_url = bounded(kwargs.get("base_url"), 2048)
        if base_url is None:
            return None, "source_endpoint_unavailable"
        api_mode = bounded(kwargs.get("api_mode"), 32)
        if api_mode is None:
            return None, "provider_driver_unsupported"
        if api_mode != "chat_completions":
            return None, "provider_driver_unsupported"
        runtime = self.resolver(route_provider, route_model)
        if not isinstance(runtime, dict):
            return None, "provider_driver_unsupported"
        resolved_provider = runtime.get("provider")
        if not isinstance(resolved_provider, str) or resolved_provider != route_provider:
            # `custom` (a collapsed named/aliased provider), `auto`, `moa`, an OAuth store, an
            # external process, bedrock/codex/anthropic: none of them can be shown to BE the
            # endpoint the turn ran on, so none of them is an identity this build dispatches on.
            return None, "provider_driver_unsupported"
        # The resolver's protocol must AGREE with the hook's. It may not silently supply one the hook
        # never stated, and the two answers must not differ.
        resolved_mode = runtime.get("api_mode")
        if resolved_mode is None:
            return None, "provider_driver_unsupported"
        if resolved_mode != api_mode or resolved_mode != "chat_completions":
            return None, "provider_driver_unsupported"
        effective_mode = api_mode
        resolved_base = runtime.get("base_url")
        if not isinstance(resolved_base, str) or resolved_base == "":
            return None, "source_endpoint_unavailable"
        # An endpoint that cannot be canonicalized without dropping something meaningful is not an
        # identity: it is refused HERE, before any publish, so no surface ever sees the raw value.
        if canonical_endpoint(resolved_base) is None:
            return None, "source_endpoint_unavailable"
        # The dispatch endpoint is the RESOLVER's — a fresh credential must never be steered at a
        # stale hook value — but it must be the SAME endpoint the hook proved. A difference (a
        # rotated endpoint, a modified route) is a different execution and a WAIT.
        if not _same_endpoint(base_url, resolved_base):
            return None, "source_route_changed"
        resolved_model = runtime.get("model")
        if isinstance(resolved_model, str) and resolved_model not in ("", route_model):
            return None, "source_route_changed"
        identity = ProviderIdentity(route_provider, route_model, effective_mode, resolved_base, state, value)
        return {"identity": identity, "runtime": runtime}, None

    def _bind_client(self, identity, runtime):
        """Build and re-check the job's OWN client. Returns `(client, reason)`."""
        client, resolved_model = self.build_client(identity, runtime)
        if client is None:
            return None, "provider_driver_unsupported"
        try:
            from openai import AsyncOpenAI
        except Exception:  # noqa: BLE001 — no SDK, no supported driver
            return None, "provider_driver_unsupported"
        if not isinstance(client, AsyncOpenAI):
            # Codex/Anthropic/Bedrock/Gemini/ACP shims and MoA facades are all "a client", and none
            # of them is the plain Chat Completions seam this build proved.
            return None, "provider_driver_unsupported"
        if resolved_model is not None and isinstance(resolved_model, str) and resolved_model != "" \
                and resolved_model != identity.model:
            return None, "source_route_changed"
        base = str(getattr(client, "base_url", "") or "")
        if base == "" or not _same_endpoint(base, identity.base_url):
            return None, "source_route_changed"
        if getattr(client, "max_retries", None) != 0:
            return None, "provider_driver_unsupported"
        return client, None

    def _absorb_step(self, call, state, step):
        """Fold ONE step's measurement into the RUN's merged quality and persist it IMMEDIATELY.

        Order is the whole point and it is the same rule the reflection path follows for its single
        call: read the raw usage off the wire, put it into the shared cell, THEN let the next `await`
        happen. The persistence is a separate IPC call (`ticketUsage`) that grants no credit, so a
        crash, a cancellation or a late answer cannot turn an unmeasured step into a measured one —
        and cannot lose the tokens a provider already reported.
        """
        spend = state.setdefault("spend", {"known": 0, "unknown": 0})
        for answer in (step or {}).values():
            if not isinstance(answer, dict):
                continue
            tokens = answer.get("tokens")
            if isinstance(tokens, int) and tokens >= 0:
                spend["known"] += tokens
            else:
                # An unreadable step latches for the WHOLE run. It is deliberately not folded in as
                # zero: "we could not read it" and "it really was nothing" are different facts.
                spend["unknown"] += 1
        self._persist_usage(call, state)
        return spend["known"], spend["unknown"]

    def _persist_usage(self, call, state):
        """Persist the run's measurement so far through the core's own non-terminal merger.

        It is called after EVERY step, BEFORE the next physical call is awaited. The merged QUALITY
        travels with it, so a step reported as unreadable latches `known: false` for the whole run
        even when a later frame looks measured.
        """
        ticket = state.get("ticket")
        spend = state.get("spend")
        if ticket is None or not isinstance(spend, dict):
            return None
        return _ticket_usage(call, ticket, spend["known"], spend["unknown"])

    def _settle_usage(self, call, state):
        """Record the FINAL merged measurement once the run's own commit is done.

        The commit transaction settles the ticket with its own reading of the answers, so this is the
        bookkeeping that keeps the ticket's row equal to what really happened — and it runs ONCE, on
        the outcome each track really reached: a committed run closes its ticket (nothing is left for
        the end-of-run settle), while a stopped one reports the merged measurement and marks the fact
        as reported so the same numbers are not written twice.
        """
        ticket = state.pop("ticket", None)
        spend = state.get("spend")
        if ticket is None or not isinstance(spend, dict):
            return None
        return _ticket_usage(call, ticket, spend["known"], spend["unknown"])

    # ── the paid tracks ────────────────────────────────────────────────────────────────────────
    def _reserve(self, kind, job, call):
        """Sign ONE ticket for this run, through the core's own request transaction.

        A refusal here signs nothing and reserves nothing, so the plan's own attempt marker is not
        consumed and the wait stays recoverable. Everything the request needs beyond the run's frozen
        identity comes from the job, which the bridge built from the plan and from facts the ORIGINAL
        session really published — never from a profile default.

        `controlGeneration` is an OPTIONAL part of the core's binding: the transport refuses a value
        that is present but not a safe integer, and silence is a legitimate binding. A generation this
        host has not read is therefore OMITTED rather than sent as `null` (the same rule the released
        reflection path follows), while a generation that WAS read travels as the caller's own fact.
        """
        existing = job.get("ticket")
        if isinstance(existing, str) and existing:
            live = call("ticketContinuation", {"ticket": existing, "kind": "evaluation" if kind == "objective" else "review"})
            return {"ok": True, "ticket": existing, "source": live.get("job", {}).get("source"),
                    **({} if live.get("ok") is True else {"ok": False, "wait": live.get("code", "ticket_consumed")})}
        binding = {"lessonId": job.get("lessonId"), "expectedVersion": job.get("version"),
                   "maxTokens": 2, "stepwiseBudget": True,
                   "steps": 1, "inputChars": 1, "stepOutputTokens": 1,
                   "planHash": job.get("planHash"), "queueKey": job.get("queueKey"),
                   "sourceBinding": True, "sessionId": job.get("source_session")}
        # OPTIONAL IDENTITIES ARE OMITTED, NEVER SENT AS NULL. The core's own label check accepts a
        # bounded string or absence, and a `null` is neither: it refuses the whole request as
        # `invalid_input`. An instance-scoped plan really has no project key, so the field is left out
        # rather than filled with a placeholder that would also be a wrong identity.
        project = job.get("projectKey")
        if isinstance(project, str) and project:
            binding["projectKey"] = project
        # `environmentId` is deliberately NOT sent even when the job carries one: the core's
        # `environmentId` is a RAW identity it hashes itself, while the plan's environment is already
        # the normalised hash — sending it back would hash it a second time and refuse the request as
        # `environment_mismatch`. The plan binds the environment on its own side, and the source gate
        # compares the identity it was published under, so nothing here needs to restate it.
        source = job.get("source") or {}
        binding["sourceRevision"] = source.get("revision")
        binding["sourceBindingHash"] = source.get("bindingHash")
        if isinstance(source.get("controlGeneration"), int):
            binding["controlGeneration"] = source["controlGeneration"]
        replay_cases = job.get("taskReplayCases")
        if kind == "objective" and isinstance(replay_cases, list) and replay_cases:
            binding["taskReplayCases"] = [{"id": row.get("id"),
                "badFixtureHash": row.get("badFixtureHash"),
                "controlFixtureHash": row.get("controlFixtureHash")} for row in replay_cases
                if isinstance(row, dict)]
        if kind == "review":
            return call("reviewRequest", binding)
        if kind == "objective":
            return call("evaluationRequest", binding)
        return {"ok": False, "wait": "provider_driver_unsupported"}


    def _review_material(self, call, ticket):
        """The NEXT step's material AND the core's own permission for it, in ONE bounded read.

        `reviewMaterial` ends in `ticketContinuation`, so a ticket whose permission was withdrawn —
        a pause, an exact stop, a control change, a re-registered or terminal plan, a rotated pack, a
        withdrawn licence, an already-incurred overrun — is refused HERE, before the paid call, and
        the refusal is the answer (never material this host is no longer allowed to run).
        """
        return call("reviewMaterial", {"ticket": ticket})

    def _judge_request(self, call, ticket, answers, index):
        """The core's own BLIND judge request for ONE pass, with the core's private label ledger."""
        return call("reviewJudge", {"ticket": ticket, "armA": answers["candidate"]["text"],
                                    "armB": answers["baseline"]["text"], "pass": index})

    def _objective_material(self, call, ticket, cursor):
        """ONE frozen case of the objective walk, gated by the same continuation predicate."""
        return call("objectiveMaterial", {"ticket": ticket, "cursor": cursor})

    def prepare_source(self, call, job):
        """Prove and publish ONE turn's source identity, through the same steps `_job` takes.

        This is the lifecycle seam the bridge calls BEFORE it asks the core whether the source may be
        reflected on, because the core can only answer about an identity this host has really
        published — and on a cold library nothing has been. It is deliberately the SAME `prove` and
        the SAME `_bind_source` the dispatch path uses, so the identity a ticket is later signed
        against is the identity this call published, with no second implementation to drift from it.

        It runs on the caller's background thread, NOT on the driver's loop, so it must establish the
        profile binding ITSELF: `prove` calls the resolver, and a resolver that ran under whatever
        profile the worker thread happens to carry would be answering for a different account than
        the one the factory was created for. The binding is entered for the WHOLE preparation
        (resolution included) and reset in a `finally`, so a failure restores the caller's own value
        exactly as a success does.

        It is synchronous and uses no loop: it only resolves the route, checks it, and publishes a
        bounded fact. No client is built and no provider is contacted.

        Returns `{"ok": True, "source": {...}}` or `{"ok": False, "wait": code}`.
        """
        return self._with_profile(lambda: self._prepare_source_bound(call, job))

    def _prepare_source_bound(self, call, job):
        """`prepare_source` inside this driver's profile binding. Separated so the binding cannot be
        forgotten on one of the two exits: both go through the same wrapper."""
        proven, reason = self.prove(job.get("route_provider"), job.get("route_model"),
                                    job.get("pre_api") or {})
        if proven is None:
            return {"ok": False, "wait": reason}
        bound = _bind_source(call, proven["identity"], job, job.get("problem") or {})
        if bound.get("ok") is not True:
            return {"ok": False, "wait": bound.get("wait") or "source_route_changed"}
        return {"ok": True, "source": bound, "identity": proven["identity"].summary()}

    # ── the loop thread ───────────────────────────────────────────────────────────────────────
    def _ensure_loop(self):
        with self._lock:
            if self._loop is not None and not self._loop.is_closed():
                return self._loop
            loop = (self._loop_factory or asyncio.new_event_loop)()
            ready = threading.Event()

            def run():
                asyncio.set_event_loop(loop)
                ready.set()
                loop.run_forever()

            thread = threading.Thread(target=run, name="mse-reflection-loop", daemon=True)
            thread.start()
            ready.wait(LOOP_JOIN_SECONDS)
            self._loop, self._thread = loop, thread
            return loop

    def _with_profile(self, fn):
        """Run `fn` with THIS driver's profile binding in force. Never resolves the profile late."""
        home = self.profile_home
        if home is None:
            return fn()
        try:
            from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        except Exception:  # noqa: BLE001 — no host constants, no claim of a profile binding
            return fn()
        token = set_hermes_home_override(home)
        try:
            return fn()
        finally:
            reset_hermes_home_override(token)

    def _active_jobs(self):
        return [job for job in self.jobs.values() if not job.get("_done", False)]

    def run(self, job, outcome, summaries, cancel_event, call):
        """The synchronous entry point the bridge calls from its own background thread.

        It returns a bounded result: `{"ran": bool, "wait": code|None, "usage": ..., "result": ...}`.
        A wait means NOTHING was signed and nothing was consumed; `ran` with a wait means the ticket
        was signed and is being finished (or has already been finished) conservatively.

        The job's own `kind` selects WHICH paid track this attempt is — the released reflection, or one
        of the two automatic tracks. It is the same slot, the same loop, the same owner-side cleanup
        and the same cancellation, because "one physical provider at a time" is a property of the
        PROCESS, not of one track.
        """
        key = id(job)
        if self._shutting_down:
            # An unloaded driver starts nothing: a new attempt would need the loop this shutdown is
            # about to finish, and signing a ticket for it would spend a revision for nothing.
            return {"ran": False, "wait": "driver_shutting_down"}
        if not self.slot.acquire(key):
            return {"ran": False, "wait": "slot_busy"}
        self.jobs[key] = job
        job["_driver_key"] = key
        loop = self._ensure_loop()
        context = None
        try:
            import contextvars
            context = contextvars.copy_context()
        except Exception:  # noqa: BLE001
            context = None
        box = {}
        paid = job.get("kind") in ("review", "objective", "decision")

        def start():
            if paid:
                self._with_profile(lambda: _schedule_paid(self, job, cancel_event, call, key, box))
            else:
                self._with_profile(lambda: _schedule(self, loop, job, outcome, summaries,
                                                     cancel_event, call, key, box))

        try:
            if context is not None:
                loop.call_soon_threadsafe(context.run, start)
            else:
                loop.call_soon_threadsafe(start)
        except Exception:  # noqa: BLE001
            self.slot.release(key)
            return self._retire(key, {"ran": False, "wait": "provider_driver_unsupported"})
        # Wait for the scheduled coroutine to actually be created.
        deadline = time.monotonic() + max(1.0, self.job_timeout)
        while "task" not in box and "error" not in box and time.monotonic() < deadline:
            time.sleep(0.001)
        task = box.get("task")
        if task is None:
            self.slot.release(key)
            return self._retire(key, {"ran": False,
                                      "wait": box.get("error") or "provider_driver_unsupported"})
        return self._await(task, key, cancel_event)

    async def _cleanup(self, job, job_task):
        """Close the client ONE job built — and only AFTER that job has really finished with it.

        Two properties, and the order between them is the whole point:

          1. It waits for the job to finish. Closing a client while a request is still on the wire
             would abort a live attempt, so the cleanup starts by awaiting the job Task itself.
          2. The wait is `shield`ed, so the job's OWN cancellation does not propagate into this task:
             the job may be cancelled, and the cleanup still runs to completion. That is the only way
             "the cleanup really ended" can be claimed rather than inferred.

        It is a SEPARATE task from the job, and the slot is released by the owner only after this task
        has genuinely returned — so a close that blocks keeps the attempt `draining` for as long as it
        blocks.

        It never raises: a close that fails is reported in the slot's own bookkeeping, not thrown at a
        caller that is waiting for a bounded answer.
        """
        try:
            await asyncio.shield(job_task)
        except asyncio.CancelledError:
            # The JOB was cancelled. That is exactly the case this task exists for: the cancellation
            # ends the job's work, not the cleanup's, so it carries on below.
            pass
        except Exception:  # noqa: BLE001 — a failed job is still a job whose client must be closed
            pass
        client = (job.get("_state") or {}).get("resource")
        if client is None:
            return True
        job["_state"]["resource"] = None
        try:
            return await _close(client)
        except asyncio.CancelledError:
            # Defensive: this task is not cancelled by the job, but a loop shutdown could be. The slot
            # then stays draining rather than claiming a close that did not happen.
            return False
        except Exception:  # noqa: BLE001
            return False

    def _drain_cleanup(self, cleanup, key):
        """Block until the cleanup task really finished; the slot stays draining throughout."""
        if cleanup is None or cleanup.done():
            if self.slot.draining:
                self.slot.settle(key)
            return
        self.slot.draining = True
        self.slot.tasks[key] = cleanup
        while not cleanup.done():
            time.sleep(0.002)
        if self.slot.draining:
            self.slot.settle(key)

    def _await(self, task, key, cancel_event):
        """Wait for the job, honouring the host's cancel flag WITHOUT pretending it is over.

        The slot is released on exactly one condition: `task.done()` — the coroutine has returned,
        which means its `finally` blocks (the client close included) have finished too. A task that
        ignores the cancellation therefore keeps the slot in `draining` for as long as it really
        runs, and no second provider request can enter behind it.
        """
        loop = self._loop
        while not task.done():
            if cancel_event is not None and cancel_event.is_set() and not self.slot.draining:
                self.cancelled += 1
                self.slot.drain(key, task)
                if loop is not None and not loop.is_closed():
                    try:
                        loop.call_soon_threadsafe(task.cancel)
                    except Exception:  # noqa: BLE001
                        pass
            time.sleep(0.002)
        try:
            outcome = task.result()
        except asyncio.CancelledError:
            outcome = {"ran": True, "wait": "cancelled", "completed": False}
        except Exception as error:  # noqa: BLE001 — a driver failure is a wait, never a success
            outcome = {"ran": True, "wait": getattr(error, "code", None) or "provider_driver_unsupported",
                       "completed": False}
        # ── THE OWNER-SIDE CLEANUP ──────────────────────────────────────────────────────────────
        # The job Task being done is NOT the same thing as the transport being closed: the close was
        # deliberately handed to a separate, uncancellable task. The slot is released only after THAT
        # task has really finished, so a close that blocks keeps the attempt draining for as long as
        # it blocks, and a cancellation cannot free the slot early or lose the cleanup.
        cleanup = getattr(task, "_mse_cleanup", None)
        if cleanup is not None:
            self._drain_cleanup(cleanup, key)
        elif self.slot.draining:
            self.slot.settle(key)
        self.slot.release(key)
        self.last = outcome
        wait = outcome.get("wait")
        if isinstance(wait, str):
            self.waits[wait] = self.waits.get(wait, 0) + 1
        return self._retire(key, outcome)

    def _retire(self, key, outcome):
        """End one job's registration and hand its outcome back.

        The registry reference is dropped HERE and nowhere else: after the job Task is done, after the
        owner-side cleanup has really finished (the slot may not be released before that), and after
        the slot itself is free. Everything that still needs the entry — a cancellation, an unload
        reaching the work in flight, a draining slot — has already had its chance by then, so this
        removes no cancellable ownership and fakes no empty slot.

        What survives is bounded and non-sensitive: one count per terminal bucket, never the prompt,
        the route, the session or the request body the entry carried.
        """
        job = self.jobs.pop(key, None)
        if isinstance(job, dict):
            state = job.get("_state")
            terminal = state.get("terminal") if isinstance(state, dict) else None
            if terminal == "committed":
                bucket = "committed"
            elif terminal == "cancelled":
                bucket = "cancelled"
            elif isinstance(terminal, str) and terminal:
                bucket = "closed"
            elif isinstance(outcome, dict) and isinstance(outcome.get("wait"), str):
                bucket = "refused"
            else:
                bucket = "other"
        else:
            bucket = "refused" if isinstance(outcome, dict) and isinstance(outcome.get("wait"), str) \
                else "other"
        self.retired["jobs"] = self.retired.get("jobs", 0) + 1
        self.retired[bucket] = self.retired.get(bucket, 0) + 1
        return outcome

    def cancel_in_flight(self):
        """Withdraw the work in flight WITHOUT refusing the work that becomes eligible later.

        This is the ORDINARY half of the withdrawal: a pause, a foreground preemption or a session
        boundary ends the attempt that is running and invalidates its stale result, but it does not
        condemn the driver. The lifecycle that recovers is the same lifecycle that must be able to
        sign a new, qualified attempt — a driver refused for good by every ordinary cancel is a
        driver that can never recover, and that is exactly the defect this split removes.

        The permanent refusal belongs to `begin_shutdown`, which only a real unload calls.
        """
        return self._withdraw(permanent=False)

    def begin_shutdown(self):
        """Refuse NEW work and withdraw the work already in flight. Local intent FIRST.

        This is the unload path's first half, and the order is the same contract every other control
        change follows: the local decision is visible before anything waits on a lock or a subprocess,
        so an attempt that is between its last await and its submission cannot slip through while the
        shutdown is being published. The durable half (closing the signed tickets in the core) is done
        by the bridge, which owns the core transport.
        """
        return self._withdraw(permanent=True)

    def _withdraw(self, permanent):
        """The one withdrawal implementation, with the PERMANENT half made explicit."""
        if permanent:
            with self._lock:
                self._shutting_down = True
        invalidated = 0
        for job in list(self._active_jobs()):
            job["invalidated"] = True
            event = job.get("cancel")
            if event is not None:
                event.set()
            invalidated += 1
        return invalidated

    def cleanup_pending(self):
        """Whether the owner-side cleanup still has real work: an open transport being closed."""
        return self.slot.draining or bool(self.slot.tasks) or self.slot.busy

    def drain(self, timeout=30.0):
        """Wait for the tracked cleanup to finish. Returns whether the driver really settled.

        It waits on the CLEANUP tasks, not on a timeout that abandons them: while a job's client is
        still being closed, the slot keeps `draining` and this keeps waiting. A caller that must not
        block for ever uses the bound and then reports an UNCONFIRMED shutdown — it never claims a
        drain that did not happen, and it never leaves the loop's own work unowned.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        while self.cleanup_pending() and time.monotonic() < deadline:
            for task in list(self.slot.tasks.values()):
                if task is not None and not task.done():
                    time.sleep(0.002)
                    break
            else:
                time.sleep(0.002)
        return not self.cleanup_pending()

    def close(self, timeout=30.0, force=False):
        """Stop the loop thread — but only once its tracked cleanup really finished.

        Closing the loop is closing the ONLY place the cleanup tasks can run: doing it while a
        transport is still open would abandon a close (and everything that depends on it) instead of
        finishing it. So the loop is drained first, and a drain that did not complete leaves the loop
        ALIVE and returns `False`. `force` is for a process that is already exiting and would lose the
        loop anyway; it still records the same unconfirmed state rather than pretending.
        """
        settled = self.drain(timeout)
        with self._lock:
            loop, thread = self._loop, self._thread
            if settled or force or self.slot.active == 0:
                self._loop, self._thread = None, None
            else:
                loop = thread = None
        if loop is None:
            return settled
        if not loop.is_closed():
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception:  # noqa: BLE001
                pass
            if thread is not None:
                thread.join(LOOP_JOIN_SECONDS)
            if not loop.is_closed():
                try:
                    loop.close()
                except Exception:  # noqa: BLE001
                    pass
        return settled

    def status(self):
        return {"slot": self.slot.status(), "dispatches": self.dispatches, "cancelled": self.cancelled,
                "waits": dict(self.waits), "last": self.last, "registered": len(self.jobs),
                "finished": dict(self.retired)}


def _schedule(driver, loop, job, outcome, summaries, cancel_event, call, key, box):
    """Create the job task on the loop thread, inside the profile binding entered by the caller.

    The owner-side CLEANUP task is created FIRST and attached to the job task, so it exists before
    anything can cancel the job: `task.cancel()` targets the job, never the cleanup, and the driver
    cannot end up with a close it does not know about.
    """
    try:
        job["_state"] = {}
        task = loop.create_task(_job(driver, job, outcome, summaries, cancel_event, call, key))
        # The cleanup is created SECOND and is GATED ON THE JOB (`_cleanup` awaits it, shielded), so it
        # cannot touch the client while the request is still in flight. It exists only so that the
        # close is uncancellable and trackable — not so that it can start early.
        task._mse_cleanup = loop.create_task(driver._cleanup(job, task))
        box["task"] = task
    except Exception as error:  # noqa: BLE001
        box["error"] = getattr(error, "code", None) or "provider_driver_unsupported"


def _schedule_paid(driver, job, cancel_event, call, key, box):
    """Create a PAID track's job task on the loop thread, with the SAME owner-side cleanup.

    It is the same two-task shape as `_schedule` — the job owns the client, the cleanup is a SEPARATE
    task gated on the job (`_cleanup` awaits it, shielded) so a cancellation can never lose the close —
    and it exists as its own function only because a paid run has a different coroutine to drive.
    Nothing about the slot, the registry or the release order changes.
    """
    try:
        job["_state"] = {}
        loop = driver._loop
        task = loop.create_task(_multi_job(driver, job, cancel_event, call, key))
        task._mse_cleanup = loop.create_task(driver._cleanup(job, task))
        box["task"] = task
    except Exception as error:  # noqa: BLE001
        box["error"] = getattr(error, "code", None) or "provider_driver_unsupported"


def _same_endpoint(left, right):
    """Whether two endpoint strings are the SAME endpoint after the SDK's own normalization.

    Only the trailing slash differs in practice (`https://x/v1` vs `https://x/v1/`); everything else
    must match byte for byte, because "close enough" is how two different execution endpoints get
    conflated.
    """
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    return left.rstrip("/") == right.rstrip("/") and left.rstrip("/") != ""


async def _job(driver, job, outcome, summaries, cancel_event, call, key):
    """One whole reflection attempt, inside the slot, from proven identity to committed result.

    Every exit — a refusal, a provider failure, a cancellation, a rejected commit — travels through
    ONE bookkeeping block, so a signed ticket is always closed on the core and its cost (measured, or
    explicitly unknown) is always recorded. A cancelled attempt is not a free one and not a
    retryable one.
    """
    # `job["_state"]` IS the shared cell: it is created before the cleanup task exists, it carries the
    # client the cleanup must close, and it carries the usage the dispatcher read — so a cancellation
    # can never separate the two halves of one attempt.
    state = job.setdefault("_state", {})
    state.update({"ticket": None, "usage": None, "terminal": None, "cancelled": False,
                  "dispatch_started": False, "resource": None, "wire_usage": None})
    task_summary, result_summary = summaries

    def note_ticket(value):
        if value is not None:
            state["ticket"] = value
            job["ticket"] = value

    def cancelled():
        return cancel_event is not None and cancel_event.is_set()

    def bail(payload, terminal):
        """Record why this attempt is over and hand the payload back for the final close."""
        state["terminal"] = terminal
        payload["ticket"] = state["ticket"]
        payload["terminal"] = terminal
        return payload

    try:
        problem = job.get("problem") or {}
        proven, reason = driver.prove(job.get("route_provider"), job.get("route_model"),
                                      job.get("pre_api") or {})
        if proven is None:
            return {"ran": False, "wait": reason}
        identity, runtime = proven["identity"], proven["runtime"]
        if cancelled():
            return {"ran": False, "wait": "cancelled"}
        bound = job.get("prepared_source")
        if not isinstance(bound, dict) or bound.get("ok") is not True:
            bound = _bind_source(call, identity, job, problem)
        if bound.get("ok") is not True:
            return {"ran": False, "wait": bound.get("wait") or "source_route_changed"}
        if cancelled():
            return {"ran": False, "wait": "cancelled"}
        control = call("controlGeneration", {})
        if not isinstance(control, int):
            return {"ran": False, "wait": "control_unavailable"}
        request = _reflection_request(job, problem, summaries, bound, control)
        prepared = call("reflectionRequest", request)
        if not isinstance(prepared, dict) or prepared.get("ok") is not True or not prepared.get("ticket"):
            code = prepared.get("skipped") if isinstance(prepared, dict) else None
            return {"ran": False, "wait": code if isinstance(code, str) else "reflection_refused"}
        note_ticket(prepared["ticket"])
        frozen = prepared.get("source")
        if not isinstance(frozen, dict):
            return bail({"ran": True, "wait": "source_binding_mismatch"}, "source_binding_mismatch")
        prompt = prepared.get("request") or {}
        # ── the last local checks, after the last await, immediately before the dispatch ────────
        if cancelled():
            return bail({"ran": True, "wait": "cancelled", "completed": False}, "cancelled")
        client, reason = driver._bind_client(identity, runtime)
        if client is None:
            return bail({"ran": True, "wait": reason}, reason)
        # ── THE LAST LOCAL CHECK, after the client exists and immediately before `create` ────────
        # The check above ran before the client was even constructed. A permission withdrawn in the
        # meantime must not reach the SDK at all: this re-reads the same local facts synchronously —
        # no polling race, no other thread's timing — and closes the client it just built instead of
        # dispatching. Nothing is sent, so nothing can be charged or leaked.
        if cancelled() or job.get("invalidated") is True:
            # Nothing was sent, but a client was still built: it is this job's to close, and the
            # owner-side cleanup below tracks that close to completion before the slot is freed.
            state["resource"] = client
            return bail({"ran": True, "wait": "cancelled", "completed": False}, "cancelled")
        # THIS job owns this client from here on. The close is NOT awaited here: it is handed to the
        # owner-side cleanup (`_cleanup`), which runs OUTSIDE this Task's cancellation scope. A
        # cancellation can therefore never interrupt, lose or orphan the close — and the slot is held
        # in `draining` until that cleanup is really finished.
        state["resource"] = client
        try:
            generation = job.get("generation")
            if isinstance(generation, dict):
                permit = call("reflectionDispatch", {"ticket": state["ticket"],
                    "dispatchHash": prepared.get("dispatchHash")})
                if not isinstance(permit, dict) or permit.get("ok") is not True:
                    return bail({"ran": True, "wait": (permit or {}).get("code", "reflection_budget"),
                                 "completed": False}, "reflection_dispatch_refused")
            state["dispatch_started"] = True
            usage, content, failure, _finish = await _dispatch(driver, client, identity, prompt, state)
        except asyncio.CancelledError:
            # The cancellation can land while the request is on the wire. `_dispatch` may still have
            # read a usage off a response that arrived first, so it is taken from the shared cell
            # BEFORE anything else happens — a measurement that was really read is never lost to the
            # cancellation path, and an unread one stays unknown.
            state["usage"] = state.get("wire_usage")
            state["cancelled"] = True
            return bail({"ran": True, "wait": "cancelled", "completed": False,
                         "usage": state["usage"]}, "cancelled")
        state["usage"] = usage
        if failure is not None:
            return bail({"ran": True, "wait": failure, "usage": usage}, failure)
        value = _parse_result(content["text"] if isinstance(content, dict) else None)
        if value is None:
            return bail({"ran": True, "wait": "reflection_refused", "usage": usage}, "reflection_refused")
        # ── THE LAST LOCAL CHECK: the host's cancel and this job's own generation ────────────────
        # A transport that ignored the first cancellation can still answer. Committing that answer
        # would let a withdrawn attempt create a candidate, so the lifecycle's own invalidation is
        # re-read HERE — after the final await and immediately before the submission — and a
        # cancelled attempt is CLOSED rather than committed. The ticket stays consumed: it is not
        # refunded and it is never re-sent.
        if cancelled() or job.get("invalidated") is True:
            return bail({"ran": True, "wait": "cancelled", "completed": False, "usage": usage}, "cancelled")
        result = call("reflectionResult", {"ticket": state["ticket"], "result": value,
                                           "expected": _expected(frozen), "usage": _wire_usage(usage)})
        code = None
        if not isinstance(result, dict) or result.get("ok") is not True:
            # The core refused the commit (a pause, an exact stop, a source change, an expiry). That
            # is terminal for THIS ticket: the attempt stays consumed and is never re-sent. A
            # `reflection_already_settled` answer means a PREVIOUS submission of this same ticket
            # really landed (its response was lost) — never a reason to submit a second time.
            code = result.get("code") if isinstance(result, dict) else None
        state["terminal"] = code or "committed"
        job["ticket"] = None
        return {"ran": True, "wait": code, "usage": usage, "result": result}
    except asyncio.CancelledError:
        # A cancellation is not proof that the provider never received the request. The ticket stays
        # consumed and the usage is whatever the wire really reported, or unknown.
        state["cancelled"] = True
        return bail({"ran": True, "wait": "cancelled", "completed": False,
                     "usage": state["usage"]}, "cancelled")
    finally:
        # ── ONE reliable close for the ticket, on EVERY path ─────────────────────────────────────
        # This is the only place a driver-signed ticket is finished, so a cancellation raised while
        # the response was in flight can no longer leave an unsettled event behind: the core is told
        # the attempt is over FOR THIS TICKET (never re-signed, never replayed), the cost it already
        # incurred is recorded when the wire reported one, and an unmeasurable one is recorded as
        # UNKNOWN rather than as zero.
        if state["ticket"] is not None:
            try:
                value = {"ticket": state["ticket"]}
                if state["usage"] is not None:
                    value["usage"] = _wire_usage(state["usage"])
                call("reflectionCancel", value)
            except Exception:  # noqa: BLE001 — the transport failing must not lose the local close
                pass
            job["ticket"] = None


def _wire_usage(usage):
    """The bounded usage document the core accepts, or `{"known": False}` for an unreadable one."""
    if isinstance(usage, dict) and usage.get("known") is True:
        return {"known": True, "promptTokens": usage["promptTokens"],
                "completionTokens": usage["completionTokens"], "totalTokens": usage["totalTokens"]}
    return {"known": False}


async def _close(client):
    """Close a job-owned client. A failure to close is reported, never allowed to lose the result."""
    close = getattr(client, "close", None)
    if close is None:
        return False
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
        return True
    except Exception:  # noqa: BLE001
        return False


async def _dispatch(driver, client, identity, prompt, state=None, limits=None, truncation=False, step=None):
    """The ONE physical provider call, raw usage first and typed parse second.

    `limits` is the CORE's own per-step allowance for this track, taken from the execution material
    the core just handed out (`limits.armChars` / `limits.verdictBytes`). The reflection path keeps
    its released 2 KiB content bound and treats an over-long answer as a refusal; the two paid tracks
    set `truncation=True`, where an answer that really exceeds its bound is reported as `truncated`
    (with the size measured) instead of being silently cut into a shorter complete-looking one.
    """
    bounds = limits or {}
    text_units = bounds.get("textUnits")
    text_bytes = bounds.get("textBytes", 2048) if truncation else 2048
    messages = [{"role": "system", "content": prompt.get("system", "")},
                {"role": "user", "content": prompt.get("text", "")}]
    kwargs = {"model": identity.model, "messages": messages,
              "max_tokens": prompt.get("maxTokens", 384)}
    if identity.reasoning_state == REASONING_EXPLICIT:
        kwargs["reasoning_effort"] = identity.reasoning_value
    raw = None
    if isinstance(step, dict):
        # ONE rule for the whole step: "in flight" is set immediately before `create` and cleared at
        # the exact moment a usable measurement has been read. Whatever ends this step — a result, a
        # cancellation, or a provider failure — the run's accounting is derived from these two facts
        # alone, so no ending can silently claim a measured zero for a request that was dispatched.
        step["resultInFlight"] = False
    try:
        driver.dispatches += 1
        if isinstance(step, dict):
            step["resultInFlight"] = True
        raw = await client.chat.completions.with_raw_response.create(**kwargs)
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 — provider failure is a wait with UNKNOWN cost
        return None, None, _provider_failure(error), None
    try:
        usage = parse_usage(raw.http_response.json())
    except Exception:  # noqa: BLE001
        usage = None
    # Published into the shared cell BEFORE the next await (the typed parse): a measurement that was
    # really read off the wire must never be lost because a cancellation arrived afterwards.
    if isinstance(state, dict):
        state["wire_usage"] = usage
    if isinstance(step, dict):
        # The response really arrived and was read: this step's cost is no longer unreadable, so it is
        # no longer "in flight" for the accounting.
        step["resultInFlight"] = False
    try:
        completion = raw.parse()
    except Exception:  # noqa: BLE001
        return usage, None, "reflection_refused", None
    choices = getattr(completion, "choices", None) or []
    if len(choices) != 1:
        return usage, None, "reflection_refused", None
    choice = choices[0]
    # The REAL finish reason: the provider's own statement about why it stopped. `length` means the
    # answer was cut off by the token budget, which is a fact the core must be told instead of being
    # handed a complete-looking short answer.
    finish = getattr(choice, "finish_reason", None)
    finish = finish if isinstance(finish, str) else None
    message = getattr(choice, "message", None)
    if message is None or getattr(message, "tool_calls", None):
        return usage, None, "reflection_refused", finish
    content = getattr(message, "content", None)
    if not isinstance(content, str):
        return usage, None, "reflection_refused", finish
    encoded = len(content.encode("utf-8"))
    units = utf16_units(content)
    over = finish == "length" or encoded > text_bytes or (text_units is not None and units > text_units)
    if over:
        if not truncation:
            return usage, None, "reflection_refused", finish
        # NOT a failure: the step really happened and really cost what the wire said, and the core is
        # told exactly what is wrong with the content so it can refuse to call it complete.
        return usage, {"text": content, "units": units, "bytes": encoded, "truncated": True}, None, finish
    return usage, {"text": content, "units": units, "bytes": encoded, "truncated": False}, None, finish


def _provider_failure(error):
    """Map a provider failure onto a bounded code. The cost stays UNKNOWN, never zero."""
    name = type(error).__name__
    if name in ("APIConnectionError", "APITimeoutError", "ConnectError", "ReadTimeout"):
        return "provider_unavailable"
    if name in ("RateLimitError", "InternalServerError", "APIStatusError", "AuthenticationError",
                "PermissionDeniedError", "BadRequestError"):
        return "provider_unavailable"
    return "provider_unavailable"


def _parse_result(content):
    if not isinstance(content, str) or content == "":
        return None
    try:
        value = json.loads(content)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(value, dict) or "instruction" not in value:
        return None
    if not all(key in ("instruction", "methodId") for key in value):
        return None
    instruction = value.get("instruction")
    if instruction is not None and not isinstance(instruction, str):
        return None
    if "methodId" in value and value["methodId"] is not None and not isinstance(value["methodId"], str):
        return None
    return value


def _multi_arm(result, state):
    """One arm's own answer, measured. The result is never a verdict this side may judge.

    The measurement is published into the shared cell BEFORE the arm's text is handed on, so a
    cancellation that lands right after a response arrived still carries the tokens the wire reported.
    """
    return {"text": result["text"], "units": result["units"], "bytes": result["bytes"],
            "truncated": result["truncated"], "tokens": state["last_tokens"] if state else None}


def _multi_failure(result, state):
    """`(wait_code_or_None, exception_or_None)` for one raw `_dispatch` answer.

    The failure vocabulary is the module's own bounded WAITS; a provider error is deliberately split
    from a content refusal so the ledger can tell "we could not reach it" from "it did not answer".
    """
    usage, content, failure, finish = result
    if failure is not None:
        return failure, None
    if content is None:
        return "reflection_refused", None
    if state is not None:
        # Read into the SHARED cell before anything else: the caller's cancellation path takes the
        # measurement from there.
        state["wire_usage"] = state.get("wire_usage")
    return None, (usage, content, finish)


async def _multi_step(driver, client, identity, prompt, state, budget, limits, call):
    """ONE paid physical step of a review/objective run, bounded by the CORE's own allowance.

    It is the same `_dispatch` the reflection path uses — one `chat.completions.with_raw_response.create`,
    `max_retries=0`, no tools, no fallback — with two differences the two paid tracks really need: the
    content bound comes from the execution material the core just handed out, and an answer the
    provider itself says was cut off is reported as `truncated` rather than refused locally.

    WHAT THIS FUNCTION OWES THE LEDGER, and why the two flags exist: a step that was CANCELLED while
    its request was on the wire may really have been paid for, so its measurement is UNKNOWN — never a
    zero, and never "the same as the last known frame". A step that never entered the physical call
    did not happen and must not contribute an unknown either. The flags are what carry that
    distinction out of the cancellation path, which otherwise unwinds straight past this step's own
    bookkeeping (the confirmed defect this closes).
    """
    spend = state.setdefault("spend", {"known": 0, "unknown": 0})
    spend["resultInFlight"] = False
    budget["steps"] += 1
    limit = {"textUnits": int(limits.get("armChars", 4000)),
             "textBytes": int(limits.get("verdictBytes", 8192))}
    try:
        ticket = state.get("ticket")
        step_key = prompt.get("stepKey")
        if not isinstance(ticket, str) or not isinstance(step_key, str):
            return {"ok": False, "wait": "usage_unprovable"}
        messages = [{"role": "system", "content": prompt.get("system", "")},
                    {"role": "user", "content": prompt.get("text", "")}]
        output_cap = 256 if step_key.startswith("review:judge:") else 128
        # The route is part of the identity too. A resume may only reuse the saved response when
        # endpoint/provider/API mode and all effective body fields are unchanged.
        request_shape = {"provider": identity.provider, "base_url": identity.base_url,
                         "api_mode": identity.api_mode, "model": identity.model,
                         "messages": messages, "max_tokens": output_cap}
        if identity.reasoning_state == REASONING_EXPLICIT:
            request_shape["reasoning_effort"] = identity.reasoning_value
        encoded = json.dumps(request_shape, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request_hash = hashlib.sha256(encoded).hexdigest()
        checkpoint = call("planProgress", {"ticket": ticket, "stepKey": step_key})
        if isinstance(checkpoint, dict) and checkpoint.get("ok") is True and checkpoint.get("step") is not None:
            saved = checkpoint["step"]
            if saved.get("requestHash") != request_hash:
                return {"ok": False, "wait": "checkpoint_conflict"}
            tokens = saved.get("tokens")
            if not isinstance(tokens, int):
                return {"ok": False, "wait": "ticket_usage_unknown"}
            spend["known"] += tokens
            state["last_tokens"] = tokens
            return {"ok": True, "usage": {"known": True, "totalTokens": tokens},
                    "content": {"text": saved["text"], "units": utf16_units(saved["text"]),
                                "bytes": len(saved["text"].encode("utf-8")),
                                "truncated": saved["truncated"]}, "finish": None,
                    "resumed": True}
        reserve = call("ticketReserve", {"ticket": ticket, "stepKey": step_key,
            "requestHash": request_hash, "inputTokens": len(encoded) + 128,
            "outputTokens": output_cap})
        if not isinstance(reserve, dict) or reserve.get("ok") is not True:
            return {"ok": False, "wait": (reserve or {}).get("code", "evaluation_budget")}
        # The reservation transaction is an await boundary. Re-read the ticket-bound material after
        # it and before entering the provider call; stale permission can therefore buy no request.
        refresh = prompt.get("refresh")
        if callable(refresh):
            fresh = refresh()
            if not isinstance(fresh, dict) or fresh.get("ok") is not True:
                return {"ok": False, "wait": (fresh or {}).get("code", "ticket_consumed")}
        started = call("ticketStepStart", {"ticket": ticket, "stepKey": step_key,
                                            "requestHash": request_hash})
        if not isinstance(started, dict) or started.get("ok") is not True:
            return {"ok": False, "wait": (started or {}).get("code", "ticket_step_start_failed")}
        prompt["maxTokens"] = output_cap
        result = await _dispatch(driver, client, identity, prompt, state, limits=limit, truncation=True,
                                 step=spend)
    except asyncio.CancelledError:
        _note_unmeasured(spend, state)
        raise
    except Exception:  # noqa: BLE001 — a transport failure is a bounded wait with unknown cost
        _note_unmeasured(spend, state)
        return {"ok": False, "wait": "provider_unavailable"}
    wait, note = _multi_failure(result, state)
    if wait is not None:
        # A provider failure ends the step WITHOUT a measurement. If the call had really been entered,
        # the run's cost for it is unknown — the same rule the cancellation path follows, so the two
        # endings cannot disagree about what was paid for.
        _note_unmeasured(spend, state)
        return {"ok": False, "wait": wait}
    usage, content, finish = note
    completed = call("ticketStepComplete", {"ticket": ticket, "stepKey": step_key,
        "requestHash": request_hash, "text": content["text"], "truncated": content["truncated"],
        "tokens": _usage_tokens(usage)})
    if not isinstance(completed, dict) or completed.get("ok") is not True:
        return {"ok": False, "wait": (completed or {}).get("code", "ticket_checkpoint_failed")}
    spend["resultInFlight"] = False
    state["last_tokens"] = _usage_tokens(usage)
    state["last_usage_known"] = bool(isinstance(usage, dict) and usage.get("known") is True)
    state["last_finish"] = finish
    return {"ok": True, "usage": usage, "content": content, "finish": finish}


def _note_unmeasured(spend, state):
    """ONE step that entered the physical call and yielded no measurement, folded in exactly once.

    It is the single place this fact becomes accounting, so a cancellation, a provider failure and a
    transport error cannot each invent their own version of it. A step that never entered the call
    contributes NOTHING: "the request never went out" and "we could not measure it" are different
    facts, and only the second one latches the run as unmeasured.
    """
    if isinstance(spend, dict) and spend.get("resultInFlight") is True:
        spend["unknown"] += 1
        spend["resultInFlight"] = False
        state["usage"] = {"known": False, "tokens": spend.get("known", 0)}
    return spend


def _usage_tokens(usage):
    """The measured total of ONE step, or `None` when the wire did not report a usable one."""
    if isinstance(usage, dict) and usage.get("known") is True:
        return usage.get("totalTokens")
    return None


def _ticket_usage(call, ticket, known, unknown):
    """Persist the run's measurement SO FAR through the core's own non-terminal merger.

    It is called after EVERY step, BEFORE the next physical call is awaited, so a crash between two
    steps cannot lose tokens the provider already reported. The quality is the MERGED one: a single
    unreadable step latches `known: false` for the whole run, which is what stops a later frame that
    happens to look measured from promoting work nobody could measure. It grants no credit, signs
    nothing and closes nothing.
    """
    if ticket is None:
        return None
    usage = {"known": unknown == 0, "tokens": known}
    try:
        answer = call("ticketUsage", {"ticket": ticket, "spent": known, "usage": usage})
    except Exception:  # noqa: BLE001 — a bookkeeping failure must not lose the run's own facts
        return None
    return answer if isinstance(answer, dict) else None



async def _decision_job(driver, job, cancel_event, call):
    """One source-bound opinion on the same physical slot and decision ledger as validation."""
    ticket = job.get("ticket")
    state = job.setdefault("_state", {})
    state.update({"ticket": ticket, "wire_usage": None, "resource": None})
    if not isinstance(ticket, str) or not ticket:
        return {"ran": False, "wait": "decision_no_ticket", "kind": "decision"}
    if job.get("backend", "host") != "host" and job.get("resumeFallback") is not True:
        process = None
        communication = None
        try:
            process = await asyncio.create_subprocess_exec(job["nodePath"], job["cliPath"],
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            body = {"config": job["coreConfig"], "op": "decisionDispatch", "input": job["dispatchInput"]}
            timeout_ms = job.get("dispatchInput", {}).get("timeoutMs", 30_000)
            process_timeout = decision_dispatch_deadline(timeout_ms)
            communication = asyncio.create_task(process.communicate(
                json.dumps(body, ensure_ascii=False).encode("utf-8")))
            deadline = asyncio.get_running_loop().time() + process_timeout
            while True:
                if _multi_cancelled(cancel_event, job):
                    raise asyncio.CancelledError()
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                try:
                    output, _ = await asyncio.wait_for(asyncio.shield(communication),
                                                       timeout=min(0.1, remaining))
                    break
                except asyncio.TimeoutError:
                    if communication.done():
                        output, _ = communication.result()
                        break
            if len(output) > 8192:
                raise RuntimeError("invalid_runtime_response")
            remote = json.loads(output.decode("utf-8"))
        except asyncio.CancelledError:
            if process is not None and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=1.0)
                except Exception:  # noqa: BLE001
                    process.kill()
                    await process.wait()
            if communication is not None:
                await asyncio.gather(communication, return_exceptions=True)
            released = call("decisionAbortBeforeDispatch", {"ticket": ticket})
            if not isinstance(released, dict) or released.get("ok") is not True:
                call("decisionFail", {"ticket": ticket, "code": "cancelled", "usage": None})
            job["ticket"] = None
            return {"ran": True, "wait": "cancelled", "kind": "decision", "completed": False}
        except Exception:  # noqa: BLE001 — the durable ticket is the source of truth
            if process is not None and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=1.0)
                except Exception:  # noqa: BLE001
                    process.kill()
                    await process.wait()
            if communication is not None:
                await asyncio.gather(communication, return_exceptions=True)
            released = call("decisionAbortBeforeDispatch", {"ticket": ticket})
            if not isinstance(released, dict) or released.get("ok") is not True:
                call("decisionFail", {"ticket": ticket, "code": "provider_unavailable", "usage": None})
            job["ticket"] = None
            remote = {"ok": False, "code": "provider_unavailable"}
        if isinstance(remote, dict) and remote.get("needsHostFallback") is True:
            return await _decision_host_step(driver, job, cancel_event, call, fallback=True)
        if isinstance(remote, dict) and isinstance(remote.get("record"), dict):
            job["ticket"] = None
            record = remote["record"]
            result = record.get("finalResult") or record.get("result") or {}
            action = result.get("action") if isinstance(result, dict) else None
            return {"ran": True, "wait": remote.get("code"), "kind": "decision",
                    "completed": record.get("state") in ("complete", "wait", "unknown"),
                    "result": {"action": action} if isinstance(action, str) else None, "record": record}
        return {"ran": False, "wait": remote.get("code", "provider_unavailable")
                if isinstance(remote, dict) else "provider_unavailable", "kind": "decision"}
    return await _decision_host_step(driver, job, cancel_event, call,
                                    fallback=job.get("resumeFallback") is True)


async def _decision_host_step(driver, job, cancel_event, call, fallback=False):
    """Run one Host route step; fallback reserves exactly one step on the same logical ticket."""
    ticket, state = job["ticket"], job["_state"]
    proven, reason = driver.prove(job.get("route_provider"), job.get("route_model"), job.get("pre_api") or {})
    if proven is None:
        return {"ran": False, "wait": reason or "source_unknown", "kind": "decision"}
    identity, runtime = proven["identity"], proven["runtime"]
    client, reason = driver._bind_client(identity, runtime)
    if client is None:
        return {"ran": False, "wait": reason or "provider_driver_unsupported", "kind": "decision"}
    state["resource"] = client
    step_key = "decision:host" if fallback else "decision"
    if fallback:
        route = job["hostFallbackRoute"]
        request_hash = hashlib.sha256(json.dumps([job["decisionKey"], step_key, route], sort_keys=True,
            separators=(",", ":")).encode("utf-8")).hexdigest()
        reserved = call("decisionReserveFallback", {"ticket": ticket, "inputTokens": job["inputTokens"],
            "outputTokens": job["outputTokens"], "requestHash": request_hash, **route})
        if not isinstance(reserved, dict) or reserved.get("ok") is not True:
            return {"ran": True, "wait": (reserved or {}).get("code", "evaluation_budget"), "kind": "decision"}
    else:
        request_hash = job["requestHash"]
    if _multi_cancelled(cancel_event, job):
        call("decisionAbortBeforeDispatch", {"ticket": ticket, "stepKey": step_key})
        return {"ran": False, "wait": "cancelled", "kind": "decision"}
    started = call("decisionStarted", {"ticket": ticket, "stepKey": step_key, "requestHash": request_hash})
    if not isinstance(started, dict) or started.get("ok") is not True:
        return {"ran": False, "wait": (started or {}).get("code", "ticket_consumed"), "kind": "decision"}
    step = {"resultInFlight": False}
    prompt = {"system": job["system"], "text": job["prompt"], "maxTokens": job["outputTokens"]}
    try:
        usage, content, failure, finish = await _dispatch(driver, client, identity, prompt, state,
            limits={"textBytes": 8192}, truncation=True, step=step)
        wire_usage = ({"inputTokens": usage["promptTokens"], "outputTokens": usage["completionTokens"]}
                      if isinstance(usage, dict) and usage.get("known") is True else None)
        if failure is not None or content is None:
            code = "provider_refused" if failure == "reflection_refused" else failure or "provider_invalid_response"
            failed = call("decisionFail", {"ticket": ticket, "stepKey": step_key, "code": code,
                "usage": wire_usage, "allowFallback": not fallback and job.get("fallbackPending") is True})
            if isinstance(failed, dict) and failed.get("needsHostFallback") is True and not fallback:
                return await _decision_host_step(driver, job, cancel_event, call, fallback=True)
            job["ticket"] = None
            return {"ran": True, "wait": (failed or {}).get("record", {}).get("error", code), "kind": "decision"}
        try:
            result = json.loads(content["text"])
        except Exception:  # noqa: BLE001 — shared core parser validates the returned object
            result = None
        completed = call("decisionComplete", {"ticket": ticket, "stepKey": step_key, "model": identity.model,
            "result": result, "usage": wire_usage, "complete": not content.get("truncated", False),
            "abstention": finish == "content_filter", "evidenceRevision": job["evidenceRevision"],
            "version": job["version"], "fallbackPending": job.get("fallbackPending", False) and not fallback})
        if isinstance(completed, dict) and completed.get("needsHostFallback") is True and not fallback:
            return await _decision_host_step(driver, job, cancel_event, call, fallback=True)
        job["ticket"] = None
        record = completed.get("record", {}) if isinstance(completed, dict) else {}
        final = record.get("finalResult") or record.get("result") or {}
        action = final.get("action") if isinstance(final, dict) else None
        return {"ran": True, "wait": completed.get("code") if isinstance(completed, dict) else "decision_failed",
                "kind": "decision", "completed": completed.get("ok") is True,
                "result": {"action": action} if isinstance(action, str) else None, "record": record}
    except asyncio.CancelledError:
        if step.get("resultInFlight") is True:
            call("decisionFail", {"ticket": ticket, "stepKey": step_key, "code": "cancelled", "usage": None})
        else:
            call("decisionAbortBeforeDispatch", {"ticket": ticket, "stepKey": step_key})
        job["ticket"] = None
        raise


async def _multi_job(driver, job, cancel_event, call, key):
    """A review or an objective run: several paid steps on ONE signed ticket, on the ONE slot.

    The whole run is one job of the ONE `ReflectionDriver`: it occupies the same physical slot, its
    client is closed by the same owner-side cleanup AFTER the job Task really ended, and a
    cancellation is the same asyncio cancellation. What differs from a reflection is that the run is
    a SEQUENCE, so the three rules this module exists for are applied per step:

      • before EVERY `create` the core is asked again — `ticketContinuation` (through the material
        read) re-checks pause, exact stop, control generation, the plan's execution identity, the
        registry's pack version, the withdrawn licence and the already-incurred overrun. A permission
        withdrawn after step 2 stops step 3; the money that was already spent is still settled.
      • before the NEXT call is awaited, THIS step's raw measurement goes into the ticket through the
        core's own merger, with the merged quality (an unreadable step latches `unknown`).
      • the run reports FACTS. It never says `allowed`, `verified` or `validated`: the final gate is
        the core's own transaction, and the objective track is scored by the registered pack.
    """
    if job.get("kind") == "decision":
        return await _decision_job(driver, job, cancel_event, call)
    state = job.setdefault("_state", {})
    state.update({"ticket": None, "usage": None, "terminal": None, "cancelled": False,
                  "dispatch_started": False, "resource": None, "wire_usage": None})
    kind = job.get("kind")
    frozen = None
    failure = None
    try:
        proven, reason = driver.prove(job.get("route_provider"), job.get("route_model"),
                                      job.get("pre_api") or {})
        if proven is None:
            return {"ran": False, "wait": reason, "kind": kind}
        identity, runtime = proven["identity"], proven["runtime"]
        if _multi_cancelled(cancel_event, job):
            return {"ran": True, "wait": "cancelled", "kind": kind, "completed": False}
        # ── the LAST LOCAL check before the reservation ─────────────────────────────────────────
        # A client is built only AFTER the core has signed: the reservation is the first thing this
        # run buys, and a run that cannot even reach the provider must not sign one.
        prepared = driver._reserve(kind, job, call)
        if prepared.get("ok") is not True:
            return {"ran": False, "wait": prepared.get("wait") or "reflection_refused", "kind": kind}
        state["ticket"] = prepared["ticket"]
        job["ticket"] = prepared["ticket"]
        frozen = prepared.get("source")
        client, reason = driver._bind_client(identity, runtime)
        if client is None:
            failure = reason or "provider_driver_unsupported"
            return _multi_bail(state, kind, {"ran": True, "wait": failure}, failure)
        state["resource"] = client
        # ── THE LAST LOCAL CHECK, after the client exists and immediately before `create` ────────
        if _multi_cancelled(cancel_event, job):
            return _multi_bail(state, kind,
                               {"ran": True, "wait": "cancelled", "completed": False}, "cancelled")
        budget = {"steps": 0}
        if kind == "review":
            outcome = await _multi_review(driver, job, call, client, identity, cancel_event, state, budget)
        elif kind == "objective":
            outcome = await _multi_objective(driver, job, call, client, identity, cancel_event, state, budget)
        else:
            outcome = {"ok": False, "wait": "provider_driver_unsupported"}
        if outcome.get("ok") is not True:
            spend = state.get("spend") or {}
            failure = ("ticket_usage_unknown" if spend.get("unknown", 0) > 0
                       else outcome.get("wait") or "reflection_refused")
            payload = {"ran": True, "wait": failure, "kind": kind, "completed": False,
                       "costKnown": _cost_known(outcome), "truncated": outcome.get("truncated") is True}
            return _multi_bail(state, kind, payload, failure)
        state["terminal"] = outcome.get("terminal") or "committed"
        payload = {"ran": True, "wait": None, "kind": kind, "completed": True,
                   "truncated": outcome.get("truncated") is True,
                   "costKnown": outcome.get("costKnown"), "steps": budget["steps"],
                   "result": outcome.get("result")}
        if kind == "objective":
            payload["decision"] = outcome.get("decision")
        job["ticket"] = None
        return payload
    except asyncio.CancelledError:
        state["cancelled"] = True
        return _multi_bail(state, kind,
                           {"ran": True, "wait": "cancelled", "completed": False, "kind": kind}, "cancelled")
    except Exception as error:  # noqa: BLE001 — a driver bug is a bounded wait, never a promotion
        failure = getattr(error, "code", None) or "provider_driver_unsupported"
        return _multi_bail(state, kind, {"ran": True, "wait": failure, "kind": kind}, failure)
    finally:
        # A ticket this run signed and never finished stays CONSUMED, but its already-real cost is
        # persisted before the reference is dropped: the amount the provider told us about must not
        # be lost just because the run could not be committed.
        if state.get("ticket") is not None:
            if state.get("usage") is None and state.get("wire_usage") is not None:
                state["usage"] = state["wire_usage"]
            # ONCE per run: a success already reported and dropped the ticket, so this is the
            # stopped/cancelled/reported-nowhere path, which writes the merged measurement and its
            # quality exactly one final time.
            driver._settle_usage(call, state)
            job["ticket"] = None


def _cost_known(outcome):
    if outcome.get("costKnown") is None:
        return None
    return outcome.get("costKnown") is True


def _multi_cancelled(cancel_event, job):
    return (cancel_event is not None and cancel_event.is_set()) or job.get("invalidated") is True


def _multi_bail(state, kind, payload, terminal):
    state["terminal"] = terminal
    payload["ticket"] = state["ticket"]
    payload["terminal"] = terminal
    if payload.get("kind") is None:
        payload["kind"] = kind
    return payload


async def _multi_review(driver, job, call, client, identity, cancel_event, state, budget):
    """Two isolated arms and two swapped judge passes, all on the ticket's own frozen scenario.

    The core's material read `reviewMaterial` ends in `ticketContinuation`, so it is taken again
    before EVERY physical call — including the second arm and the second judge pass. A permission
    read before step 1 is not a lease for step 2: a pause, an exact stop, a control change, a
    re-registered or terminal plan, a rotated pack or a withdrawn licence that lands in between stops
    the NEXT paid call, and the money already spent is still settled on the ticket.
    """
    known = 0
    unknown = 0
    truncated = False
    try:
        material = driver._review_material(call, state["ticket"])
        if material.get("ok") is not True:
            return {"ok": False, "wait": material.get("code") or "reflection_refused"}
        limits = material.get("limits") or {}
        criteria = material.get("criteria") or []
        arms = material.get("arms") or {}
        max_tokens = 512
        answers = {}
        for name in ("candidate", "baseline"):
            if _multi_cancelled(cancel_event, job):
                return {"ok": False, "wait": "cancelled", "truncated": truncated}
            # ── THE PER-STEP PERMISSION, re-taken immediately before this arm's `create` ──────────
            material = driver._review_material(call, state["ticket"])
            if material.get("ok") is not True:
                return {"ok": False, "wait": material.get("code") or "reflection_refused",
                        "truncated": truncated}
            arms = material.get("arms") or {}
            arm = arms.get(name) or {}
            step = await _multi_step(driver, client, identity,
                                     {"system": arm.get("system", ""), "text": arm.get("prompt", ""),
                                      "maxTokens": 512, "stepKey": "review:" + name,
                                      "refresh": lambda: driver._review_material(call, state["ticket"])},
                                     state, budget, limits, call)
            if step.get("ok") is not True:
                return {"ok": False, "wait": step.get("wait"), "truncated": truncated}
            answer = _multi_arm(step["content"], state)
            answers[name] = answer
            truncated = truncated or answer["truncated"] is True
            known, unknown = driver._absorb_step(call, state, {name: answer})
        passes = []
        for index in (0, 1):
            if _multi_cancelled(cancel_event, job):
                return {"ok": False, "wait": "cancelled", "truncated": truncated}
            # ── THE PER-STEP PERMISSION, re-taken immediately before this judge's `create` ────────
            material = driver._review_material(call, state["ticket"])
            if material.get("ok") is not True:
                return {"ok": False, "wait": material.get("code") or "reflection_refused",
                        "truncated": truncated}
            built = driver._judge_request(call, state["ticket"], answers, index)
            if built.get("ok") is not True:
                return {"ok": False, "wait": built.get("code") or "reflection_refused", "truncated": truncated}
            step = await _multi_step(driver, client, identity,
                                     {"system": built.get("system", ""), "text": built.get("text", ""),
                                      "maxTokens": 512, "stepKey": "review:judge:%d" % index,
                                      "refresh": lambda: driver._review_material(call, state["ticket"])}, state, budget,
                                     {"armChars": 4000, "verdictBytes": int(
                                         (built.get("limits") or {}).get("responseBytes", 8192))}, call)
            if step.get("ok") is not True:
                return {"ok": False, "wait": step.get("wait"), "truncated": truncated}
            verdict = _multi_arm(step["content"], state)
            truncated = truncated or verdict["truncated"] is True
            passes.append({"built": built, "verdict": verdict})
            known, unknown = driver._absorb_step(call, state, {"verdict": verdict})
        ordered = sorted(passes, key=lambda entry: 0 if (entry["built"].get("labels") or {}).get("armA") == "A" else 1)
        swapped = (passes[0]["built"].get("labels") or {}).get("armA") != (passes[1]["built"].get("labels") or {}).get(
            "armA")
        if _multi_cancelled(cancel_event, job):
            return {"ok": False, "wait": "cancelled", "truncated": truncated}
        cost_known = unknown == 0 and known > 0
        # ── NO LOCAL STRUCTURED VERDICT ───────────────────────────────────────────────────────────
        # `structuredPassed` is deliberately NOT sent. The core treats an explicit boolean as the
        # AUTHORITATIVE host reading of the structured criteria, so deriving it here from the judge's
        # own prose would upgrade a model report into trusted structured evidence — the one thing this
        # side may never do. The verdict TEXT travels; the formal criteria interpretation (and the
        # neutral-safe refusal when nothing was really proved) stays in the Node core, where the
        # frozen case and the real arm answers are.
        payload = {"ticket": state["ticket"], "projectKey": job.get("projectKey"),
                   "planHash": job.get("planHash"), "packId": material.get("packId"),
                   "packVersion": material.get("packVersion"), "caseId": material.get("caseId"),
                   "scenarioHash": material.get("scenarioHash"), "criteriaHash": material.get("criteriaHash"),
                   "criteria": criteria,
                   "first": ordered[0]["verdict"]["text"] if len(ordered) > 0 else "",
                   "second": ordered[1]["verdict"]["text"] if len(ordered) > 1 else "",
                   "answers": {"candidate": answers["candidate"]["text"], "baseline": answers["baseline"]["text"]},
                   "swapped": swapped, "truncated": truncated,
                   "costKnown": cost_known, "source": "auto", "sourceBinding": True,
                   "judge": "%s/%s" % (identity.provider, identity.model)}
        if known > 0:
            payload["spent"] = known
        # The submission is one transaction; a ticket the core no longer holds is answered from its own
        # row, and nothing is promoted by this side.
        result = call("reviewResult", payload)
        # The commit transaction settled this ticket; the reference is dropped with it so the
        # end-of-run bookkeeping cannot write the same cost a second time.
        state["ticket"] = None
        return {"ok": True, "result": result, "costKnown": cost_known, "truncated": truncated,
                "terminal": (result or {}).get("code") or "committed"}
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "wait": getattr(error, "code", None) or "provider_driver_unsupported",
                "truncated": truncated}


async def _multi_objective(driver, job, call, client, identity, cancel_event, state, budget):
    """Walk the ticket's FROZEN case list one case at a time, two arms each, then settle once.

    The permission is re-taken before EVERY physical call: `objectiveMaterial` is the core's own
    cursor read AND its `ticketContinuation`, so the second arm of a case — and every later case — is
    gated on the state the core holds right now, not on the state it held when the case started.
    """
    known = 0
    unknown = 0
    truncated = False
    answers = {}
    usage = {}
    if job.get("packId") == "package-json-structure-v1" and not job.get("taskReplayCases"):
        try:
            call("evaluationCancel", {"ticket": state.get("ticket")})
        except Exception:  # noqa: BLE001 — never proceed to a pack call without the gate material
            pass
        return {"ok": False, "wait": "task_replay_evidence_unavailable", "truncated": False}
    cursor = int((job.get("objective") or {}).get("cursor") or 0)
    walk = 0
    try:
        while True:
            case = driver._objective_material(call, state["ticket"], cursor)
            if case.get("ok") is not True:
                if case.get("code") == "objective_cursor_out_of_range":
                    break
                return {"ok": False, "wait": case.get("code") or "reflection_refused",
                        "truncated": truncated}
            limits = case.get("limits") or {}
            case_id = case.get("caseId")
            max_tokens = 512
            pair = {}
            measured = {}
            for name in ("baseline", "candidate"):
                if _multi_cancelled(cancel_event, job):
                    return {"ok": False, "wait": "cancelled", "truncated": truncated}
                # ── THE PER-STEP PERMISSION, re-taken immediately before this arm's `create` ──────
                material = driver._objective_material(call, state["ticket"], cursor)
                if material.get("ok") is not True:
                    return {"ok": False, "wait": material.get("code") or "reflection_refused",
                            "truncated": truncated}
                arm = (material.get("arms") or {}).get(name) or {}
                step = await _multi_step(driver, client, identity,
                                         {"system": arm.get("system", ""), "text": arm.get("prompt", ""),
                                          "maxTokens": 128, "stepKey": "objective:%s:%s" % (case_id, name),
                                          "refresh": lambda: driver._objective_material(call, state["ticket"], cursor)},
                                         state, budget, limits, call)
                if step.get("ok") is not True:
                    return {"ok": False, "wait": step.get("wait"), "truncated": truncated}
                answer = _multi_arm(step["content"], state)
                pair[name] = answer["text"]
                if answer["truncated"] is True:
                    truncated = True
                    # A cut-off arm is reported as such: the pack refuses to score it as a pass, and
                    # the measurement travels with it so the pair is not a fabricated zero.
                measured[name] = answer["tokens"] if isinstance(answer["tokens"], int) else None
                known, unknown = driver._absorb_step(call, state, {name: answer})
            answers[case_id] = pair
            usage[case_id] = measured
            if not isinstance(case.get("next"), int):
                break
            cursor = case["next"]
            walk += 1
            if walk > OBJECTIVE_MAX_STEPS:
                return {"ok": False, "wait": "objective_step_budget", "truncated": truncated}
        task_replay_results = []
        replay_cases = job.get("taskReplayCases")
        if isinstance(replay_cases, list):
            for replay in replay_cases:
                if not isinstance(replay, dict) or not isinstance(replay.get("id"), str):
                    return {"ok": False, "wait": "task_replay_unverifiable", "truncated": truncated}
                outputs = {}
                for role in ("bad", "control"):
                    if _multi_cancelled(cancel_event, job):
                        return {"ok": False, "wait": "cancelled", "truncated": truncated}
                    material = replay.get("badInput" if role == "bad" else "controlInput")
                    if not isinstance(material, str):
                        return {"ok": False, "wait": "task_replay_unverifiable", "truncated": truncated}
                    step_key = "objective:task-replay:%s:%s" % (replay["id"][:16], role)
                    step = await _multi_step(driver, client, identity,
                        {"system": "Repair the package.json witness using this method: %s. Return only the complete JSON object." %
                         str(job.get("instruction") or "validate package.json structure and known field types"),
                         "text": material, "maxTokens": 128, "stepKey": step_key,
                         "refresh": lambda: call("ticketContinuation", {"ticket": state["ticket"], "kind": "evaluation"})},
                        state, budget, {"armChars": 32000, "verdictBytes": 32000}, call)
                    if step.get("ok") is not True:
                        return {"ok": False, "wait": step.get("wait"), "truncated": truncated}
                    answer = _multi_arm(step["content"], state)
                    if answer.get("truncated") is True:
                        return {"ok": False, "wait": "model_incomplete", "truncated": True}
                    outputs[role] = answer["text"]
                    known, unknown = driver._absorb_step(call, state, {role: answer})
                task_replay_results.append({"id": replay["id"], "badOutput": outputs["bad"],
                                            "controlOutput": outputs["control"]})
        if _multi_cancelled(cancel_event, job):
            return {"ok": False, "wait": "cancelled", "truncated": truncated}
        payload = {"ticket": state["ticket"], "lessonId": job.get("lessonId"),
                   "projectKey": job.get("projectKey"), "expectedVersion": job.get("version"),
                   "answers": answers, "usage": usage, "truncated": truncated, "sourceBinding": True}
        if task_replay_results:
            payload["taskReplayResults"] = task_replay_results
        if known > 0:
            payload["spent"] = known
        result = call("objectiveResult", payload)
        state["ticket"] = None
        return {"ok": True, "result": result, "costKnown": unknown == 0 and known > 0,
                "truncated": truncated, "decision": (result or {}).get("decision"),
                "terminal": (result or {}).get("code") or "committed"}
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "wait": getattr(error, "code", None) or "provider_driver_unsupported",
                "truncated": truncated}


def _expected(frozen):
    """The frozen binding echoed back so the core can prove this is the SAME attempt.

    It is an assertion of what the caller holds, never a licence: the core compares it against the
    record it froze and refuses a mismatch. The epoch is included because a released-then-republished
    identity can restart its revision at 1 in the same millisecond.
    """
    return {"routeId": frozen.get("routeId"), "revision": frozen.get("revision"),
            "bindingHash": frozen.get("bindingHash"), "epoch": frozen.get("epoch"),
            "controlGeneration": frozen.get("controlGeneration"),
            "sessionHash": frozen.get("sessionHash")}


def _bind_source(call, identity, job, problem):
    """Publish the proven identity with an explicit CAS, or report why it cannot be published."""
    session_id = job.get("source_session")
    if not isinstance(session_id, str) or session_id == "":
        return {"ok": False, "wait": "source_unknown"}
    status = call("sourceStatus", {"limit": 64})
    previous = None
    if isinstance(status, dict) and isinstance(status.get("rows"), list):
        want = session_hash(session_id)
        for row in status["rows"]:
            if isinstance(row, dict) and row.get("sessionHash") == want:
                previous = row
                break
    if previous is not None:
        # A row that already names a DIFFERENT identity for this session is drift, and drift is a
        # WAIT: republishing it here would let a reflection run on an execution the evidence was not
        # produced under, while making the ledger look consistent about it.
        known = previous.get("identity") if isinstance(previous.get("identity"), dict) else {}
        if not _identity_compatible(known, identity):
            return {"ok": False, "wait": "source_route_changed"}
    value = {"sessionId": session_id, **identity.publishable()}
    base = problem.get("base") if isinstance(problem.get("base"), dict) else {}
    for name in ("projectKey", "environmentId"):
        if base.get(name) is not None:
            value[name] = base[name]
    if previous is not None and isinstance(previous.get("revision"), int):
        value["expectRevision"] = previous["revision"]
    if previous is not None and isinstance(previous.get("epoch"), int):
        # The revision restarts at 1 after a release, so the EPOCH is what proves the caller really
        # read this row and not an older incarnation of it. Both preconditions travel together.
        value["expectEpoch"] = previous["epoch"]
    published = call("sourcePublish", value)
    if not isinstance(published, dict) or published.get("ok") is not True:
        return {"ok": False, "wait": (published or {}).get("code") or "source_capacity"}
    if published.get("published") is not True:
        return {"ok": False, "wait": (published.get("code") or "source_stale_revision")}
    if previous is not None:
        # The ENDPOINT comparison happens on the CORE's own digest: the row holds the fingerprint
        # the core computed, and this compares it with the fingerprint the core just computed for
        # the endpoint this dispatch will really use. No plaintext endpoint is stored either side.
        was = known.get("endpointFingerprint") if isinstance(known, dict) else None
        now = published.get("identity", {}).get("endpointFingerprint") \
            if isinstance(published.get("identity"), dict) else None
        if was is not None and now is not None and was != now:
            return {"ok": False, "wait": "source_route_changed"}
    return {"ok": True, "revision": published.get("revision"), "bindingHash": published.get("bindingHash"),
            "routeId": published.get("routeId")}


def _identity_compatible(known, identity):
    """Whether a stored identity is the SAME execution as the one just proved.

    The stored row holds the endpoint FINGERPRINT, never the URL: this computes the fingerprint of
    the endpoint just proved and compares digests, so the comparison needs no access to any stored
    plaintext — because there is none to have.
    """
    if not isinstance(known, dict) or not known:
        return True
    if known.get("provider") != identity.provider or known.get("model") != identity.model:
        return False
    if known.get("apiMode") not in (None, identity.api_mode):
        return False
    if known.get("reasoningState") != identity.reasoning_state:
        return False
    if identity.reasoning_state == REASONING_EXPLICIT and known.get("reasoningValue") != identity.reasoning_value:
        return False
    return True


def _reflection_request(job, problem, summaries, bound, control):
    task_summary, result_summary = summaries
    value = dict(job.get("base") or {})
    value.update({"taskSummary": task_summary, "resultSummary": result_summary,
                  "outcome": job.get("outcome") or "failed"})
    if isinstance(problem, dict) and isinstance(problem.get("id"), str):
        value["problemId"] = problem["id"]
    generation = job.get("generation")
    has_generation = isinstance(generation, dict)
    has_problem_revision = isinstance(problem, dict) and isinstance(problem.get("evidenceRevision"), int)
    if has_problem_revision:
        value["evidenceRevision"] = problem["evidenceRevision"]
    # A merge generation has no originating problem row, but it is still a privileged paid
    # reflection. It must carry the same fresh source and control proof that `_job` established
    # immediately before preparation; otherwise Core must refuse to sign its dispatch ticket.
    if has_problem_revision or has_generation:
        value.update({"sourceBinding": True, "sourceRevision": bound["revision"],
                      "sourceBindingHash": bound["bindingHash"], "controlGeneration": control})
    if has_generation:
        # Preserve the generation marker even when malformed: Core then rejects it instead of
        # silently treating a broken privileged request as an ordinary reflection.
        value["generation"] = {"decisionId": generation.get("decisionId"),
                                "generationKey": generation.get("generationKey")}
    return value
