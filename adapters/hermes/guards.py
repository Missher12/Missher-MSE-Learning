"""Small deterministic argument-contract guards for Hermes pre_tool_call."""
import copy
import re

_ID = re.compile(r"^[a-z][a-z0-9._:-]{0,63}$")
_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
_FIELDS = {"guardId", "toolName", "mode", "version", "requiredKeys", "allowedKeys"}


def validate_guard(template):
    if not isinstance(template, dict) or set(template) != _FIELDS:
        return None
    if not all(isinstance(template.get(key), str) and _ID.fullmatch(template[key])
               for key in ("guardId", "toolName")):
        return None
    if not isinstance(template.get("mode"), str) or template["mode"] not in {"observe", "shadow", "enforce", "suspended"}:
        return None
    if type(template["version"]) is not int or template["version"] < 1:
        return None
    required, allowed = template["requiredKeys"], template["allowedKeys"]
    if not isinstance(required, list) or not isinstance(allowed, list) or len(required) > 64 or len(allowed) > 128:
        return None
    if not all(isinstance(key, str) and _KEY.fullmatch(key) for key in required + allowed):
        return None
    if not set(required) <= set(allowed):
        return None
    return copy.deepcopy(template)


def check_guard(template, tool_name, args):
    rule = validate_guard(template)
    if rule is None or rule["mode"] in {"observe", "suspended"} or tool_name != rule["toolName"]:
        return None, False
    code = None
    if not isinstance(args, dict):
        code = "arguments_not_object"
    elif any(key not in args for key in rule["requiredKeys"]):
        code = "required_key_missing"
    elif any(key not in rule["allowedKeys"] for key in args):
        code = "unexpected_key"
    if code is None:
        return None, False
    return (f"MSE guard {rule['guardId']}: {code}" if rule["mode"] == "enforce" else None), True
