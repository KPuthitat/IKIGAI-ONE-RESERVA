// Shared display formatters. Centralised so every place that quotes
// a money value uses the SAME shape — Thai baht convention is
// 2 decimal places (1,234.50), and historically each surface
// (payslip vs summary vs PeriodDetail) duplicated the same
// Intl call, which drifted: some had 0dp, some had 2dp, some used
// `toFixed(0)`. Consolidating here means one diff fixes the lot.
//
// 2026-05: extracted from three duplicate fmtMoney() defs in
// /admin/persona/payroll/{[id]/PeriodDetailClient,summary/page,
// [id]/payslip/[userId]/page}.tsx — same impl in all three, now
// imported instead.

/**
 * Format a number as Thai baht with exactly 2 decimal places +
 * thousand separators. Locale `undefined` lets the browser pick the
 * user's locale separator (','. or '.') — matches what the three
 * pre-existing fmtMoney copies did, so this is a refactor without
 * behavioural change.
 *
 *   fmtMoney(1234)        // "1,234.00"
 *   fmtMoney(1234.5)      // "1,234.50"
 *   fmtMoney(1234.567)    // "1,234.57"  (rounded)
 *   fmtMoney(-50)         // "-50.00"
 *
 * Callers add the "บาท" / "THB" suffix themselves when needed.
 */
export function fmtMoney(v: number): string {
  return v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/**
 * Group an in-progress money string with thousand separators WHILE the user
 * types (keeps up to 2 decimals): "1234.5" → "1,234.5". Pair with a text input
 * (type="number" can't show commas). parseMoney() reverses it for the API.
 * (Shared so every money input shows separators — owner 2026-06-30.)
 */
export function grpMoney(s: string): string {
  const cleaned = (s ?? "").replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  const intPart = (dot >= 0 ? cleaned.slice(0, dot) : cleaned).replace(/^0+(?=\d)/, "");
  const dec = dot >= 0 ? cleaned.slice(dot + 1).replace(/\./g, "").slice(0, 2) : null;
  const grouped = intPart === "" ? "" : Number(intPart).toLocaleString("en-US");
  return dec !== null ? `${grouped === "" ? "0" : grouped}.${dec}` : grouped;
}

/** Reverse grpMoney() — strip separators back to a number (NaN-safe → caller checks). */
export function parseMoney(s: string): number {
  return Number((s ?? "").replace(/,/g, ""));
}
