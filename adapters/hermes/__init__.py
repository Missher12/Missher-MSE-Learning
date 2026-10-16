"""Thin Hermes bridge to the same Node learning core. Never reads the legacy MSE store."""
import time

from .bridge import Hooks


def profile_bound_review(review, home=None):
    """Wrap a REAL driver so background work keeps ITS OWN Hermes profile binding.

    Background threads do not inherit Hermes's ContextVar profile binding, so a driver that runs off
    the hook thread has to re-establish it. Two details are load-bearing:

    * The profile is captured HERE (`home`), at factory time, on the thread that knows which profile
      this plugin was registered for. Resolving it inside the callback would read whatever
      `get_hermes_home()` happens to say on the WORKER thread — a different profile, or the default
      one — and then faithfully bind the work back to the wrong home.
    * `set_hermes_home_override(home)` and `reset_hermes_home_override(token)` are always paired, so
      a driver that raises still leaves the worker's ContextVar as it found it.

    This is the seam stage 4b registers a capability-proven single-attempt driver through; stage 4a
    deliberately registers no driver at all, which is what keeps `capability_waiting` honest.
    """
    if home is None:
        from hermes_constants import get_hermes_home
        home = get_hermes_home()

    def review_with_profile(request, model, cancel_event=None):
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        token = set_hermes_home_override(home)
        try:
            return review(request, model, cancel_event)
        finally:
            reset_hermes_home_override(token)

    review_with_profile.mse_profile_home = home
    return review_with_profile


def single_attempt_driver(home=None):
    """Build the stage-4b REAL single-attempt provider driver, bound to ONE Hermes profile.

    The profile is captured HERE, at factory time, on the thread that knows which profile this plugin
    was registered for — the same rule `profile_bound_review` follows. The driver re-establishes it
    inside its own loop thread for the WHOLE await region (resolution, dispatch, commit), so a
    coroutine that awaits does not silently fall back to whatever the worker thread's ContextVar
    happens to say.

    Returns a factory: the driver itself is built on the first real attempt, because it owns an
    asyncio loop thread and must not be created by a read-only status path.
    """
    if home is None:
        from hermes_constants import get_hermes_home
        home = get_hermes_home()

    def factory(hooks):
        from .driver import ReflectionDriver
        return ReflectionDriver(hooks, profile_home=home)

    factory.mse_profile_home = home
    return factory


def auto_advance_pass(home=None):
    """Build the stage-4c bounded auto-advance pass for ONE Hermes profile.

    The pass is a SHAPE, not a second policy: it owns the ONE wake-up chain and one serial guard, and
    every decision it appears to make is asked of the shared Node core through the trusted transport.
    It is a factory rather than an instance because the wake-up it owns must not be created by a
    read-only status path — installing the factory IS the capability claim, exactly as it is for the
    driver.
    """
    if home is None:
        from hermes_constants import get_hermes_home
        home = get_hermes_home()

    def factory(hooks):
        from .plan import build_auto_pass
        return build_auto_pass(hooks, call=hooks.call, clock=time.monotonic, state=hooks.plan,
                               schedule=getattr(hooks, "schedule", None),
                               cancel=getattr(hooks, "cancel", None))

    factory.mse_profile_home = home
    return factory


def register(ctx):
    from hermes_constants import get_hermes_home
    home = get_hermes_home()

    # Stage 4b: the capability-proven driver is registered HERE — the plain, explicit AsyncOpenAI +
    # Chat Completions single attempt (`adapters/hermes/driver.py`). The released `Hooks._review`
    # (profile default route + `call_llm`) is still NOT registered: its retry/fallback chain is
    # exactly what this driver replaces, and wiring it up would let an unproven route spend budget
    # while reporting itself as a supported automatic path. A source the driver cannot PROVE —
    # an unsupported protocol, an unreadable reasoning field, a collapsed custom provider — is an
    # explicit bounded wait that leaves the problem's evidence revision unspent.
    get_config = getattr(ctx, "get_config", None)
    guard_templates = get_config("guardTemplates", []) if callable(get_config) else []
    hooks = Hooks(config={"stateRoot": str(home / "mse-learning"), "adapterId": "hermes", "maxContextBytes": 768,
                          "guardTemplates": guard_templates},
                  enabled=lambda: not ctx.has_plugin("missher-evolution"),
                  driver_factory=single_attempt_driver(home))
    # Stage 4c: the ONE automatic-advance chain, started from the REAL registration path — never by a
    # settings page, a status read or a `why`. It asks the same permission the paid work answers to,
    # and a process that is not running has no timer at all.
    hooks.set_plan_pass(auto_advance_pass(home))
    try:
        hooks.start_auto_pass("startup")
    except Exception:  # noqa: BLE001 — a wake-up that cannot be armed is not a capability claim
        pass
    ctx.on_unload(hooks.dispose)
    ctx.mse_learning = hooks
    # `on_session_finalize` is the tenth hook: the CLI announces its OLD session id with
    # `platform="cli", reason="session_boundary"` before rotating, which is the only shape this
    # adapter treats as a permanent stop of that exact session. A normal exit (`reason="shutdown"`)
    # and plugin unload only stop this process, and acknowledged settlements stay durable.
    for name in ("pre_llm_call", "pre_api_request", "post_api_request", "post_llm_call", "pre_tool_call",
                 "post_tool_call", "on_session_end", "on_session_reset", "on_session_finalize",
                 "subagent_start", "subagent_stop"):
        ctx.register_hook(name, getattr(hooks, name))
