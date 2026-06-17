// Client-safe Thai month / day labels (Buddhist year) + a month→day
// grouping helper, shared by the request-history views (shift-change, OT,
// …). Pure — no db import. owner 2026-06-17.

const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

/** "2026-06" → "มิถุนายน 2569". */
export function thMonthLabel(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  return `${TH_MONTHS[(m || 1) - 1] ?? mk} ${(y || 0) + 543}`;
}

/** "2026-06-15" → "วันที่ 15". */
export function thDayLabel(d: string): string {
  const dd = d.split("-")[2];
  return dd ? `วันที่ ${Number(dd)}` : d;
}

/** Group already-sorted items into month → day buckets, preserving the
 *  input order (pass newest-first to get newest-first groups). dateOf must
 *  return a 'YYYY-MM-DD…' string. */
export function groupByMonthDay<T>(
  items: T[], dateOf: (x: T) => string | null | undefined
): Array<{ mk: string; days: Array<[string, T[]]> }> {
  const months = new Map<string, Map<string, T[]>>();
  for (const it of items) {
    const d = (dateOf(it) ?? "").slice(0, 10);
    if (!d) continue;
    const mk = d.slice(0, 7);
    if (!months.has(mk)) months.set(mk, new Map());
    const days = months.get(mk)!;
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(it);
  }
  return [...months.entries()].map(([mk, days]) => ({ mk, days: [...days.entries()] }));
}
