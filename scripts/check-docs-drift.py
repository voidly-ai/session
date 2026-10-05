#!/usr/bin/env python3
"""Offline Session docs guard: derive public exports from checked-out source."""

import argparse
import json
import re
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote, urlsplit


NAME = r"[A-Za-z_$][A-Za-z0-9_$]*"
EXPORT_START = re.compile(r"^export\b", re.M)
DIRECT = re.compile(
    rf"^export\s+(?:(async)\s+)?(function|class|interface|type|const|let|var|enum)\s+({NAME})\b"
)
ITEM = re.compile(rf"^(type\s+)?({NAME})(?:\s+as\s+({NAME}))?$")
ROW = re.compile(rf"^\|\s*`({NAME})`\s*\|\s*`([^`]+)`")
LINK = re.compile(r"!?\[[^\]]+\]\(([^)]+)\)")
IMPORT_BLOCK = re.compile(r"^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]\s*;", re.M | re.S)
DOC_IMPORT = re.compile(
    r"\bimport\s+(type\s+)?\{([^}]*)\}\s+from\s+['\"]@voidly/session(?:/([^'\"]+))?['\"]",
    re.S,
)
SECTIONS = {
    "./break-even": "Break-even",
    "./proofs": "Public Proofs",
    "./proofs-auto": "Owner-preauthorized Proofs",
    "./node-files": "Bounded Node file I/O",
    "./customer-hosted": "Customer-hosted owner-approved jobs",
}


@dataclass(frozen=True)
class Export:
    name: str
    kind: str  # type, function, class, const, enum
    async_function: bool = False
    module: str | None = None
    source_name: str | None = None


def parse_exports(text: str, label: str) -> dict[str, Export]:
    """Parse this source tree's explicit TS exports; reject unfamiliar syntax."""
    out: dict[str, Export] = {}
    for hit in EXPORT_START.finditer(text):
        tail = text[hit.start():]
        block = re.match(r"^export\s+(type\s+)?\{", tail)
        if block:
            end = tail.find("}", block.end())
            if end < 0:
                raise ValueError(f"{label}: unterminated export block")
            items = tail[block.end():end]
            suffix = tail[end + 1:].split(";", 1)[0].strip()
            module = None
            if suffix:
                match = re.fullmatch(r"from\s+['\"]([^'\"]+)['\"]", suffix)
                if not match:
                    raise ValueError(f"{label}: unsupported export suffix {suffix[:80]!r}")
                module = match.group(1)
            for raw in items.split(","):
                raw = raw.strip()
                if not raw:
                    continue
                item = ITEM.fullmatch(raw)
                if not item:
                    raise ValueError(f"{label}: unsupported export item {raw!r}")
                type_item, source_name, alias = item.groups()
                name = alias or source_name
                kind = "type" if block.group(1) or type_item else "reexport"
                if name in out:
                    raise ValueError(f"{label}: duplicate export {name}")
                out[name] = Export(name, kind, module=module, source_name=source_name)
            continue

        direct = DIRECT.match(tail)
        if not direct:
            raise ValueError(f"{label}: unsupported export near {tail[:80]!r}")
        async_word, kind, name = direct.groups()
        if kind in ("interface", "type"):
            kind = "type"
        elif kind in ("const", "let", "var"):
            kind = "const"
        if name in out:
            raise ValueError(f"{label}: duplicate export {name}")
        out[name] = Export(name, kind, bool(async_word))
    return out


def source_for_export(root: Path, entry: str, condition: object) -> Path:
    def import_path(value: object) -> str | None:
        if isinstance(value, str):
            return value if value.endswith(".mjs") else None
        if isinstance(value, dict):
            for key in ("import", "node", "default"):
                if key in value:
                    found = import_path(value[key])
                    if found:
                        return found
        return None

    target = import_path(condition)
    if not target or not re.fullmatch(r"\./dist/[A-Za-z][A-Za-z0-9]*\.mjs", target):
        raise ValueError(f"unsupported package export target for {entry}: {condition!r}")
    source = root / "voidly-session-sdk" / "src" / (Path(target).stem + ".ts")
    if not source.is_file():
        raise ValueError(f"{entry}: missing source {source}")
    return source


def indexed_symbols(index: str) -> dict[str, set[str]]:
    """Read only the index's explicit value/type lists, including stale names."""
    result = {"values": [], "types": []}
    pattern = re.compile(
        r"\*\*(Runtime values|TypeScript types) \((\d+)\):\*\*\s*\n(.*?)(?=\n\*\*|\n##|\Z)", re.S
    )
    for match in pattern.finditer(index):
        kind = "values" if match.group(1) == "Runtime values" else "types"
        names = re.findall(r"`(" + NAME + r")`", match.group(3))
        if len(names) != int(match.group(2)):
            raise ValueError(f"export-index.md {kind} count does not match listed names")
        result[kind].extend(names)
    for kind, names in result.items():
        if not names or len(names) != len(set(names)):
            raise ValueError(f"export-index.md has missing or duplicate {kind} entries")
    return {kind: set(names) for kind, names in result.items()}


def call_arguments(text: str, name: str) -> list[str]:
    """Split one named call/signature at top-level commas, respecting object args."""
    start = text.find(name + "(")
    if start < 0:
        raise ValueError(f"missing call/signature: {name}")
    cursor = start + len(name) + 1
    depth = 0
    quote = None
    begin = cursor
    parts = []
    while cursor < len(text):
        char = text[cursor]
        if quote:
            if char == "\\":
                cursor += 2
                continue
            if char == quote:
                quote = None
        elif char in ("'", '"', "`"):
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            if char == ")" and depth == 0:
                tail = text[begin:cursor].strip()
                if tail:
                    parts.append(tail)
                return parts
            depth -= 1
        elif char == "," and depth == 0:
            parts.append(text[begin:cursor].strip())
            begin = cursor + 1
        cursor += 1
    raise ValueError(f"unterminated call/signature: {name}")


def check(root: Path) -> list[str]:
    errors: list[str] = []
    package = json.loads((root / "voidly-session-sdk/package.json").read_text())
    entries = {key: source_for_export(root, key, condition)
               for key, condition in package["exports"].items() if key != "./package.json"}
    if set(entries) != {".", *SECTIONS}:
        errors.append(f"package entry list changed: {sorted(entries)}; update docs section map")

    @lru_cache(maxsize=None)
    def exports(path: Path) -> dict[str, Export]:
        return parse_exports(path.read_text(), str(path.relative_to(root)))

    def resolve(path: Path, name: str, seen: frozenset[tuple[Path, str]] = frozenset()) -> Export:
        key = (path, name)
        if key in seen:
            raise ValueError(f"cyclic reexport: {name} in {path}")
        item = exports(path).get(name)
        if item is None:
            raise ValueError(f"missing reexport target: {name} in {path}")
        if item.module is None:
            if item.kind == "reexport":
                for imported in IMPORT_BLOCK.finditer(path.read_text()):
                    for raw in imported.group(1).split(","):
                        match = ITEM.fullmatch(raw.strip())
                        if match and (match.group(3) or match.group(2)) == (item.source_name or name):
                            module = imported.group(2)
                            if not module.startswith("."):
                                raise ValueError(f"nonlocal imported reexport: {module} in {path}")
                            target = (path.parent / (module + ".ts")).resolve()
                            if not target.is_relative_to(root) or not target.is_file():
                                raise ValueError(f"missing imported reexport target: {target}")
                            return resolve(target, match.group(2), seen | {key})
                raise ValueError(f"local unbound reexport: {name} in {path}")
            return item
        if not item.module.startswith("."):
            raise ValueError(f"nonlocal reexport: {item.module} in {path}")
        target = (path.parent / (item.module + ".ts")).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise ValueError(f"missing/escaping reexport target: {target}")
        resolved = resolve(target, item.source_name or name, seen | {key})
        return resolved

    catalog: dict[str, dict[str, Export]] = {}
    for entry, path in entries.items():
        entry_exports = exports(path)
        for name in entry_exports:
            resolve(path, name)
        catalog[entry] = entry_exports

    docs = root / "docs"
    index = (docs / "export-index.md").read_text()
    api = (docs / "api-reference.md").read_text()
    subpaths = (docs / "subpaths.md").read_text()
    actual_values = {name for name, item in catalog["."].items() if item.kind != "type"}
    actual_types = set(catalog["."]) - actual_values
    listed = indexed_symbols(index)
    for kind, actual in (("values", actual_values), ("types", actual_types)):
        for name in sorted(actual - listed[kind]):
            errors.append(f"root {kind} missing from export-index.md: {name}")
        for name in sorted(listed[kind] - actual):
            errors.append(f"stale/misclassified export-index.md {kind}: {name}")

    sections = re.split(r"^## (.+)$", subpaths, flags=re.M)
    by_heading = {sections[i]: sections[i + 1] for i in range(1, len(sections) - 1, 2)}
    for entry, heading in SECTIONS.items():
        section = by_heading.get(heading)
        if section is None:
            errors.append(f"missing subpaths.md section: {heading}")
            continue
        for name in catalog.get(entry, {}):
            if not re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", section):
                errors.append(f"{entry}: {name} missing from subpaths.md section {heading}")

    for page in sorted(docs.glob("*.md")):
        for block in re.findall(r"^```(?:ts|typescript)\s*\n(.*?)^```", page.read_text(), re.M | re.S):
            for imported in DOC_IMPORT.finditer(block):
                entry = "." if imported.group(3) is None else "./" + imported.group(3)
                if entry not in catalog:
                    errors.append(f"{page.name}: unknown package subpath {entry}")
                    continue
                for raw in imported.group(2).split(","):
                    if not raw.strip():
                        continue
                    item = ITEM.fullmatch(raw.strip())
                    if not item:
                        errors.append(f"{page.name}: unsupported named import {raw.strip()!r}")
                        continue
                    type_item, source_name, _alias = item.groups()
                    exported = catalog[entry].get(source_name)
                    if exported is None:
                        errors.append(f"{page.name}: {source_name} is not exported by {entry}")
                    elif exported.kind == "type" and not (imported.group(1) or type_item):
                        errors.append(f"{page.name}: type-only {source_name} needs a type import")

    rows = {}
    for line in api.splitlines():
        match = ROW.match(line)
        if match:
            name, example = match.groups()
            if name in rows:
                errors.append(f"duplicate API example row: {name}")
            rows[name] = example
    root_values = actual_values
    for name, example in rows.items():
        if name not in root_values:
            errors.append(f"API example names a non-exported value: {name}")
        elif not re.search(rf"\b{re.escape(name)}\(", example):
            errors.append(f"API example does not call {name}: {example}")
    callable_count = 0
    async_count = 0
    for name in root_values:
        resolved = resolve(entries["."], name)
        if resolved.kind != "function":
            continue
        callable_count += 1
        example = rows.get(name)
        if example is None:
            errors.append(f"callable root export missing API example row: {name}")
            continue
        if resolved.async_function:
            async_count += 1
            if not re.search(rf"\bawait\s+{re.escape(name)}\(", example):
                errors.append(f"async API example needs await: {name}")
        elif re.search(rf"\bawait\s+{re.escape(name)}\(", example):
            errors.append(f"sync API example has await: {name}")

    version = package["version"]
    for page in (docs / "README.md", docs / "quickstart.md", docs / "api-reference.md", docs / "export-index.md"):
        header = "\n".join(page.read_text().splitlines()[:5])
        if not re.search(rf"(?<![0-9]){re.escape(version)}(?![0-9])", header):
            errors.append(f"{page.name} header does not name package version {version}")

    quickstart = (docs / "quickstart.md").read_text()
    save = quickstart.find("await applicationPrivateStore.saveNewOriginal(")
    submit = quickstart.find("await submitHire(")
    if save < 0 or submit < 0 or save > submit:
        errors.append("quickstart must save the original hire privately before submitHire")
    for field in ("authorization: payment.authorization", "acceptUrl:", "sessionEndpointBaseUrl:"):
        if field not in quickstart[save:submit]:
            errors.append(f"quickstart pre-submit save missing {field}")

    hirer = (root / "voidly-session-sdk/src/hirer.ts").read_text()
    error_guide = (docs / "errors.md").read_text()
    for type_name, method in (("SubmitHireResult", "submitHire"), ("RecoverResultOutcome", "recoverResult")):
        definition = re.search(rf"export type {type_name}\s*=\s*(.*?)(?=\n\n)", hirer, re.S)
        sentence = re.search(rf"`{method}` returns ([^.]+)\.", error_guide)
        if not definition or not sentence:
            errors.append(f"cannot compare {type_name} kinds with errors.md")
            continue
        source_kinds = set(re.findall(r'kind:\s*"([a-z_]+)"', definition.group(1)))
        doc_kinds = set(re.findall(r"`([a-z_]+)`", sentence.group(1)))
        if source_kinds != doc_kinds:
            errors.append(f"errors.md {method} kinds differ: source={sorted(source_kinds)} docs={sorted(doc_kinds)}")

    for name in ("signReceiveAuthorization", "buildHireMessage"):
        source = resolve(entries["."], name)
        source_path = root / ("voidly-session-sdk/src/submission.ts" if name == "signReceiveAuthorization" else "session-protocol/src/hire.ts")
        source_text = source_path.read_text()
        declaration = re.search(rf"^export\s+(?:async\s+)?function\s+{name}\s*\(", source_text, re.M)
        if not declaration:
            errors.append(f"cannot find source function declaration: {name}")
            continue
        expected_arity = len(call_arguments(source_text[declaration.start():], name))
        example = rows.get(name)
        if source.kind != "function" or example is None or len(call_arguments(example, name)) != expected_arity:
            errors.append(f"API example arity differs from source: {name} expects {expected_arity} arguments")

    payment_source = (root / "voidly-session-sdk/src/payment.ts").read_text()
    authorization_input = re.search(r"export interface BuildAuthorizationInput\s*\{(.*?)\n\}", payment_source, re.S)
    if not authorization_input:
        errors.append("cannot find BuildAuthorizationInput for EIP-712 time unit check")
    else:
        valid_after = re.search(r"\bvalidAfter:\s*(number|string)\s*;", authorization_input.group(1))
        if not valid_after:
            errors.append("cannot identify validAfter input type")
        for name in ("buildReceiveAuthorizationTypedData", "buildTransferAuthorizationTypedData"):
            example = rows.get(name, "")
            literal = re.search(r"\bvalidAfter:\s*([^,}]+)", example)
            value = literal.group(1).strip() if literal else ""
            if valid_after and valid_after.group(1) == "number" and not re.fullmatch(r"[0-9]+", value):
                errors.append(f"{name} example validAfter must match source numeric seconds type")
            elif valid_after and valid_after.group(1) == "string" and not re.fullmatch(r"['\"][^'\"]*['\"]", value):
                errors.append(f"{name} example validAfter must match source string type")

    config = json.loads((root / "context7.json").read_text())
    if "docs" not in config.get("folders", []):
        errors.append("context7.json folders must include docs")

    for page in [root / "README.md", root / "llms.txt", *sorted(docs.glob("*.md"))]:
        body = page.read_text()
        for raw in LINK.findall(body):
            href = raw.strip().strip("<>").split(" ", 1)[0]
            if not href or href.startswith(("mailto:", "data:")):
                continue
            url = urlsplit(href)
            if url.scheme:
                if url.netloc != "github.com" or not url.path.startswith("/voidly-ai/session/"):
                    continue
                match = re.match(r"^/voidly-ai/session/(?:blob|tree)/[^/]+/(.+)$", url.path)
                if not match:
                    continue
                target = root / unquote(match.group(1))
            else:
                target = (page.parent / unquote(url.path)).resolve() if url.path else page
            if not target.is_relative_to(root) or not target.exists():
                errors.append(f"broken local/repo link in {page.relative_to(root)}: {href}")
                continue
            if url.fragment and target.suffix == ".md":
                headings = [slug(m.group(1)) for m in re.finditer(r"^#{1,6}\s+(.+)$", target.read_text(), re.M)]
                if unquote(url.fragment) not in headings:
                    errors.append(f"missing heading #{url.fragment} in {target.relative_to(root)}")

    print(f"checked {len(catalog)} package entries; {len(root_values)} root values; "
          f"{callable_count} root functions ({async_count} async); {len(rows)} API rows")
    return errors


def slug(heading: str) -> str:
    return re.sub(r"\s", "-", re.sub(r"[^\w\s-]", "", heading.lower().strip()))


def self_test() -> None:
    fixture = """export { direct, type T as Alias } from './other';
export async function run(): Promise<void> { return; }
export const LIMIT = 3;
export interface Options { ok: boolean }
"""
    parsed = parse_exports(fixture, "fixture")
    assert list(parsed) == ["direct", "Alias", "run", "LIMIT", "Options"]
    assert parsed["Alias"].kind == "type" and parsed["run"].async_function
    assert slug("Owner-preauthorized Proofs") == "owner-preauthorized-proofs"
    try:
        parse_exports("export * from './x';", "unsupported fixture")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown export syntax must fail closed")
    print("parser fixtures: pass")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        if args.self_test:
            self_test()
        else:
            problems = check(args.root.resolve())
            for problem in problems:
                print("ERROR:", problem, file=sys.stderr)
            if problems:
                raise SystemExit(1)
            print("docs drift: pass")
    except (ValueError, OSError, KeyError) as exc:
        raise SystemExit(f"docs drift check failed: {exc}") from exc
