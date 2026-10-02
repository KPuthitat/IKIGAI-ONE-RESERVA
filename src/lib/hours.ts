// Per-branch operating hours — client-safe helpers (owner 2026-09-27). Pins the
// peak-hours charts (restaurant + clinic) to the branch's real เวลาทำการ so a
// wide licensed window (e.g. clinic 09:00–21:00) reads consistently — WITHOUT
// hiding any bill: the axis always covers the operating window AND any hour that
// actually has data. Pure; no db import so it is safe in client components.

export type HoursWindow = {
  open: string; close: string;              // "HH:MM"
  breakStart: string | null; breakEnd: string | null;
  breakWeekdayOnly: boolean;
  breakDays?: number[];                     // exact weekdays the break applies on (0=Sun); absent = legacy flag only
};

const hourOf = (t: string) => Number(t.slice(0, 2));

function bounds(h: HoursWindow): { start: number; end: number; isBreak: (hour: number) => boolean } | null {
  const start = hourOf(h.open), end = hourOf(h.close);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const bs = h.breakStart ? hourOf(h.breakStart) : null;
  const be = h.breakEnd ? hourOf(h.breakEnd) : null;
  // The monthly chart aggregates weekdays + weekends, so a break that skips any
  // day is NOT visually muted (those days are open) — it's noted in the caption
  // instead. Only an every-day break dims its columns.
  const everyDay = h.breakDays ? h.breakDays.length === 7 : !h.breakWeekdayOnly;
  const mute = bs != null && be != null && everyDay;
  const isBreak = (hour: number) => mute && hour >= bs! && hour < be!;
  return { start, end, isBreak };
}

/** The contiguous hour columns to render and a break predicate. The span covers
 *  the operating window (when set) UNION the hours that carry data, so pinning
 *  never drops a bill recorded outside hours. Returns null when there is nothing
 *  to show (no window and no data). */
export function hourSpan(h: HoursWindow | null | undefined, dataMin: number | null, dataMax: number | null): { hours: number[]; isBreak: (hour: number) => boolean } | null {
  const b = h ? bounds(h) : null;
  let lo: number | null = null, hi: number | null = null;
  if (dataMin != null && dataMax != null) { lo = dataMin; hi = dataMax; }
  if (b) { lo = lo == null ? b.start : Math.min(lo, b.start); hi = hi == null ? b.end : Math.max(hi, b.end); }
  if (lo == null || hi == null) return null;
  const hours: number[] = [];
  for (let x = lo; x <= hi; x++) hours.push(x);
  return { hours, isBreak: b ? b.isBreak : () => false };
}

const DAY_ABBR = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** Short "09:00–21:00 · พัก 14:00–16:00 (จ–ศ)" caption. A break on some other
 *  subset of days lists them ("(จ,อ,พ,พฤ,ศ,ส)"); an every-day break has no suffix. */
export function hoursLabel(h: HoursWindow | null | undefined): string | null {
  if (!h) return null;
  let s = `${h.open}–${h.close}`;
  if (h.breakStart && h.breakEnd) {
    const suffix = h.breakWeekdayOnly ? " (จ–ศ)"
      : h.breakDays && h.breakDays.length > 0 && h.breakDays.length < 7 ? ` (${[1, 2, 3, 4, 5, 6, 0].filter((d) => h.breakDays!.includes(d)).map((d) => DAY_ABBR[d]).join(",")})`
      : "";
    s += ` · พัก ${h.breakStart}–${h.breakEnd}${suffix}`;
  }
  return s;
}
