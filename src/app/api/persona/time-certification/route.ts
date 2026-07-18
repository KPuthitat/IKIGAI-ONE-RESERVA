import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { notifyExecGroupTimeCertRequest, notifyMissingPunchOffence } from "@/lib/time-cert-notify";
import { createWarning, countWarningsByCategory } from "@/lib/discipline";
import { resolveClockBranchId } from "@/lib/roster";
import { recomputeLine } from "@/lib/payroll-compute";

// Send the verbal-warning LINE nudge from this offence onward (owner 2026-06-25;
// same threshold the admin-approve path uses in the decide route).
const MISSING_PUNCH_NUDGE_FROM = 3;

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
    const opposite = entry_type === "out" ? "in" : "out";
    const oppEntry = dayEntries.find((e) => e.type === opposite);

    // ── B1) Forgot clock-IN → self-certify with IMMEDIATE effect ──────
    // A forgotten clock-IN pays nothing on its own — the day only counts once a
    // real, proof-carrying clock-OUT (GPS/selfie/QR) pairs with it. So we let
    // staff self-certify the IN and write it live right away, breaking the
    // "can't clock out without an in, can't certify a zero-punch day" deadlock
    // (owner 2026-07-18). It's recorded as an improper-attendance flag AND an
    // auto verbal warning, so HR still tracks the lapse.
    if (entry_type === "in") {
      // Resolve the branch the SAME way the clock endpoint does, so the punch
      // lands on the branch clock-OUT reads (it filters firstIn by
      // clockBranchId). Prefer the opposite punch's branch when one exists.
      const branchId =
        oppEntry?.branch_id ??
        resolveClockBranchId(user.id, user.activeBranchId ?? null, work_date) ??
        user.activeBranchId ??
        null;
      if (branchId == null) {
        return NextResponse.json({ error: "no_branch" }, { status: 409 });
      }
      let certId = 0;
      const tx = db.transaction(() => {
        // 1) The live punch they forgot to record.
        const res = db.prepare(
          "INSERT INTO time_entries (user_id, type, ts, branch_id, note) VALUES (?, 'in', ?, ?, ?)"
        ).run(user.id, proposed_ts, branchId, "รับรองเวลาเข้าด้วยตนเอง");
        const newEntryId = Number(res.lastInsertRowid);
        // 2) Audit trail (mirror the admin-approve create path).
        db.prepare(`
          INSERT INTO time_entries_audit
            (entry_id, entry_user_id, entry_type, entry_ts, action,
             admin_id, reason, created_at)
          VALUES (?, ?, 'in', ?, 'create', ?, ?, ?)
        `).run(newEntryId, user.id, proposed_ts, user.id,
          `self-cert · เพิ่มเวลาเข้าที่ลืมลง · ${reason}`, nowIso);
        // 3) A self-approved certification record so staff history + admin
        //    oversight show the day was handled (status already 'approved').
        const certRes = db.prepare(`
          INSERT INTO time_certifications
            (entry_id, requested_by, reason, proposed_ts, original_ts,
             kind, entry_type, work_date, branch_id, status,
             decided_by, decided_at, decision_note, created_at)
          VALUES (?, ?, ?, ?, NULL, 'missing', 'in', ?, ?, 'approved', ?, ?, ?, ?)
        `).run(newEntryId, user.id, reason, proposed_ts, work_date, branchId,
          user.id, nowIso, "รับรองด้วยตนเอง (มีผลทันที)", nowIso);
        certId = Number(certRes.lastInsertRowid);
        // 3b) Neutralize any OLDER pending in-cert for the same day (e.g. one
        //     filed under the previous approval-gated flow, before this deploy)
        //     so an admin can't later approve it into a DUPLICATE 'in' punch.
        //     status='approved' filter excludes the row we just inserted.
        db.prepare(`
          UPDATE time_certifications
          SET status = 'approved', decided_by = ?, decided_at = ?,
              decision_note = 'แทนที่ด้วยการรับรองด้วยตนเอง (มีผลทันที)', entry_id = ?
          WHERE requested_by = ? AND kind = 'missing' AND entry_type = 'in'
            AND work_date = ? AND status = 'pending'
        `).run(user.id, nowIso, newEntryId, user.id, work_date);
        // 4) Improper-attendance history flag (INSERT OR IGNORE per the
        //    UNIQUE(user_id, work_date, kind) — never double-flags a day).
        db.prepare(`
          INSERT OR IGNORE INTO attendance_flags
            (user_id, branch_id, work_date, kind, detail, created_at)
          VALUES (?, ?, ?, 'missing_in', ?, ?)
        `).run(user.id, branchId, work_date, "ลืมลงเวลาเข้า — รับรองด้วยตนเอง", nowIso);
      });
      tx();
      logPersonaAction(user.id, "time_certification.self_certify_in", certId);
      // Auto verbal disciplinary note (owner 2026-06-14) — quiet tracking record.
      try {
        createWarning({
          branchId,
          userId: user.id,
          issuedByUserId: user.id,
          severity: "verbal",
          title: "ลืมลงเวลาเข้างาน (บันทึกอัตโนมัติ)",
          body: `ระบบบันทึกอัตโนมัติเมื่อพนักงานรับรองเวลาเข้างานที่ลืมลงของวันที่ ${work_date} (มีผลทันที)`,
          reasonCategory: "ลงเวลา"
        });
      } catch (e) {
        console.warn("[time-cert] auto-discipline failed", e);
      }
      // Refresh any DRAFT payroll line covering that date so the certified
      // punch reaches payroll (mirror the decide route). recomputeLine opens
      // its own transaction, so it runs AFTER the cert tx commits.
      try {
        const periods = db.prepare(`
          SELECT id FROM payroll_periods
          WHERE status = 'draft' AND period_start <= ? AND period_end >= ?
        `).all(work_date, work_date) as Array<{ id: number }>;
        for (const p of periods) {
          try { recomputeLine(db, p.id, user.id); }
          catch { /* line_not_found / not draft — skip */ }
        }
      } catch (e) {
        console.warn("[time-cert] payroll recompute after self-cert failed", e);
      }
      // Offence nudge on the Nth ลงเวลา offence (mirror the decide route).
      try {
        const count = countWarningsByCategory(user.id, "ลงเวลา");
        if (count >= MISSING_PUNCH_NUDGE_FROM) {
          void notifyMissingPunchOffence({
            userId: user.id, entryType: "in", count, workDate: work_date
          }).catch((e) => console.warn("[discipline] offence nudge failed:", e));
        }
      } catch (e) {
        console.warn("[discipline] offence count failed:", e);
      }
      return NextResponse.json({ ok: true, id: certId, immediate: true });
    }

    // ── B2) Forgot clock-OUT → pending admin approval (unchanged) ─────
    // Self-setting your own payable OUT time is the fabrication risk, so it
    // still requires the opposite "in" to anchor it AND admin sign-off.
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
        createWarning({
          branchId,
          userId: user.id,
          issuedByUserId: user.id,
          severity: "verbal",
          title: "ลืมลงเวลาออกงาน (บันทึกอัตโนมัติ)",
          body: `ระบบบันทึกอัตโนมัติเมื่อพนักงานยื่นรับรองเวลาออกงานที่ลืมลงของวันที่ ${work_date}`,
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
