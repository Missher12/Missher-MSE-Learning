"""Load an extracted artifact via real Hermes PluginManager, only in a temporary profile."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

archive, host = map(lambda value: str(Path(value).resolve()), sys.argv[1:3])
sys.path.insert(0, host)
with tempfile.TemporaryDirectory(prefix="mse-hermes-native-") as root:
    # Deliberately disagree with the manager profile to catch process-global home leaks.
    os.environ["HERMES_HOME"] = str(Path(root) / "wrong-process-profile")
    os.environ["MSE_REFLECTION_ENABLED"] = "0"
    os.environ.pop("MSE_LEARN_CLI", None)
    subprocess.run(["tar", "-xzf", archive, "-C", root], check=True)
    from hermes_cli.plugins import PluginManager, LoadedPlugin
    from hermes_cli.plugins_manifest import PluginManifest, parse_manifest_file
    directory = Path(root) / "mse-learning"
    # The real plugin would be under plugins/, so keep state and installation separate here too.
    plugins = Path(root) / "plugins"
    plugins.mkdir()
    directory = directory.rename(plugins / "mse-learning")
    manifest = parse_manifest_file(directory / "plugin.yaml", directory, "user", "")
    assert manifest is not None
    manager = PluginManager(scope_key=root)
    manager._load_plugin(manifest)
    assert manager._plugins["mse-learning"].enabled, manager._plugins["mse-learning"].error
    assert len(manager._plugins["mse-learning"].hooks_registered) == 10
    manager.invoke_hook("pre_llm_call", session_id="first", turn_id="1", user_message="以后导出金额前先转换为数值，再按金额排序")
    manager.invoke_hook("on_session_end", session_id="first", turn_id="1", completed=True, failed=False, interrupted=False)
    manager.unload("mse-learning")
    manager._load_plugin(manifest)
    prompt = "导出金额并排序"
    results = manager.invoke_hook("pre_llm_call", session_id="next", turn_id="1", user_message=prompt)
    assert len(results) == 1 and "转换为数值" in results[0]["context"]
    context = results[0]["context"]
    common = {"session_id": "next", "turn_id": "1", "api_request_id": "actual-contract"}
    manager.invoke_hook("pre_api_request", **common, request_messages=[{"role": "user", "content": prompt + "\n\n" + context}])
    manager.invoke_hook("post_api_request", **common, finish_reason="stop")
    manager.invoke_hook("post_llm_call", session_id="next", turn_id="1", assistant_response="已完成金额导出")
    manager.invoke_hook("on_session_end", session_id="next", turn_id="1", completed=True, failed=False, interrupted=False)
    state = json.loads((Path(root) / "mse-learning/lessons-v1.json").read_text())
    assert state["lessons"][0]["adopted"] == 1
    assert state["lessons"][0]["verified"] == 0
    assert not (Path(root) / "wrong-process-profile/mse-learning").exists()
    assert not manager.invoke_hook("pre_llm_call", session_id="next", turn_id="2", user_message=prompt)
    legacy = LoadedPlugin(manifest=PluginManifest(name="missher-evolution"))
    legacy.enabled = True
    manager._plugins["missher-evolution"] = legacy
    assert not manager.invoke_hook("pre_llm_call", session_id="conflict", turn_id="1", user_message=prompt)
    del manager._plugins["missher-evolution"]
    assert manager.invoke_hook("pre_llm_call", session_id="resumed", turn_id="1", user_message="请导出金额并进行排序")
    from hermes_constants import get_hermes_home
    reflected = threading.Event()
    review_homes = []
    def fake_review(request, model, cancel_event=None):
        review_homes.append(str(get_hermes_home()))
        reflected.set()
        return json.dumps({"instruction": "处理金额排序时先核对数值类型，并复查金额导出顺序"})
    manager._plugins["mse-learning"].module.Hooks._review = staticmethod(fake_review)
    os.environ["MSE_REFLECTION_ENABLED"] = "1"
    manager.invoke_hook("post_tool_call", session_id="resumed", turn_id="1", status="error")
    manager.invoke_hook("post_llm_call", session_id="resumed", turn_id="1", assistant_response="金额导出排序检查失败，需要核对数据类型")
    manager.invoke_hook("on_session_end", session_id="resumed", turn_id="1", completed=True)
    assert reflected.wait(5), "reflection callback reached"
    assert review_homes == [root], "background review keeps the original profile"
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = json.loads((Path(root) / "mse-learning/lessons-v1.json").read_text())
        if any(item["kind"] == "method" for item in state["lessons"]):
            break
        time.sleep(0.05)
    assert any(item["kind"] == "method" and item["status"] == "candidate" for item in state["lessons"])
    # The CLI session boundary is the tenth hook, and it is the one shape that stops ONE session
    # permanently: the old id announced by the CLI before it rotates. It must reach the core's own
    # control transaction, leave no unconfirmed residue in the adapter, and never be confused with
    # an ordinary shutdown (which stops this process only).
    boundary = manager._hooks["on_session_finalize"][0].__self__
    document = Path(root) / "mse-learning/lessons-v1.json"
    def stop_tombstones():
        return ((json.loads(document.read_text()).get("settlementControl") or {}).get("stops")) or []

    manager.invoke_hook("on_session_finalize", session_id="rotated", platform="cli", reason="session_boundary")
    # A writer holding the core lock answers `lock_busy`; the adapter retries this stop itself,
    # bounded and without needing another turn, so the durable tombstone lands on its own.
    deadline = time.monotonic() + 10
    # Wait for BOTH facts: the core's committed tombstone and this adapter's own record leaving the
    # active set. Reading only the document would race the confirmation's own bookkeeping.
    while time.monotonic() < deadline and (not stop_tombstones() or boundary.pending_stops):
        time.sleep(0.05)
    stops = stop_tombstones()
    assert stops and stops[-1]["reason"] == "session_reset", (stops, boundary.durable_status(), boundary.control_errors)
    rotated = json.loads(document.read_text())
    assert stops[-1]["sessionHash"] == hashlib.sha256(b"rotated").hexdigest(), stops[-1]
    assert boundary.pending_stops == {} and not boundary.local_control_pending, "no unconfirmed stop kept"
    revision = rotated["revision"]
    status = boundary.durable_status()
    assert status["core"]["ok"] is True and status["unconfirmedStops"] == [], status
    assert json.loads(document.read_text())["revision"] == revision, "a read-only status wrote the document"
    manager.invoke_hook("on_session_finalize", session_id="shutdown-session", platform="cli", reason="shutdown")
    assert json.loads(document.read_text())["revision"] == revision, "a shutdown is not a session stop"
    manager.unload("mse-learning")
    assert not manager._hooks.get("pre_llm_call")
    print(json.dumps({"ok": True, "layer": "packed Hermes PluginManager lifecycle", "restartRecall": True,
                      "requestAdoption": True, "legacyConflictPaused": True, "profileIsolated": True,
                      "backgroundProfileIsolated": True, "unloadedHooksRemoved": True, "exactStopPersisted": True, "readOnlyStatus": True, "modelCalls": 0}))
