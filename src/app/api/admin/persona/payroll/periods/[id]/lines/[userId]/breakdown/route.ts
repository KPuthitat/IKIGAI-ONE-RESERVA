import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET /api/admin/persona/payroll/periods/[id]/lines/[userId]/breakdown
//
// Per-day breakdown of a single staff's pay-period line. Reads the
// raw time_entries inside [period_start, period_end] and pairs them
// up (in → out) so the admin opening the "แก้ไขเงินเดือน" modal can
// see WHERE the line's regular_minutes / ot_minutes came from.
//
// Pair-up rule (same as lib/payroll-compute.ts pairUp() — but
// simplified for visualisation; we don't need to recalculate the OT
// thresholds, just show the raw clock points alongside the totals
// already stored on payroll_lines):
//   - Walk through entries in chronological order.
//   - Each `in` starts a new pair; the next `out` closes it.
//   - An orphan in (no following out before the next in) is shown
//     with workOut=null so the admin can spot the gap.
//   - An orphan out (no preceding in) is shown with workIn=null.
//
// Output is grouped by calendar date (Asia/Bangkok local day). Days
// with no entries at all are omitted — admin sees only days the
// staff actually had activity.
//
// Auth: any signed-in admin in the same branch context can fetch.
// We don't filter by branch on the entries because legacy rows have
// branch_id NULL and the modal already represents that staff's full
// pay period across branches.

type EntryRow = { id: number; ts: string; type: "in" | "out" };

type DayPair = {
  date: string;          // YYYY-MM-DD (BKK local)
  workIn: string | null;  // HH:MM (BKK local) or null when orphaned out
  workOut: string | null; // HH:MM (BKK local) or null when orphaned in
  durationMinutes: number; // 0 when one side is missing
};

type Period = {
  period_start: string;
  period_end: string;
};

// Asia/Bangkok ISO date (YYYY-MM-DD) for a given UTC ISO timestamp.
function bkkDate(iso: string): string {
  const d = new Date(iso);
  // +07:00 fixed offset — Thailand doesn't observe DST.
  d.setUTCHours(d.getUTCHours() + 7);
  return d.toISOString().slice(0, 10);
}
function bkkHHMM(iso: string): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 7);
  return d.toISOString().slice(11, 16);
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin" && user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || periodId <= 0) {
    return NextResponse.json({ error: "invalid_period_id" }, { status: 400 });
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
  }

  const db = getDb();
  const period = db.prepare(`
    SELECT period_start, period_end FROM payroll_periods WHERE id = ?
  `).get(periodId) as Period | undefined;
  if (!period) {
    return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  }

  // Pull all entries within the period (inclusive on both ends).
  // We expand the end to 23:59:59 BKK so an entry at, say, 21:14 on
  // the last day still falls inside. Stored ts is UTC; the period
  // bounds are date-only strings — comparing lexicographically is
  // safe because ISO sorts correctly.
  const fromIso = `${period.period_start}T00:00:00`;
  const toIso = `${period.period_end}T23:59:59`;
  const entries = db.prepare(`
    SELECT id, ts, type FROM time_entries
    WHERE user_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(userId, fromIso, toIso) as EntryRow[];

  // Pair entries: each "in" looks for the next "out" before the next "in".
  // Output groups by BKK calendar date.
  type Day = {
    date: string;
    pairs: DayPair[];
    totalMinutes: number;
  };
  const days = new Map<string, Day>();
  function ensureDay(date: string): Day {
    let d = days.get(date);
    if (!d) {
      d = { date, pairs: [], totalMinutes: 0 };
      days.set(date, d);
    }
    return d;
  }

  let openIn: EntryRow | null = null;
  for (const e of entries) {
    if (e.type === "in") {
      // If we already had an unmatched "in", flush it as an orphan
      // before starting a new one — admin needs to see both.
      if (openIn) {
        const day = ensureDay(bkkDate(openIn.ts));
        day.pairs.push({
          date: bkkDate(openIn.ts),
          workIn: bkkHHMM(openIn.ts),
          workOut: null,
          durationMinutes: 0
        });
      }
      openIn = e;
    } else {
      // type === "out"
      if (openIn) {
        const minutes = Math.round(
          (new Date(e.ts).getTime() - new Date(openIn.ts).getTime()) / 60000
        );
        const day = ensureDay(bkkDate(openIn.ts));
        day.pairs.push({
          date: bkkDate(openIn.ts),
          workIn: bkkHHMM(openIn.ts),
          workOut: bkkHHMM(e.ts),
          durationMinutes: Math.max(0, minutes)
        });
        day.totalMinutes += Math.max(0, minutes);
        openIn = null;
      } else {
        // Orphan out — clock-out with no clock-in. Surface it under
        // its own day so admin sees the broken pair.
        const day = ensureDay(bkkDate(e.ts));
        day.pairs.push({
          date: bkkDate(e.ts),
          workIn: null,
          workOut: bkkHHMM(e.ts),
          durationMinutes: 0
        });
      }
    }
  }
  // Trailing unmatched "in" (still on shift at period end / forgot
  // to clock out) — flush as orphan too.
  if (openIn) {
    const day = ensureDay(bkkDate(openIn.ts));
    day.pairs.push({
      date: bkkDate(openIn.ts),
      workIn: bkkHHMM(openIn.ts),
      workOut: null,
      durationMinutes: 0
    });
  }

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return NextResponse.json({
    ok: true,
    period_start: period.period_start,
    period_end: period.period_end,
    days: sortedDays
  });
}
