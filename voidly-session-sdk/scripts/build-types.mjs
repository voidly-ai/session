#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { toolBin } from "./_toolBin.mjs";

const PKG_DIR = resolve(new URL("..", import.meta.url).pathname);
const require_ = createRequire(join(PKG_DIR, "package.json"));
const ts = require_("typescript");

const STAGE = mkdtempSync(join(tmpdir(), "voidly-session-dts-"));
try {
  execFileSync(
    toolBin("tsc", PKG_DIR),
    [
      "-p", "tsconfig.build.json",
      "--emitDeclarationOnly",
      "--declaration",
      "--noEmit", "false",
      "--removeComments",
      "--declarationMap", "false",
      "--declarationDir", STAGE,
    ],
    { cwd: PKG_DIR, stdio: ["ignore", "inherit", "inherit"] },
  );
} catch {
  console.error("declaration emit failed — fix the typecheck first");
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, acc);
    else if (abs.endsWith(".d.ts")) acc.push(abs);
  }
  return acc;
}

const SOURCES = new Map();
for (const abs of walk(STAGE)) {
  SOURCES.set(abs, ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.ES2021, true));
}

const PKG_DIR_NAME = basename(PKG_DIR);
function findEmitted(dtsName) {
  const rel = join("src", dtsName);
  const found =
    [...SOURCES.keys()].find((p) => p.endsWith(join(PKG_DIR_NAME, rel))) ??
    [...SOURCES.keys()].find((p) => p.endsWith(rel));
  if (!found) {
    console.error(`could not find the emitted entry declaration ${rel} under ${STAGE}`);
    process.exit(1);
  }
  return found;
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [`${base}.d.ts`, join(base, "index.d.ts")]) {
    if (SOURCES.has(cand)) return cand;
  }
  return null;
}

const TABLES = new Map();
function tableFor(file) {
  const cached = TABLES.get(file);
  if (cached) return cached;
  const sf = SOURCES.get(file);
  const decls = new Map();
  const imports = new Map();
  const reExports = new Map();
  const localAliases = new Map();

  const add = (name, stmt) => {
    if (!decls.has(name)) decls.set(name, []);
    decls.get(name).push(stmt);
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const target = resolveSpecifier(file, stmt.moduleSpecifier.text);
      const b = stmt.importClause?.namedBindings;
      if (target && b && ts.isNamedImports(b)) {
        for (const el of b.elements) {
          imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier?.text;
      const target = spec ? resolveSpecifier(file, spec) : null;
      if (spec && !target) {
        console.error(`unresolved re-export ${spec} in ${file}`);
        process.exit(1);
      }
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (target) reExports.set(el.name.text, { file: target, name: local });
          else localAliases.set(el.name.text, local);
        }
      } else if (target) {
        console.error(`export * is not supported by this flattener (${file})`);
        process.exit(1);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text, stmt);
    else if (ts.isClassDeclaration(stmt) && stmt.name) add(stmt.name.text, stmt);
    else if (ts.isInterfaceDeclaration(stmt)) add(stmt.name.text, stmt);
    else if (ts.isTypeAliasDeclaration(stmt)) add(stmt.name.text, stmt);
    else if (ts.isEnumDeclaration(stmt)) add(stmt.name.text, stmt);
    else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) add(stmt.name.text, stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text, stmt);
      }
    }
  }
  const t = { sf, decls, imports, reExports, localAliases };
  TABLES.set(file, t);
  return t;
}

function resolveDecl(file, name, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const t = tableFor(file);
  if (t.decls.has(name)) return { file, name };
  const local = t.localAliases.get(name);
  if (local !== undefined && local !== name) return resolveDecl(file, local, seen);
  if (t.reExports.has(name)) {
    const r = t.reExports.get(name);
    return resolveDecl(r.file, r.name, seen);
  }
  if (t.imports.has(name)) {
    const i = t.imports.get(name);
    return resolveDecl(i.file, i.name, seen);
  }
  return null;
}

function hasExportModifier(stmt) {
  return (stmt.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function publicSurfaceOf(entryFile) {
  const t = tableFor(entryFile);
  const pub = new Map();
  const put = (exported, target, from) => {
    if (!target) {
      console.error(`could not resolve public export \`${exported}\` from ${from}`);
      process.exit(1);
    }
    pub.set(exported, target);
  };
  for (const [exported, r] of t.reExports) put(exported, resolveDecl(r.file, r.name), r.file);
  for (const [exported, local] of t.localAliases) put(exported, resolveDecl(entryFile, local), entryFile);
  for (const [name, stmts] of t.decls) {
    if (stmts.some(hasExportModifier)) pub.set(name, { file: entryFile, name });
  }
  return pub;
}

function referencedNames(stmt) {
  const bound = new Set();
  const own = [];
  if (stmt.typeParameters) for (const p of stmt.typeParameters) bound.add(p.name.text);
  const visit = (node) => {
    if (ts.isTypeParameterDeclaration(node)) bound.add(node.name.text);
    if (ts.isTypeReferenceNode(node)) own.push(rootOf(node.typeName));
    else if (ts.isTypeQueryNode(node)) own.push(rootOf(node.exprName));
    else if (ts.isComputedPropertyName(node)) own.push(rootOf(node.expression));
    else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
      own.push(node.expression.text);
    } else if (ts.isImportTypeNode(node)) {
      console.error("import() types are not supported by this flattener");
      process.exit(1);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(stmt, visit);
  return own.filter((n) => n && !bound.has(n));
}
function rootOf(entityName) {
  let n = entityName;
  while (n && !ts.isIdentifier(n)) n = n.left ?? n.expression;
  return n ? n.text : null;
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

function flatten({ entryDtsName, outFileName, surfaceSpelledAs, minPublicExports }) {
  const entry = findEmitted(entryDtsName);
  const PUBLIC = publicSurfaceOf(entry);
  if (PUBLIC.size < minPublicExports) {
    console.error(
      `only ${PUBLIC.size} public exports resolved for ${outFileName} — the parse is partial, refusing to emit`,
    );
    process.exit(1);
  }

  const COLLECTED = new Map();
  const queue = [...PUBLIC.values()];
  while (queue.length) {
    const { file, name } = queue.pop();
    const key = `${file}#${name}`;
    if (COLLECTED.has(key)) continue;
    const t = tableFor(file);
    const stmts = t.decls.get(name);
    if (!stmts) {
      console.error(`no declaration of \`${name}\` in ${file}`);
      process.exit(1);
    }
    COLLECTED.set(key, { file, name, stmts });
    for (const stmt of stmts) {
      for (const ref of referencedNames(stmt)) {
        const target = resolveDecl(file, ref);
        if (target) queue.push(target);
      }
    }
  }

  {
    const byName = new Map();
    for (const { file, name } of COLLECTED.values()) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(file);
    }
    const clashes = [...byName].filter(([, files]) => files.length > 1);
    if (clashes.length) {
      console.error("declaration name collisions — rename one side at the source:");
      for (const [name, files] of clashes) console.error(`  ${name}: ${files.join(", ")}`);
      process.exit(1);
    }
  }

  const PUBLIC_BY_TARGET = new Map();
  for (const [exported, r] of PUBLIC) PUBLIC_BY_TARGET.set(`${r.file}#${r.name}`, exported);

  const out = [];
  out.push("// @voidly/session — GENERATED by scripts/build-types.mjs. Do not edit.");
  out.push("//");
  out.push(`// The transitive closure of what ${surfaceSpelledAs} exports, flattened into one`);
  out.push("// module. Server declarations are absent because nothing here reaches them.");
  out.push("");

  const aliasLines = [];
  for (const { file, name, stmts } of [...COLLECTED.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = `${file}#${name}`;
    const exportedAs = PUBLIC_BY_TARGET.get(key);
    for (const stmt of stmts) {
      let text = printer.printNode(ts.EmitHint.Unspecified, stmt, SOURCES.get(file)).trim();
      text = text.replace(/^export\s+/, "");
      if (exportedAs !== undefined) text = `export ${text}`;
      out.push(text);
    }
    if (exportedAs !== undefined && exportedAs !== name) {
      aliasLines.push(`export { ${name} as ${exportedAs} };`);
    }
  }
  out.push(...aliasLines);
  out.push("");

  const DIST = join(PKG_DIR, "dist");
  mkdirSync(DIST, { recursive: true });
  const target = join(DIST, outFileName);
  writeFileSync(target, out.join("\n"));

  const missing = [...PUBLIC.keys()].filter((n) => !new RegExp(`\\b${n}\\b`).test(out.join("\n")));
  if (missing.length) {
    console.error(`emitted file does not mention ${missing.length} public export(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `dist/${outFileName} — ${PUBLIC.size} public exports, ${COLLECTED.size} declarations, ` +
      `${(statSync(target).size / 1024).toFixed(1)} kB`,
  );
}

flatten({
  entryDtsName: "index.d.ts",
  outFileName: "index.d.ts",
  surfaceSpelledAs: "src/index.ts",
  minPublicExports: 150,
});
flatten({
  entryDtsName: "breakEven.d.ts",
  outFileName: "breakEven.d.ts",
  surfaceSpelledAs: "src/breakEven.ts",
  minPublicExports: 10,
});

rmSync(STAGE, { recursive: true, force: true });
