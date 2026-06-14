import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { recomputeLine } from "@/lib/payroll-compute";

const Body = z.object({ reason: z.string().max(200).optional() });
const PatchBody = z.object({
  ts: z.string().datetime(),
  reason: z.string().max(200).optional()
});

type Entry = { id: number; user_id: number; type: "in" | "out"; ts: string; branch_id: number | null };

// Refresh DRAFT payroll periods covering a Bangkok date for a user so a
// punch edit reaches payroll immediately (recomputeLine upserts the line).
function refreshPayrollForDate(db: ReturnType<typeof getDb>, userId: number, iso: string) {
  try {
    const dateBkk = new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    const periods = db.prepare(
      "SELECT id FROM payroll_periods WHERE status = 'draft' AND period_start <= ? AND period_end >= ?"
    ).all(dateBkk, dateBkk) as Array<{ id: number }>;
    for (const p of periods) {
      try { recomputeLine(db, p.id, userId); } catch { /* skip */ }
    }
  } catch (e) {
    console.warn("[timesheets] payroll recompute after edit failed:", e);
  }
}

// PATCH /api/admin/persona/timesheets/[id] — edit a punch's timestamp.
// Body: { ts (ISO instant), reason? }. Audited ('edit') + branch-guarded;
// refreshes draft payroll for both the old and new date.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  const db = getDb();
  const entry = db.prepare(
    "SELECT id, user_id, type, ts, branch_id FROM time_entries WHERE id = ?"
  ).get(id) as Entry | undefined;
  if (!entry) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (entry.branch_id != null && !userHasBranch(user, entry.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const newTs = parsed.data.ts;
  const oldTs = entry.ts;
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    // Audit the PRE-edit value so the original time is recoverable.
    db.prepare(`
      INSERT INTO time_entries_audit
        (entry_id, entry_user_id, entry_type, entry_ts, action, admin_id, reason, created_at)
      VALUES (?, ?, ?, ?, 'edit', ?, ?, ?)
    `).run(entry.id, entry.user_id, entry.type, oldTs, user.id,
      parsed.data.reason ?? "แอดมินแก้ไขเวลาจากหน้าบันทึกเวลา", nowIso);
    db.prepare("UPDATE time_entries SET ts = ? WHERE id = ?").run(newTs, id);
  })();

  // Old + new date may differ (rare cross-midnight edit) — refresh both.
  refreshPayrollForDate(db, entry.user_id, oldTs);
  if (newTs.slice(0, 10) !== oldTs.slice(0, 10)) refreshPayrollForDate(db, entry.user_id, newTs);

  logPersonaAction(user.id, "timesheet.edit_punch", id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const entry = db.prepare(
    "SELECT id, user_id, type, ts, branch_id FROM time_entries WHERE id = ?"
  ).get(id) as Entry | undefined;

  if (!entry) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Branch guard (Phase 2): admin can only delete entries from
  // branches they're assigned to. Legacy rows with NULL branch_id
  // (pre-migration backfill couldn't determine branch) are still
  // reachable so admin can clean them up. New entries always have
  // branch_id, so this won't be a long-term loophole.
  if (entry.branch_id != null && !userHasBranch(user, entry.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  // snapshot → audit ก่อนลบ (idempotent transaction)
  // ใช้ ISO format สำหรับ created_at เช่นกัน (consistent กับ time_entries.ts)
  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO time_entries_audit
        (entry_id, entry_user_id, entry_type, entry_ts, action, admin_id, reason, created_at)
      VALUES (?, ?, ?, ?, 'delete', ?, ?, ?)
    `).run(entry.id, entry.user_id, entry.type, entry.ts, user.id, parsed.data.reason ?? null, nowIso);
    db.prepare("DELETE FROM time_entries WHERE id = ?").run(id);
  });
  tx();

  return NextResponse.json({ ok: true });
}
