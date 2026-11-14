import ast
import copy
import contextlib
import io
import json
import os
import runpy
import sys


def is_name(node, value):
    return isinstance(node, ast.Name) and node.id == value


def is_attr(node, owner, value):
    return isinstance(node, ast.Attribute) and node.attr == value and is_name(node.value, owner)


def attr_is(node, value):
    return isinstance(node, ast.Attribute) and node.attr == value


def safe_relative(value):
    return (isinstance(value, str) and value != "" and len(value) <= 256 and not value.startswith("/")
            and "\\" not in value and not any(ord(char) < 32 or ord(char) == 127 for char in value)
            and all(part not in ("", ".", "..") for part in value.split("/")))


def path_argument(node, parent):
    if (not isinstance(node, ast.Call) or not is_name(node.func, "str") or node.keywords
            or len(node.args) != 1 or not isinstance(node.args[0], ast.BinOp)
            or not isinstance(node.args[0].op, ast.Div) or not isinstance(node.args[0].right, ast.Constant)
            or not isinstance(node.args[0].right.value, str)):
        return None
    left = node.args[0].left
    valid_left = is_name(left, "p") if not parent else is_attr(left, "p", "parent")
    value = node.args[0].right.value
    return value if valid_left and safe_relative(value) else None


def wrapper_paths(path):
    with open(path, "rb") as stream:
        raw = stream.read(32 * 1024 + 1)
    if len(raw) > 32 * 1024:
        return None
    try:
        tree = ast.parse(raw.decode("utf-8-sig"), mode="exec")
    except Exception:
        return None
    body = tree.body
    if len(body) != 5:
        return None
    if not (isinstance(body[0], ast.ImportFrom) and body[0].module == "pathlib" and body[0].level == 0
            and len(body[0].names) == 1 and body[0].names[0].name == "Path"
            and isinstance(body[1], ast.Import) and [alias.name for alias in body[1].names] == ["sys", "runpy"]
            and isinstance(body[2], ast.Assign) and len(body[2].targets) == 1
            and is_name(body[2].targets[0], "p")):
        return None
    p_expr = body[2].value
    resolve_call = p_expr.value if isinstance(p_expr, ast.Attribute) else None
    path_call = resolve_call.func.value if isinstance(resolve_call, ast.Call) \
        and isinstance(resolve_call.func, ast.Attribute) else None
    if not (isinstance(p_expr, ast.Attribute) and p_expr.attr == "parent"
            and isinstance(resolve_call, ast.Call) and attr_is(resolve_call.func, "resolve")
            and not resolve_call.args and not resolve_call.keywords
            and isinstance(path_call, ast.Call) and is_name(path_call.func, "Path")
            and len(path_call.args) == 1 and is_name(path_call.args[0], "__file__")
            and not path_call.keywords):
        return None
    argv = body[3]
    if not (isinstance(argv, ast.Assign) and len(argv.targets) == 1
            and isinstance(argv.targets[0], ast.Attribute) and argv.targets[0].attr == "argv"
            and is_name(argv.targets[0].value, "sys") and isinstance(argv.value, ast.List)
            and len(argv.value.elts) == 2):
        return None
    helper = path_argument(argv.value.elts[0], True)
    receipt = path_argument(argv.value.elts[1], False)
    call = body[4].value if isinstance(body[4], ast.Expr) else None
    if not (helper and receipt and isinstance(call, ast.Call) and is_attr(call.func, "runpy", "run_path")
            and len(call.args) == 1 and isinstance(call.args[0], ast.Subscript)
            and is_attr(call.args[0].value, "sys", "argv")
            and isinstance(call.args[0].slice, ast.Constant) and call.args[0].slice.value == 0
            and len(call.keywords) == 1 and call.keywords[0].arg == "run_name"
            and isinstance(call.keywords[0].value, ast.Constant)
            and call.keywords[0].value.value == "__main__"):
        return None
    template = f"""from pathlib import Path
import sys,runpy
p=Path(__file__).resolve().parent
sys.argv=[str(p.parent/{helper!r}),str(p/{receipt!r})]
runpy.run_path(sys.argv[0],run_name='__main__')
"""
    if ast.dump(tree, include_attributes=False) != ast.dump(ast.parse(template), include_attributes=False):
        return None
    return helper, receipt


def guard_supported(path):
    with open(path, "rb") as stream:
        raw = stream.read(32 * 1024 + 1)
    if len(raw) > 32 * 1024:
        return False
    try:
        tree = ast.parse(raw.decode("utf-8-sig"), mode="exec")
    except Exception:
        return False
    body = tree.body
    if len(body) != 6:
        return False
    try:
        error_text = body[4].body[0].value.args[0].value
        exit_code = body[4].body[1].exc.args[0].value
        success_text = body[5].value.args[0].value
    except (AttributeError, IndexError, TypeError):
        return False
    if (not isinstance(error_text, str) or len(error_text) > 1024 or type(exit_code) is not int or exit_code == 0
            or not isinstance(success_text, str) or len(success_text) > 1024):
        return False
    template = """import sys
from pathlib import Path
p = Path(sys.argv[1])
fields = dict(line.split("=", 1) for line in p.read_text().splitlines() if "=" in line)
if not fields.get("loadedVersion", "").strip():
    print("error", file=sys.stderr)
    raise SystemExit(7)
print("success")
"""
    expected = ast.parse(template, mode="exec")
    candidate = copy.deepcopy(tree)
    try:
        candidate.body[4].body[0].value.args[0].value = "error"
        candidate.body[4].body[1].exc.args[0].value = 7
        candidate.body[5].value.args[0].value = "success"
    except (AttributeError, IndexError, TypeError):
        return False
    return ast.dump(candidate, include_attributes=False) == ast.dump(expected, include_attributes=False)


def target_status(entry_path, expected_receipt, receipt_paths):
    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = 0
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            sys.argv = [entry_path]
            runpy.run_path(entry_path, run_name="__main__")
    except SystemExit as error:
        code = error.code
        exit_code = code if isinstance(code, int) else (0 if code is None else 1)
    except BaseException:
        exit_code = 1
    return {
        "entry": os.path.basename(entry_path),
        "receipt": expected_receipt,
        "receiptReadCount": receipt_paths[expected_receipt],
        "exitCode": exit_code,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
    }


def main():
    if len(sys.argv) != 6:
        print(json.dumps({"recognized": False, "reason": "invalid_runner_arguments"}, separators=(",", ":")))
        return
    intake, counter, helper, early, late = [os.path.realpath(os.path.abspath(path)) for path in sys.argv[1:6]]
    try:
        paths = [wrapper_paths(intake), wrapper_paths(counter)]
        if paths[0] is None or paths[1] is None or len({intake, counter, helper, early, late}) != 5:
            raise ValueError("paths must be unique")
        if paths[0][0] != paths[1][0] or paths[0][1] == paths[1][1]:
            raise ValueError("entry paths must share one helper and use distinct receipts")
        expected_helper = os.path.realpath(os.path.join(os.path.dirname(intake), "..", paths[0][0]))
        expected_early = os.path.realpath(os.path.join(os.path.dirname(intake), paths[0][1]))
        expected_late = os.path.realpath(os.path.join(os.path.dirname(counter), paths[1][1]))
        if [expected_helper, expected_early, expected_late] != [helper, early, late] or not guard_supported(helper):
            raise ValueError("unsupported source")
    except Exception:
        print(json.dumps({"recognized": False, "reason": "unsupported_source"}, separators=(",", ":")))
        return

    receipt_paths = {early: 0, late: 0}
    original_io_open = io.open

    def tracked_open(file, mode="r", *args, **kwargs):
        try:
            path = os.path.realpath(os.fspath(file))
            if mode.startswith("r") and path in receipt_paths:
                receipt_paths[path] += 1
        except (TypeError, ValueError):
            pass
        return original_io_open(file, mode, *args, **kwargs)

    io.open = tracked_open
    try:
        results = [
            target_status(intake, early, receipt_paths),
            target_status(counter, late, receipt_paths),
        ]
    finally:
        io.open = original_io_open
    print(json.dumps({"recognized": True, "entries": results}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
