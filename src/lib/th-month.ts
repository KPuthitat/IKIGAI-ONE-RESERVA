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
  return `${TH_MONTHS[(m || 1) - 1] ?? mk} พ.ศ. ${(y || 0) + 543}`;
}

/** A Date → "3 ตุลาคม พ.ศ. 2569" (owner 2026-10-03: ทั้งระบบเป็น พ.ศ.), with
 *  " 11:54" when `time`. `bangkok` reads the instant in Asia/Bangkok; otherwise
 *  the Date's own local fields (for values built from a local wall-clock string). */
export function thDateBE(d: Date, opts: { time?: boolean; bangkok?: boolean } = {}): string {
  if (isNaN(d.getTime())) return "—";
  const t = opts.bangkok ? new Date(d.getTime() + 7 * 3600_000) : d;
  const day = opts.bangkok ? t.getUTCDate() : t.getDate();
  const mon = opts.bangkok ? t.getUTCMonth() : t.getMonth();
  const year = opts.bangkok ? t.getUTCFullYear() : t.getFullYear();
  const hh = opts.bangkok ? t.getUTCHours() : t.getHours();
  const mi = opts.bangkok ? t.getUTCMinutes() : t.getMinutes();
  const s = `${day} ${TH_MONTHS[mon]} พ.ศ. ${year + 543}`;
  return opts.time ? `${s} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : s;
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
