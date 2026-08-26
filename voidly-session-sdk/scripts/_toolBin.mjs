
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export function toolBin(name, fromDir) {
  const tried = [];
  let dir = fromDir;
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", name);
    tried.push(candidate);
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `${name} not found. It is a declared devDependency of this package, so this means\n` +
      `  the dependencies are not installed. Run \`npm install\` (at the repository root if\n` +
      `  this package is part of a workspace). Looked in:\n` +
      tried.map((t) => `    ${t}`).join("\n"),
  );
}
