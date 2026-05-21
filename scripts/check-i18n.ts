// Lint guard: scans src/lib/i18n.ts for duplicate keys inside the same
// dict (th or en) and exits non-zero when any are found. Wired into
// `prebuild` so a stray paste during commit can't silently make it to
// production (where `next build` would catch it at the very end of
// type-check, after burning several minutes of build time on the VPS).
//
// We deliberately use a hand-written scanner rather than `import`ing
// the dict — duplicate keys in an object literal are a tsc-level error
// the very thing we're trying to surface earlier, so the file may not
// even be loadable when we need this script most.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const i18nPath = resolve(here, "..", "src", "lib", "i18n.ts");
const text = readFileSync(i18nPath, "utf8");
const lines = text.split("\n");

// Section boundaries — th starts at the first `  th: {` line, en at
// the next `  en: {`. We treat the file as flat; any "  key": prefix
// on a line counts as a key declaration in the current dict.
let thStart = -1, enStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (thStart < 0 && /^\s+th\s*:\s*\{/.test(lines[i])) thStart = i;
  else if (enStart < 0 && /^\s+en\s*:\s*\{/.test(lines[i])) enStart = i;
}
if (thStart < 0 || enStart < 0) {
  console.error("check-i18n: could not locate th: and en: section starts in i18n.ts");
  process.exit(2);
}

const keyRe = /^\s+"([^"]+)":\s/;
const seen: Record<"th" | "en", Map<string, number>> = {
  th: new Map(),
  en: new Map()
};
const dups: Array<{ section: "th" | "en"; key: string; line: number; prev: number }> = [];

for (let i = 0; i < lines.length; i++) {
  const lineNum = i + 1;
  let section: "th" | "en" | null = null;
  if (i >= enStart) section = "en";
  else if (i >= thStart) section = "th";
  if (!section) continue;
  const m = keyRe.exec(lines[i]);
  if (!m) continue;
  const key = m[1];
  const map = seen[section];
  const prev = map.get(key);
  if (prev != null) dups.push({ section, key, line: lineNum, prev });
  else map.set(key, lineNum);
}

if (dups.length === 0) {
  console.log(`check-i18n: OK — th=${seen.th.size}, en=${seen.en.size} keys, no duplicates`);
  process.exit(0);
}

console.error(`check-i18n: found ${dups.length} duplicate key${dups.length === 1 ? "" : "s"}:`);
for (const d of dups) {
  console.error(`  [${d.section}] "${d.key}" — line ${d.line} duplicates line ${d.prev}`);
}
console.error("\nKeep one definition (usually the later / more-descriptive value) and delete the other.");
process.exit(1);
