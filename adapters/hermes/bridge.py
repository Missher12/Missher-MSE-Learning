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


class Hooks:
    def __init__(self, config=None, call=None, review=None, enabled=None):
        self.config = config or {
            "stateRoot": str(Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser() / "mse-learning"),
            "adapterId": "hermes", "maxContextBytes": 768,
        }
        self.call = call or self._call
        self.turns = {}
        self.children = set()
        self.lock = threading.RLock()
        self.review = review or self._review
        self.reviewing = False
        self.enabled = enabled or (lambda: True)
        self.closed = False

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

    def pre_llm_call(self, **kwargs):
        try:
            if self.closed or not self.enabled():
                self.cancel_pending()
                return None
            ids = self._ids(kwargs)
            prompt = kwargs.get("user_message", kwargs.get("prompt"))
            if not ids or not isinstance(prompt, str) or len(prompt) > 32768 or not prompt.strip():
                return None
            if (ids[0] in self.children or kwargs.get("platform") in {"cron", "heartbeat", "diagnostic"}
                    or ids[0].startswith(("cron_", "heartbeat_", "diagnostic_"))
                    or any(os.environ.get(k, "").lower() in {"1", "true", "yes"} for k in ("HERMES_CRON_SESSION", "HERMES_MSE_INTERNAL"))
                    or kwargs.get("parent_session_id")
                    or "missher-evolution" in prompt.lower() or re.search(r"\bmse\b", prompt, re.I)
                    or prompt.startswith("Review the conversation above and")):
                return None
            with self.lock:
                if self.closed or not self.enabled():
                    return None
                now = time.monotonic()
                self.turns = {key: row for key, row in self.turns.items() if now - row["created"] < 1800}
                if ids in self.turns or len(self.turns) >= 256:
                    return None
                base = {"sessionId": ids[0], "turnId": ids[1]}
                project = kwargs.get("project_key") or kwargs.get("projectKey") or os.environ.get("HERMES_MSE_PROJECT_KEY")
                if project:
                    base["projectKey"] = project
                result = self.call("prepare", dict(base, prompt=prompt, origin="user"))
                if result.get("ok") is not True:
                    return None
                context = result.get("context", "")
                if not isinstance(context, str) or len(context.encode("utf-8")) > self.config["maxContextBytes"]:
                    return None
                self.turns[ids] = {"base": base, "receipt": result.get("receipt"), "lessons": result.get("lessons", []),
                                   "context": context, "request": None, "accepted": False, "failed": False,
                                   "created": now, "prompt_hash": hashlib.sha256(prompt.encode()).hexdigest(), "prompt_size": len(prompt),
                                   "task_summary": prompt[:800], "result_summary": "", "model": kwargs.get("model"), "tools": 0}
                return {"context": context} if context else None
        except Exception:
            return None

    def pre_api_request(self, **kwargs):
        with self.lock:
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
            row = self.turns.get(self._ids(kwargs))
            if not row or row["accepted"] or not row["request"] or row["request"] != kwargs.get("api_request_id"):
                return
            if kwargs.get("failed") or kwargs.get("error") or kwargs.get("interrupted"):
                return
            result = self.call("accept", {"receipt": row["receipt"], "lessonIds": row["lessons"]})
            row["accepted"] = result.get("ok") is True

    def post_tool_call(self, **kwargs):
        with self.lock:
            row = self.turns.get(self._ids(kwargs))
            if not row:
                return
            row["tools"] += 1
            # Tool success is not proof of task correctness; new tools invalidate prior verification.
            row.pop("evidence", None)
            if (kwargs.get("error") or kwargs.get("failed") or kwargs.get("success") is False
                    or kwargs.get("status") in {"error", "failed", "cancelled", "timeout"}):
                row["failed"] = True

    def verification(self, session_id, turn_id, check_id, passed):
        """Trusted checker callback; deliberately not registered as an Agent tool."""
        with self.lock:
            row = self.turns.get((session_id, str(turn_id)))
            if not row or not isinstance(check_id, str) or not check_id or type(passed) is not bool:
                return False
            row["failed"] = not passed
            row["evidence"] = {"source": "host_verifier", "checkId": check_id} if passed else None
            return True

    def post_llm_call(self, **kwargs):
        with self.lock:
            ids = self._ids(kwargs)
            row = self.turns.get(ids)
            if row and isinstance(kwargs.get("assistant_response"), str):
                row["result_summary"] = kwargs["assistant_response"][:1200]
            if not row or not (kwargs.get("completed") is True or kwargs.get("failed") or kwargs.get("interrupted")):
                return
            outcome = ("cancelled" if kwargs.get("interrupted") else "failed" if kwargs.get("failed") or row["failed"]
                       else "verified" if row.get("evidence") else "unknown")
            result = self.call("complete", dict(row["base"], outcome=outcome,
                                               **({"evidence": row["evidence"]} if outcome == "verified" else {})))
            if result.get("ok"):
                self.turns.pop(ids, None)
                if (outcome != "cancelled" and (outcome in {"failed", "verified"} or row["tools"] >= 2)
                        and row["result_summary"] and not self.reviewing
                        and os.environ.get("MSE_REFLECTION_ENABLED", "1") != "0"):
                    self.reviewing = True
                    threading.Thread(target=self._reflect, args=(row, outcome), daemon=True).start()

    def _reflect(self, row, outcome):
        try:
            if self.closed or not self.enabled():
                return
            prepared = self.call("reflectionRequest", dict(row["base"], taskSummary=row["task_summary"],
                                 resultSummary=row["result_summary"], outcome="supported" if outcome == "unknown" else outcome))
            if not prepared.get("ticket"):
                return
            text = self.review(prepared["request"], row["model"])
            if not isinstance(text, str) or len(text.encode("utf-8")) > 2048:
                return
            value = json.loads(text)
            with self.lock:
                if self.closed or not self.enabled():
                    return
                self.call("reflectionResult", {"ticket": prepared["ticket"], "result": value})
        except Exception:
            pass
        finally:
            with self.lock:
                self.reviewing = False

    @staticmethod
    def _review(request, task_model):
        # Reuse Hermes's configured route; an unknown session override degrades to no reflection.
        from hermes_cli.config import load_config_readonly
        from hermes_cli.runtime_provider import resolve_runtime_provider
        from agent.auxiliary_client import call_llm
        from hermes_constants import resolve_reasoning_config
        config = load_config_readonly()
        model_config = config.get("model", {})
        model = model_config if isinstance(model_config, str) else model_config.get("default", model_config.get("model"))
        if isinstance(model, dict):
            from hermes_cli.config import split_model_config_default
            model, _ = split_model_config_default(model)
        if not isinstance(task_model, str) or model != task_model:
            return None
        provider = model_config.get("provider") if isinstance(model_config, dict) else None
        route = resolve_runtime_provider(requested=provider, target_model=model)
        response = call_llm(task=None, provider=route["provider"], model=model,
                           api_key=route.get("api_key"), base_url=route.get("base_url"), api_mode=route.get("api_mode"),
                           reasoning_config=resolve_reasoning_config(config, model),
                           tools=None, timeout=15.0, max_tokens=request["maxTokens"],
                           messages=[{"role": "system", "content": request["system"]}, {"role": "user", "content": request["text"]}])
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
            for ids, row in list(self.turns.items()):
                if ids[0] == kwargs.get("session_id"):
                    self.call("complete", dict(row["base"], outcome="cancelled"))
                    self.turns.pop(ids, None)

    def on_session_reset(self, **kwargs):
        session = kwargs.get("old_session_id") or kwargs.get("session_id")
        if session:
            self.on_session_end(session_id=session)

    def cancel_pending(self):
        with self.lock:
            for row in self.turns.values():
                self.call("complete", dict(row["base"], outcome="cancelled"))
            self.turns.clear()

    def dispose(self):
        with self.lock:
            self.closed = True
            self.cancel_pending()
            self.children.clear()

    def subagent_start(self, **kwargs):
        value = kwargs.get("child_session_id") or kwargs.get("session_id")
        if isinstance(value, str) and len(self.children) < 256:
            self.children.add(value)

    def subagent_stop(self, **kwargs):
        self.children.discard(kwargs.get("child_session_id") or kwargs.get("session_id"))
