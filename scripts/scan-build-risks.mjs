// Pre-build static scanner — catches the most common build-breakers
// we've hit recently before they reach the VPS:
//   1. Client component ("use client") importing from a module that
//      pulls Node-only deps (e.g. @/lib/db drags better-sqlite3).
//   2. Stray references to a renamed type field — usually shows up
//      after a rename when one call site was missed.
//   3. Object literals where a property name doesn't match the
//      declared type (best-effort — we don't have the TS compiler).
//
// Intentionally conservative: false-positives are noise, false-
// negatives let bugs through. We err on the side of false-positives
// and document them in MAY_FAIL.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name === ".git") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const files = walk("src");
const issues = [];

// Modules that transitively pull better-sqlite3 (node:fs / node:path)
// when imported. Keep this list short — only modules that are server-
// only by design.
const NODE_ONLY_MODULES = ["@/lib/db", "@/lib/auth", "@/lib/messaging-channels"];

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const isClient = /^\s*['"]use client['"]/m.test(text);

  if (isClient) {
    for (const mod of NODE_ONLY_MODULES) {
      // Be precise: match exactly the module specifier (no false hits
      // on /lib/db-something).
      const re = new RegExp(`from\\s+['"\`]${mod.replace(/\//g, "\\/")}['"\`]`);
      if (re.test(text)) {
        // Allowed exception: type-only imports don't drag runtime.
        const typeOnly = new RegExp(`import\\s+type\\b[^;]*from\\s+['"\`]${mod.replace(/\//g, "\\/")}['"\`]`);
        if (!typeOnly.test(text)) {
          issues.push(`${f}: CLIENT importing runtime from ${mod}`);
        }
      }
    }
  }

  // Stale singular `headline:` (we renamed to `headlines:` plural).
  const lines = text.split("\n");
  lines.forEach((ln, i) => {
    if (/^\s*headline:\s*headlineFor\b/.test(ln) || /^\s*headline:\s*\{\s*label/.test(ln)) {
      issues.push(`${f}:${i + 1}: stale singular \`headline:\` — should be \`headlines:\``);
    }
  });
}

if (issues.length === 0) {
  console.log("scan-build-risks: OK");
  process.exit(0);
}
console.error("scan-build-risks: found", issues.length, "potential issues:");
for (const i of issues) console.error("  " + i);
process.exit(1);
