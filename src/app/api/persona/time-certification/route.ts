import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { notifyExecGroupTimeCertRequest } from "@/lib/time-cert-notify";
import { createWarning } from "@/lib/discipline";

// POST /api/persona/time-certification
//
// Staff files a certification request. Two shapes:
//
//   A) CORRECTION of an existing punch (outside the 5-min self-fix window):
//      { entry_id, proposed_ts, reason }
//      → on approval the entry's `ts` is UPDATEd to proposed_ts.
//
//   B) MISSING punch — they forgot to clock in/out entirely, so there is
//      no entry to correct (owner 2026-06-08):
//      { kind:'missing', entry_type:'in'|'out', work_date, proposed_ts, reason }
//      → on approval a NEW time_entries row is CREATED at proposed_ts, then
//        the affected draft payroll line is recomputed.
//
// Guards:
//   • Only the requester's own data.
//   • No duplicate pending request for the same entry / same missing day+type.

const CorrectionBody = z.object({
  entry_id: z.number().int().positive(),
  proposed_ts: z.string().datetime(),
  reason: z.string().trim().min(3).max(500)
});
const MissingBody = z.object({
  kind: z.literal("missing"),
  entry_type: z.enum(["in", "out"]),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  proposed_ts: z.string().datetime(),
  reason: z.string().trim().min(3).max(500)
});

function bkkDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const raw = await req.json().catch(() => ({}));
  const db = getDb();
  const nowIso = new Date().toISOString();

  // ── B) Missing punch ────────────────────────────────────────────────
  if (raw && typeof raw === "object" && (raw as { kind?: string }).kind === "missing") {
    const parsed = MissingBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
    }
    const { entry_type, work_date, proposed_ts, reason } = parsed.data;
    // The proposed time must fall on the work_date (Bangkok), so a staff
    // can't certify a punch onto a different day.
    if (bkkDate(proposed_ts) !== work_date) {
      return NextResponse.json({ error: "date_mismatch" }, { status: 400 });
    }
    const startIso = new Date(`${work_date}T00:00:00+07:00`).toISOString();
    const endIso = new Date(`${work_date}T23:59:59+07:00`).toISOString();
    const dayEntries = db.prepare(
      "SELECT type, branch_id FROM time_entries WHERE user_id = ? AND ts >= ? AND ts <= ?"
    ).all(user.id, startIso, endIso) as Array<{ type: "in" | "out"; branch_id: number | null }>;
    // Already has that punch → nothing to add (use a correction instead).
    if (dayEntries.some((e) => e.type === entry_type)) {
      return NextResponse.json({ error: "punch_exists" }, { status: 409 });
    }
    // Require the opposite punch so this is a real partial-day, not a
    // free-floating fabricated entry.
    const opposite = entry_type === "out" ? "in" : "out";
    const oppEntry = dayEntries.find((e) => e.type === opposite);
    if (!oppEntry) {
      return NextResponse.json({ error: "no_opposite_punch" }, { status: 409 });
    }
    const branchId = oppEntry.branch_id ?? user.activeBranchId ?? null;
    // No duplicate pending missing-request for the same day+type.
    const dup = db.prepare(`
      SELECT id FROM time_certifications
      WHERE requested_by = ? AND kind = 'missing' AND work_date = ?
        AND entry_type = ? AND status = 'pending'
    `).get(user.id, work_date, entry_type) as { id: number } | undefined;
    if (dup) {
      return NextResponse.json({ error: "already_pending", existingId: dup.id }, { status: 409 });
    }
    const result = db.prepare(`
      INSERT INTO time_certifications
        (entry_id, requested_by, reason, proposed_ts, original_ts,
         kind, entry_type, work_date, branch_id, status, created_at)
      VALUES (NULL, ?, ?, ?, NULL, 'missing', ?, ?, ?, 'pending', ?)
    `).run(user.id, reason, proposed_ts, entry_type, work_date, branchId, nowIso);
    logPersonaAction(user.id, "time_certification.request_missing", Number(result.lastInsertRowid));
    // Auto-record a (verbal) disciplinary note for the missing punch so HR
    // tracking is automatic (owner 2026-06-14). Quiet — no LINE notify. Wrapped
    // so a discipline-insert failure never blocks the certification itself.
    if (branchId != null) {
      try {
        const th = entry_type === "out" ? "ออก" : "เข้า";
        createWarning({
          branchId,
          userId: user.id,
          issuedByUserId: user.id,
          severity: "verbal",
          title: `ลืมลงเวลา${th}งาน (บันทึกอัตโนมัติ)`,
          body: `ระบบบันทึกอัตโนมัติเมื่อพนักงานยื่นรับรองเวลา${th}งานที่ลืมลงของวันที่ ${work_date}`,
          reasonCategory: "ลงเวลา"
        });
      } catch (e) {
        console.warn("[time-cert] auto-discipline failed", e);
      }
    }
    void notifyExecGroupTimeCertRequest(Number(result.lastInsertRowid))
      .catch((e) => console.warn("[time-cert] exec-group submit notify failed", e));
    return NextResponse.json({ ok: true, id: result.lastInsertRowid });
  }

  // ── A) Correction of an existing entry ───────────────────────────────
  const parsed = CorrectionBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const entry = db.prepare(
    "SELECT id, user_id, ts FROM time_entries WHERE id = ?"
  ).get(parsed.data.entry_id) as { id: number; user_id: number; ts: string } | undefined;
  if (!entry || entry.user_id !== user.id) {
    return NextResponse.json({ error: "entry_not_found" }, { status: 404 });
  }
  const existingPending = db.prepare(`
    SELECT id FROM time_certifications WHERE entry_id = ? AND status = 'pending'
  `).get(entry.id) as { id: number } | undefined;
  if (existingPending) {
    return NextResponse.json({ error: "already_pending", existingId: existingPending.id }, { status: 409 });
  }
  const result = db.prepare(`
    INSERT INTO time_certifications
      (entry_id, requested_by, reason, proposed_ts, original_ts, kind, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'correction', 'pending', ?)
  `).run(entry.id, user.id, parsed.data.reason, parsed.data.proposed_ts, entry.ts, nowIso);
  logPersonaAction(user.id, "time_certification.request", entry.id);
  void notifyExecGroupTimeCertRequest(Number(result.lastInsertRowid))
    .catch((e) => console.warn("[time-cert] exec-group submit notify failed", e));
  return NextResponse.json({ ok: true, id: result.lastInsertRowid });
}
