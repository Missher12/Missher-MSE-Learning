"""Load an extracted artifact via real Hermes PluginManager, only in a temporary profile."""
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
    assert len(manager._plugins["mse-learning"].hooks_registered) == 9
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
    manager.unload("mse-learning")
    assert not manager._hooks.get("pre_llm_call")
    print(json.dumps({"ok": True, "layer": "packed Hermes PluginManager lifecycle", "restartRecall": True,
                      "requestAdoption": True, "legacyConflictPaused": True, "profileIsolated": True,
                      "backgroundProfileIsolated": True, "unloadedHooksRemoved": True, "modelCalls": 0}))
