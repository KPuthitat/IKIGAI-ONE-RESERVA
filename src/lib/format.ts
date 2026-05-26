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
