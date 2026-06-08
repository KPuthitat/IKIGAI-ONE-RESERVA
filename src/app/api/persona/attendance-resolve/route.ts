import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { recomputeLine } from "@/lib/payroll-compute";
import { nameWithPrefix } from "@/lib/name";

// POST /api/persona/attendance-resolve
//
// น้องฮูก asked the staff (at clock-in) whether a big schedule deviation
// was just being late/early or a shift swap. This records their answer:
//   • 'late'  → soft history flag (เข้างานสาย)
//   • 'early' → no-op (มาก่อนเวลา is fine, owner 2026-06-08)
//   • 'swap'  → store the friend's shift as that day's effective window
//               (shift_swap_overrides) so payroll computes against the
//               shift actually worked, + a soft 'swap' history flag, then
//               recompute any draft period covering the day.
//
// Only the requester's own attendance — no admin action here.

const Body = z.object({
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  resolution: z.enum(["late", "early", "swap"]),
  friend_user_id: z.number().int().positive().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { work_date, resolution, friend_user_id } = parsed.data;
  const db = getDb();
  const branchId = user.activeBranchId;
  const nowIso = new Date().toISOString();

  const flag = (kind: "late" | "swap", detail: string) => {
    db.prepare(`
      INSERT OR IGNORE INTO attendance_flags
        (user_id, branch_id, work_date, kind, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, branchId, work_date, kind, detail, nowIso);
  };

  if (resolution === "early") {
    // Came in before the rostered start — nothing to record.
    return NextResponse.json({ ok: true, resolution });
  }

  if (resolution === "late") {
    flag("late", "เข้างานสายกว่ากะตามตารางเวร");
    logPersonaAction(user.id, "attendance.flag_late", null);
    return NextResponse.json({ ok: true, resolution });
  }

  // resolution === "swap"
  if (!friend_user_id) {
    return NextResponse.json({ error: "friend_required" }, { status: 400 });
  }
  // Re-derive the friend's shift for that day from the roster (don't trust
  // the client) — earliest-start work shift at this branch.
  const friend = db.prepare(`
    SELECT u.display_name AS name, u.title_prefix AS prefix,
           s.start_time AS sched_in, s.end_time AS sched_out
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    JOIN users u ON u.id = a.user_id
    WHERE a.user_id = ? AND a.branch_id = ? AND a.assignment_date = ?
      AND s.kind = 'work'
    ORDER BY s.start_time ASC
    LIMIT 1
  `).get(friend_user_id, branchId, work_date) as
    | { name: string; prefix: string | null; sched_in: string; sched_out: string }
    | undefined;
  if (!friend) {
    return NextResponse.json({ error: "friend_no_shift" }, { status: 400 });
  }

  db.prepare(`
    INSERT INTO shift_swap_overrides
      (user_id, branch_id, work_date, sched_in, sched_out, friend_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      sched_in = excluded.sched_in,
      sched_out = excluded.sched_out,
      friend_user_id = excluded.friend_user_id,
      created_at = excluded.created_at
  `).run(user.id, branchId, work_date, friend.sched_in, friend.sched_out, friend_user_id, nowIso);

  flag(
    "swap",
    `สลับกะกับ ${nameWithPrefix(friend.prefix, friend.name)} (กะ ${friend.sched_in}–${friend.sched_out})`
  );
  logPersonaAction(user.id, "attendance.swap", friend_user_id);

  // Reflect immediately in any DRAFT period covering this day — the engine
  // overlays shift_swap_overrides onto the roster on recompute.
  try {
    const periods = db.prepare(`
      SELECT id FROM payroll_periods
      WHERE status = 'draft' AND period_start <= ? AND period_end >= ?
    `).all(work_date, work_date) as Array<{ id: number }>;
    for (const p of periods) {
      try { recomputeLine(db, p.id, user.id); }
      catch { /* line_not_found / not_draft — skip */ }
    }
  } catch (e) {
    console.warn("[attendance-resolve] recompute after swap failed:", e);
  }

  return NextResponse.json({ ok: true, resolution });
}
