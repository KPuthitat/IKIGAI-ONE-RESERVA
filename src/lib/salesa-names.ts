// SALESA — menu-name matching (owner 2026-09-20).
//
// The POS export keys everything by the item's display name, and a branch may
// rename a dish over time (e.g. "ตับหวาน" → "ตับหวานอัลตราสมูธ"). Without help,
// each spelling is counted as a brand-new item and its sales are split. This
// module provides the pure text heuristics used to SUGGEST that two names might
// be the same dish; the owner always confirms before anything is merged.
//
// Pure + dependency-free so it's cheap to unit-test.

/** Normalize a menu name for comparison: trim, collapse internal whitespace,
 *  drop zero-width marks, and lowercase Latin letters. Thai text is left as-is
 *  (no transliteration) — we only fold noise that shouldn't make two otherwise
 *  identical names look different. */
export function normalizeName(s: string): string {
  return s
    .replace(/[​-‏﻿]/g, "") // zero-width / BOM
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Levenshtein edit distance (character-level, code-unit based). Small strings
 *  only — menu names — so the O(n·m) DP table is fine. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Similarity score in [0,1] for a pair of names, and the reason. Higher = more
 *  likely the same dish. Returns 0 when clearly unrelated. */
export function nameSimilarity(a: string, b: string): { score: number; reason: "exact" | "contains" | "fuzzy" | "none" } {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return { score: 0, reason: "none" };
  if (na === nb) return { score: 1, reason: "exact" };

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;

  // One name is the other plus a qualifier ("...อัลตราสมูธ", "(ใหม่)", " x2").
  // A strong rename signal, but only when the shared stem is substantial
  // (≥ 4 chars) — short common Thai stems like "น้ำ"/"ข้าว" otherwise flag
  // unrelated dishes — and it appears at the START or END (a mid-string
  // coincidence is far less likely to be a rename).
  if (shorter.length >= 4 && (longer.startsWith(shorter) || longer.endsWith(shorter))) {
    // The closer the lengths, the more confident (a long tail = less sure).
    const ratio = shorter.length / longer.length;
    return { score: 0.8 + 0.2 * ratio, reason: "contains" };
  }

  // General fuzzy match — a few typo-level edits on a name of decent length.
  const dist = editDistance(na, nb);
  const sim = 1 - dist / Math.max(na.length, nb.length);
  // Require a real shared stem (same first char) to keep noise down.
  if (sim >= 0.72 && na[0] === nb[0]) return { score: sim, reason: "fuzzy" };
  return { score: 0, reason: "none" };
}

export type MergeCandidate = { a: string; b: string; score: number; reason: "exact" | "contains" | "fuzzy" };

/** From a flat list of distinct names, return the pairs that look like they may
 *  be the same dish, most-confident first. `decided` holds pairs already
 *  resolved (merged OR marked separate) so we never re-suggest them; each entry
 *  is the two normalized names joined by "\u0000" with the smaller first
 *  (see `pairKey`). O(n²) over distinct names — a branch has at most a few
 *  hundred, and this runs on demand. */
export function findMergeCandidates(names: string[], decided: Set<string>, limit = 40): MergeCandidate[] {
  const out: MergeCandidate[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (decided.has(pairKey(a, b))) continue;
      const { score, reason } = nameSimilarity(a, b);
      if (reason === "none" || score <= 0) continue;
      out.push({ a, b, score, reason });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit);
}

/** Stable key for an unordered pair of names (normalized, smaller first), used
 *  both to record "these are NOT the same" decisions and to skip re-suggesting
 *  a pair already merged. */
export function pairKey(a: string, b: string): string {
  const na = normalizeName(a), nb = normalizeName(b);
  return na <= nb ? `${na}\u0000${nb}` : `${nb}\u0000${na}`;
}

/** Display label for a group of names that the owner confirmed are one dish:
 *  join the members with " / " so the report shows every spelling that was
 *  folded together (owner 2026-09-20: "ให้ขึ้นว่า ตับหวาน/ตับหวานอัลตราสมูธ").
 *  Order is stable and range-independent — shortest (usually the base name)
 *  first, then alphabetical — so the same group renders the same label in every
 *  view and period. */
export function groupLabel(members: string[]): string {
  const uniq = [...new Set(members.map((m) => m.trim()).filter(Boolean))];
  uniq.sort((a, b) => (a.length - b.length) || a.localeCompare(b, "th"));
  return uniq.join(" / ");
}
