"""Explicit small real-model smoke. Uses synthetic data and the existing Hermes model route.

This exercises hooks + real request, not a full native Agent session or long-term efficacy.
"""
import importlib.util
import json
import logging
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from hermes_cli.config import load_config_readonly
from hermes_cli.runtime_provider import resolve_runtime_provider
from hermes_constants import resolve_reasoning_config
from agent.auxiliary_client import call_llm

spec = importlib.util.spec_from_file_location("learning_live_smoke", root / "adapters/hermes/bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = load_config_readonly()
model_cfg = config.get("model", {})
model = model_cfg if isinstance(model_cfg, str) else model_cfg.get("default")
assert isinstance(model, str), "unsupported model configuration"
route = resolve_runtime_provider(requested=model_cfg.get("provider") if isinstance(model_cfg, dict) else None, target_model=model)
reasoning = resolve_reasoning_config(config, model)
logging.disable(logging.CRITICAL)
os.environ.update(MSE_NODE_EXECUTABLE=shutil.which("node"), MSE_LEARN_CLI=str(root / "src/cli.mjs"), MSE_REFLECTION_ENABLED="0")


def request(text, system="你是数据转换助手。按照任务要求仅返回 JSON，不要解释。", max_tokens=768):
    response = call_llm(task=None, provider=route["provider"], model=model, api_key=route.get("api_key"),
                        base_url=route.get("base_url"), api_mode=route.get("api_mode"), reasoning_config=reasoning,
                        messages=[{"role": "system", "content": system}, {"role": "user", "content": text}],
                        tools=None, timeout=35.0, max_tokens=max_tokens)
    choices = getattr(response, "choices", [])
    if len(choices) != 1 or getattr(choices[0].message, "tool_calls", None):
        raise ValueError("unexpected_model_response")
    output = choices[0].message.content
    if not isinstance(output, str) or len(output.encode()) > 4096:
        raise ValueError("missing_or_large_model_response")
    return output


def parse(text):
    text = text.strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    return json.loads(text)


started = time.monotonic()
report = {"layer": "real model controlled smoke, synthetic task", "model": model,
          "reasoning": reasoning, "hostSettingsChanged": False, "fullNativeAgentSession": False}
if "--reflection-only" in sys.argv[2:]:
    try:
        with tempfile.TemporaryDirectory(prefix="mse-live-reflection-") as state:
            hooks = module.Hooks(config={"stateRoot": state, "adapterId": "hermes", "maxContextBytes": 768})
            prepared = hooks.call("reflectionRequest", {"sessionId": "review", "turnId": "1", "outcome": "verified",
                "taskSummary": "导出金额前需要把单位从元转换为分并升序排序", "resultSummary": "输入含小数金额，转换成整数分并核对排序后独立检查通过"})
            text = module.Hooks._review(prepared["request"], model)
            settled = hooks.call("reflectionResult", {"ticket": prepared["ticket"], "result": parse(text)})
            report.update(reflectionCandidateCreated=settled.get("status") == "candidate", status=hooks.call("status", {}), ok=settled.get("ok") is True)
    except Exception as exc:
        report.update(ok=False, errorType=type(exc).__name__)
    report["elapsedSeconds"] = round(time.monotonic() - started, 2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report.get("ok") else 1)
try:
    with tempfile.TemporaryDirectory(prefix="mse-live-") as state:
        local = {"stateRoot": state, "adapterId": "hermes", "maxContextBytes": 768}
        prompt = "将金额按升序排序并导出：编号A金额12.35元，编号B金额2.50元。只返回JSON数组。"
        baseline_text = request(prompt)
        expected = [{"id": "B", "amount_cents": 250}, {"id": "A", "amount_cents": 1235}]
        report["baselineMatchedLearnedPreference"] = parse(baseline_text) == expected
        first = module.Hooks(config=local)
        first.pre_llm_call(session_id="correction", turn_id="1", user_message="以后导出金额并排序时，使用字段 id 和 amount_cents，金额换算为整数分后升序排列")
        first.on_session_end(session_id="correction", turn_id="1", completed=True)
        del first
        fresh = module.Hooks(config=local)
        prepared = fresh.pre_llm_call(session_id="new", turn_id="1", user_message=prompt, model=model)
        if not prepared or not prepared.get("context"):
            raise ValueError("relevance_miss")
        context = prepared["context"]
        report["contextBytes"] = len(context.encode())
        report["newSessionRecall"] = True
        augmented = prompt + "\n\n" + context
        common = {"session_id": "new", "turn_id": "1", "api_request_id": "live-synthetic"}
        fresh.pre_api_request(**common, request_messages=[{"role": "user", "content": augmented}])
        learned_text = request(augmented)
        fresh.post_api_request(**common)
        matched = parse(learned_text) == expected
        fresh.verification("new", "1", "synthetic-integer-cents-and-order", matched)
        fresh.post_llm_call(session_id="new", turn_id="1", assistant_response=learned_text)
        fresh.on_session_end(session_id="new", turn_id="1", completed=True)
        report["treatmentMatchedLearnedPreference"] = matched
        report["status"] = fresh.call("status", {})
        report["unrelatedContextBytes"] = len((fresh.pre_llm_call(session_id="unrelated", turn_id="1", user_message="请解释雨后为什么会出现彩虹") or {}).get("context", "").encode())
        # One additional bounded call checks open-method distillation on the actual configured route.
        reflection = fresh.call("reflectionRequest", {"sessionId": "review", "turnId": "1", "outcome": "verified",
            "taskSummary": "导出金额前需要把单位从元转换为分并升序排序", "resultSummary": "输入含小数金额，转换成整数分并核对排序后独立检查通过"})
        distilled = module.Hooks._review(reflection["request"], model)
        report["reflectionCompleted"] = False
        if isinstance(distilled, str):
            settled = fresh.call("reflectionResult", {"ticket": reflection["ticket"], "result": parse(distilled)})
            report["reflectionCompleted"] = settled.get("ok") is True
            report["reflectionCandidateCreated"] = settled.get("ok") is True and settled.get("status") == "candidate"
        report["ok"] = matched and report["unrelatedContextBytes"] == 0 and report["status"]["verified"] == 1
except Exception as exc:
    report.update(ok=False, errorType=type(exc).__name__)
report["elapsedSeconds"] = round(time.monotonic() - started, 2)
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(0 if report.get("ok") else 1)
