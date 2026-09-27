"""Thin Hermes bridge to the same Node learning core. Never reads the legacy MSE store."""
from .bridge import Hooks


def register(ctx):
    from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
    home = get_hermes_home()

    def review(request, model):
        # Background threads do not inherit Hermes's ContextVar profile binding.
        token = set_hermes_home_override(home)
        try:
            return Hooks._review(request, model)
        finally:
            reset_hermes_home_override(token)

    hooks = Hooks(config={"stateRoot": str(home / "mse-learning"), "adapterId": "hermes", "maxContextBytes": 768},
                  review=review, enabled=lambda: not ctx.has_plugin("missher-evolution"))
    ctx.on_unload(hooks.dispose)
    for name in ("pre_llm_call", "pre_api_request", "post_api_request", "post_llm_call",
                 "post_tool_call", "on_session_end", "on_session_reset", "subagent_start", "subagent_stop"):
        ctx.register_hook(name, getattr(hooks, name))
