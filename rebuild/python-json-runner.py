import ast
import hashlib
import io
import json as real_json
import os
import sys
import types

BOM = b"\xef\xbb\xbf"
ALLOWED_IMPORTS = {"json", "pathlib", "sys"}
ALLOWED_ATTRIBUTES = {
    "Path", "with_name", "read_bytes", "write_bytes", "read_text", "write_text", "open", "read", "write", "flush",
    "startswith", "decode", "lstrip", "loads", "load", "dumps", "JSONDecodeError", "stderr", "stdout", "exit",
    "msg", "lineno", "colno", "args", "translate", "hex", "__name__",
}
SAFE_BUILTINS = {
    "Path", "isinstance", "bytes", "str", "print", "Exception", "BaseException", "UnicodeDecodeError",
    "UnicodeError", "PermissionError", "SystemExit", "ValueError", "TypeError", "JSONDecodeError",
    "len", "type", "ord",
}
ALLOWED_NODES = {
    ast.Module, ast.Import, ast.ImportFrom, ast.alias, ast.Assign, ast.FunctionDef, ast.arguments, ast.arg,
    ast.If, ast.While, ast.Try, ast.ExceptHandler, ast.With, ast.withitem, ast.Return, ast.Raise, ast.Expr,
    ast.Pass, ast.Name, ast.Load, ast.Store, ast.Constant, ast.Call, ast.Attribute, ast.Subscript, ast.Slice,
    ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not, ast.Compare, ast.Eq, ast.NotEq, ast.Is, ast.IsNot,
    ast.In, ast.NotIn, ast.Tuple, ast.List, ast.Dict, ast.DictComp, ast.comprehension,
    ast.keyword, ast.Starred, ast.BinOp, ast.Add,
}


def name_is(node, name):
    return isinstance(node, ast.Name) and node.id == name


def is_bom_loop(node):
    if not isinstance(node, ast.While) or node.orelse or len(node.body) != 1:
        return False
    test = node.test
    if (not isinstance(test, ast.Call) or test.keywords or len(test.args) != 1
            or not isinstance(test.func, ast.Attribute) or test.func.attr != "startswith"
            or not isinstance(test.func.value, ast.Name) or not isinstance(test.args[0], ast.Constant)
            or test.args[0].value != BOM):
        return False
    body = node.body[0]
    if not (isinstance(body, ast.Assign) and len(body.targets) == 1
            and isinstance(body.targets[0], ast.Name) and isinstance(body.value, ast.Subscript)):
        return False
    part = body.value
    return (name_is(test.func.value, body.targets[0].id) and name_is(part.value, body.targets[0].id)
            and isinstance(part.slice, ast.Slice) and isinstance(part.slice.lower, ast.Constant)
            and part.slice.lower.value == 3 and part.slice.upper is None and part.slice.step is None)


def safe_target(target):
    if isinstance(target, ast.Name):
        return not target.id.startswith("__") or target.id == "__name__"
    return (isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)
            and target.value.id == "json" and target.attr in {"loads", "load"})


def recognized_tree(tree, expected_name):
    nodes = list(ast.walk(tree))
    if len(nodes) > 4096 or any(type(node) not in ALLOWED_NODES for node in nodes):
        return False
    functions = {node.name for node in nodes if isinstance(node, ast.FunctionDef)}
    aliases = set()
    imports = set()
    has_read = False
    has_parse = False
    for node in nodes:
        if isinstance(node, ast.Name) and node.id.startswith("__") and node.id not in {"__file__", "__name__"}:
            return False
        if isinstance(node, ast.Attribute):
            if (node.attr.startswith("__") and node.attr != "__name__") or node.attr not in ALLOWED_ATTRIBUTES:
                return False
        if isinstance(node, ast.DictComp):
            if (len(node.generators) != 1 or node.generators[0].ifs or node.generators[0].is_async
                    or not isinstance(node.generators[0].target, ast.Name)
                    or not isinstance(node.generators[0].iter, ast.Constant)
                    or not isinstance(node.generators[0].iter.value, str)
                    or len(node.generators[0].iter.value) > 128):
                return False
        if isinstance(node, ast.While) and not is_bom_loop(node):
            return False
        if isinstance(node, ast.FunctionDef):
            if (node.decorator_list or node.returns is not None or node.type_comment is not None
                    or any(arg.annotation is not None for arg in [*node.args.posonlyargs, *node.args.args,
                        *node.args.kwonlyargs])):
                return False
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in ALLOWED_IMPORTS or alias.asname not in (None, alias.name):
                    return False
                imports.add(alias.name)
        if isinstance(node, ast.ImportFrom):
            if node.level != 0 or node.module not in ALLOWED_IMPORTS:
                return False
            allowed = {"pathlib": {"Path"}, "json": {"loads", "load", "dumps", "JSONDecodeError"},
                       "sys": {"stderr", "stdout", "exit"}}[node.module]
            if any(alias.name not in allowed for alias in node.names):
                return False
            if node.module == "json": aliases.update(alias.asname or alias.name for alias in node.names
                                                       if alias.name in {"loads", "load"})
            imports.add(node.module)
        if isinstance(node, ast.Assign):
            if len(node.targets) != 1 or not safe_target(node.targets[0]):
                return False
            target = node.targets[0]
            value = node.value
            if (isinstance(target, ast.Name) and isinstance(value, ast.Attribute)
                    and isinstance(value.value, ast.Name) and value.value.id == "json"
                    and value.attr in {"loads", "load"}):
                aliases.add(target.id)
        if isinstance(node, ast.Call):
            function = node.func
            if isinstance(function, ast.Name):
                if function.id not in SAFE_BUILTINS | functions | aliases:
                    return False
            elif isinstance(function, ast.Attribute):
                if function.attr not in ALLOWED_ATTRIBUTES:
                    return False
            else:
                return False
            if isinstance(function, ast.Attribute) and function.attr in {"read_bytes", "read_text", "open"}:
                has_read = True
            if isinstance(function, ast.Attribute) and function.attr in {"loads", "load"}:
                has_parse = True
            if isinstance(function, ast.Name) and function.id in aliases:
                has_parse = True
    return has_read and has_parse and imports.issubset(ALLOWED_IMPORTS)


def main():
    if len(sys.argv) != 3:
        print(real_json.dumps({"recognized": False, "reason": "invalid_runner_arguments"}, separators=(",", ":")))
        return
    script_path = os.path.abspath(sys.argv[1])
    input_path = os.path.abspath(sys.argv[2])
    try:
        with open(script_path, "rb") as source_file:
            script_bytes = source_file.read(32 * 1024 + 1)
        if len(script_bytes) > 32 * 1024:
            print(real_json.dumps({"recognized": False, "reason": "script_too_large"}, separators=(",", ":")))
            return
        tree = ast.parse(script_bytes.decode("utf-8-sig"), filename="mse-target.py", mode="exec")
        if not recognized_tree(tree, os.path.basename(input_path)):
            print(real_json.dumps({"recognized": False, "reason": "unsupported_script"}, separators=(",", ":")))
            return
    except Exception:
        print(real_json.dumps({"recognized": False, "reason": "unsupported_script"}, separators=(",", ":")))
        return

    reads = 0
    read_matched = False
    denied_paths = 0
    write_attempts = 0
    parse_count = 0
    parse_input_hash = None
    parse_succeeded = False
    parsed_values = []
    dumps_used_parse_result = False
    target_error = None
    target_exit_code = 0
    output_overflow = False
    target_stdout = None
    target_stderr = None

    class OutputLimitError(Exception):
        pass

    class BoundedCapture:
        def __init__(self, limit=256 * 1024):
            self.stream = io.StringIO()
            self.limit = limit
            self.bytes_written = 0

        def write(self, value):
            nonlocal output_overflow
            if not isinstance(value, str):
                raise PermissionError("stream value refused")
            encoded_size = len(value.encode("utf-8"))
            if self.bytes_written + encoded_size > self.limit:
                output_overflow = True
                raise OutputLimitError("target output limit exceeded")
            self.bytes_written += encoded_size
            return self.stream.write(value)

        def flush(self):
            return None

        def getvalue(self):
            return self.stream.getvalue()

    target_stdout = BoundedCapture()
    target_stderr = BoundedCapture()

    def read_input():
        nonlocal reads, read_matched
        reads += 1
        read_matched = True
        with open(input_path, "rb") as data_file:
            return data_file.read(64 * 1024 + 1)

    class SafeReader:
        def __init__(self, mode="rb", encoding="utf-8"):
            self.mode = mode
            self.encoding = encoding or "utf-8"
            raw = read_input()
            self.bytes_stream = io.BytesIO(raw)
            self.stream = self.bytes_stream if "b" in mode else io.TextIOWrapper(
                self.bytes_stream, encoding=self.encoding, errors="strict", newline=None)

        def read(self, size=-1):
            if not isinstance(size, int):
                raise TypeError("read size must be an integer")
            return self.stream.read(size)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    class SafePath:
        def __init__(self, value):
            nonlocal denied_paths
            if isinstance(value, SafePath):
                self.value = value.value
                return
            candidate = os.path.abspath(value)
            if candidate not in (script_path, input_path):
                denied_paths += 1
                raise PermissionError("path refused")
            self.value = candidate

        def with_name(self, name):
            if (name != os.path.basename(input_path)
                    or os.path.dirname(self.value) != os.path.dirname(input_path)):
                raise PermissionError("path refused")
            return SafePath(input_path)

        def read_bytes(self):
            if self.value != input_path:
                raise PermissionError("path refused")
            return read_input()

        def read_text(self, encoding="utf-8", errors="strict"):
            if encoding not in (None, "utf-8", "utf8", "utf-8-sig") or errors != "strict":
                raise PermissionError("encoding refused")
            raw = self.read_bytes()
            return raw.decode(encoding or "utf-8")

        def open(self, mode="r", buffering=-1, encoding=None, errors=None, newline=None):
            if any(flag in mode for flag in ("w", "a", "+", "x")):
                note_write()
            if self.value != input_path or mode not in ("r", "rb"):
                raise PermissionError("open refused")
            if errors not in (None, "strict") or newline is not None:
                raise PermissionError("reader options refused")
            return SafeReader(mode, encoding or "utf-8")

        def write_bytes(self, _value):
            note_write()

        def write_text(self, _value, encoding="utf-8", errors="strict", newline=None):
            note_write()

    def note_write():
        nonlocal write_attempts
        write_attempts += 1
        raise PermissionError("write refused")

    def record_parse(value, *args, **kwargs):
        nonlocal parse_count, parse_input_hash, parse_succeeded
        parse_count += 1
        raw = value if isinstance(value, bytes) else value.encode("utf-8") if isinstance(value, str) else None
        if raw is None:
            return real_json.loads(value, *args, **kwargs)
        parse_input_hash = hashlib.sha256(raw).hexdigest()
        parsed = real_json.loads(value, *args, **kwargs)
        parse_succeeded = True
        parsed_values.append(parsed)
        return parsed

    def observed_loads(value, *args, **kwargs):
        return record_parse(value, *args, **kwargs)

    def observed_load(file_obj, *args, **kwargs):
        return record_parse(file_obj.read(), *args, **kwargs)

    observed_json = types.ModuleType("json")
    observed_json.loads = observed_loads
    observed_json.load = observed_load
    observed_json.dumps = lambda value, *args, **kwargs: observe_dumps(value, *args, **kwargs)
    observed_json.JSONDecodeError = real_json.JSONDecodeError

    def observe_dumps(value, *args, **kwargs):
        nonlocal dumps_used_parse_result
        if isinstance(value, dict) and set(value) == {"ok", "config"}:
            dumps_used_parse_result = any(value["config"] is parsed for parsed in parsed_values)
        return real_json.dumps(value, *args, **kwargs)

    class SafeStream:
        def __init__(self, stream):
            self.stream = stream

        def write(self, value):
            if not isinstance(value, str):
                raise PermissionError("stream value refused")
            return self.stream.write(value)

        def flush(self):
            return None

    safe_sys = types.ModuleType("sys")
    safe_sys.stdout = SafeStream(target_stdout)
    safe_sys.stderr = SafeStream(target_stderr)

    def safe_exit(code=0):
        raise SystemExit(code)

    safe_sys.exit = safe_exit

    def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level != 0 or name not in {"json", "pathlib", "sys"}:
            raise ImportError("module refused")
        if name == "json":
            return observed_json
        if name == "sys":
            return safe_sys
        module = types.ModuleType("pathlib")
        module.Path = SafePath
        return module

    def capture_print(*args, sep=" ", end="\n", file=None, flush=False):
        if not isinstance(sep, str) or not isinstance(end, str) or len(args) > 8:
            raise PermissionError("print arguments refused")
        target = target_stdout if file is None or file is safe_sys.stdout else target_stderr if file is safe_sys.stderr else None
        if target is None:
            raise PermissionError("print stream refused")
        target.write(sep.join(str(value) for value in args) + end)

    safe_builtins = {"__import__": safe_import, "print": capture_print, "isinstance": isinstance,
                     "bytes": bytes, "str": str, "len": len, "Exception": Exception,
                     "BaseException": BaseException, "UnicodeDecodeError": UnicodeDecodeError,
                     "UnicodeError": UnicodeError, "type": type, "ord": ord,
                     "PermissionError": PermissionError, "SystemExit": SystemExit,
                     "ValueError": ValueError, "TypeError": TypeError,
                     "JSONDecodeError": real_json.JSONDecodeError}
    try:
        namespace = {"__builtins__": safe_builtins, "__file__": script_path, "__name__": "__main__"}
        exec(compile(tree, "mse-target.py", "exec"), namespace, namespace)
    except SystemExit as error:
        code = error.code
        if code is None or code == 0:
            target_exit_code = 0
        else:
            target_exit_code = code if isinstance(code, int) else 1
            target_error = "SystemExit"
    except BaseException as error:
        target_error = type(error).__name__

    envelope = {"recognized": True, "readCount": reads, "readMatched": read_matched,
                "deniedPaths": denied_paths, "writeAttempts": write_attempts,
                "parseCount": parse_count, "parseInputHash": parse_input_hash,
                "parseSucceeded": parse_succeeded, "dumpsUsedParseResult": dumps_used_parse_result,
                "targetExitCode": target_exit_code, "outputOverflow": output_overflow,
                "targetError": target_error, "targetStdout": target_stdout.getvalue(),
                "targetStderr": target_stderr.getvalue()}
    sys.stdout.write(real_json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
