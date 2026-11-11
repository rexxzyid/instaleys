import ast
import sys


def load(path):
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    return source, ast.parse(source)


def functions(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def params(node):
    names = [a.arg for a in node.args.args]
    return names[1:] if names and names[0] in ("self", "cls") else names


def body_start(node):
    first = node.body[0]
    is_doc = isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant)
    if is_doc and isinstance(first.value.value, str) and len(node.body) > 1:
        return node.body[1].lineno - 1
    return first.lineno - 1


def main():
    if len(sys.argv) < 3:
        print("pemakaian: python3 scripts/pyfn.py <file.py> --list | <nama_fungsi> [nama_fungsi ...]")
        sys.exit(2)
    path, args = sys.argv[1], sys.argv[2:]
    source, tree = load(path)
    lines = source.split("\n")
    if args == ["--list"]:
        for node in functions(tree):
            print(f"{node.lineno}\t{node.name}\t{params(node)}")
        return
    found = {node.name: node for node in functions(tree)}
    missing = [name for name in args if name not in found]
    for name in args:
        node = found.get(name)
        if node is None:
            continue
        print(f"## {name} {params(node)} (baris {node.lineno})")
        print("\n".join(lines[body_start(node):node.end_lineno]))
    if missing:
        print(f"tidak ditemukan: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)


main()
