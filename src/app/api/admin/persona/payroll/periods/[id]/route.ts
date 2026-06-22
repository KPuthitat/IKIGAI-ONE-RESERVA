import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { computePayrollPeriod } from "@/lib/payroll-compute";
import { verifyAdminPin } from "@/lib/admin-pin";
import { postPayrollToAccounta, removePayrollFromAccounta } from "@/lib/accounta-db";

// PATCH /api/admin/persona/payroll/periods/[id] — recompute, finalize, mark paid, unpay, update notes
// DELETE /api/admin/persona/payroll/periods/[id] — delete (only if draft)

const PatchBody = z.object({
  action: z.enum(["recompute", "finalize", "unfinalize", "mark_paid", "unpay", "update_notes"]),
  notes: z.string().max(500).optional(),
  pay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),  // backdated paid date
  pin: z.string().optional(),                                    // for finalize + unpay
  reason: z.string().max(500).optional()                         // for unpay
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  const period = db.prepare(`SELECT id, status FROM payroll_periods WHERE id = ?`).get(id) as
    { id: number; status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });

  if (d.action === "recompute") {
    if (period.status !== "draft") {
      return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
    }
    try {
      const r = computePayrollPeriod(db, id);
      db.prepare(`UPDATE payroll_periods SET computed_by = ? WHERE id = ?`).run(user.id, id);
      return NextResponse.json({ ok: true, computed: r.computed });
    } catch (e) {
      return NextResponse.json({ error: "compute_failed", detail: (e as Error).message }, { status: 500 });
    }
  }

  if (d.action === "finalize") {
    if (period.status !== "draft") {
      return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
    }
    // PIN gate — same pattern as unpay.
    const pinStr = (d.pin ?? "").trim();
    if (!pinStr) {
      return NextResponse.json({ error: "pin_required", message: "ต้องใส่ PIN ก่อน finalize" }, { status: 400 });
    }
    const pinCheck = verifyAdminPin(user.id, pinStr);
    if (!pinCheck.ok) {
      return NextResponse.json(
        { error: pinCheck.reason, message: pinCheck.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" },
        { status: 401 }
      );
    }
    db.prepare(`
      UPDATE payroll_periods
      SET status = 'finalized', finalized_by = ?, finalized_at = ?
      WHERE id = ?
    `).run(user.id, new Date().toISOString(), id);
    // Auto-post to ACCOUNTA รายจ่าย: เงินเดือนต่อคน (จ่ายแล้ว) + ภาษีหัก ณ
    // ที่จ่าย และ ประกันสังคม (รอจ่าย). Idempotent by payroll_period_id.
    let posted: { salaries: number; tax: number; sso: number } | null = null;
    try {
      posted = postPayrollToAccounta(id, user.id);
    } catch (e) {
      console.error("[payroll] postPayrollToAccounta failed", e);
    }
    return NextResponse.json({ ok: true, accounta: posted });
  }

  if (d.action === "unfinalize") {
    if (period.status !== "finalized") {
      return NextResponse.json({ error: "must_be_finalized" }, { status: 400 });
    }
    db.prepare(`
      UPDATE payroll_periods
      SET status = 'draft', finalized_by = NULL, finalized_at = NULL
      WHERE id = ?
    `).run(id);
    // Roll back the auto-posted รายจ่าย so a re-finalize starts clean.
    try {
      removePayrollFromAccounta(id);
    } catch (e) {
      console.error("[payroll] removePayrollFromAccounta failed", e);
    }
    return NextResponse.json({ ok: true });
  }

  if (d.action === "mark_paid") {
    // Only finalized periods can be marked paid; once paid, locked unless
    // a superadmin unlocks via PIN.
    if (period.status !== "finalized") {
      return NextResponse.json({ error: "must_be_finalized_to_pay" }, { status: 400 });
    }
    // Allow backdating: admin may specify paid_at to record historical
    // payments. Default = now (UTC ISO).
    const paidAtIso = d.paid_at
      ? new Date(`${d.paid_at}T12:00:00+07:00`).toISOString()
      : new Date().toISOString();
    db.prepare(`
      UPDATE payroll_periods
      SET status = 'paid', paid_by = ?, paid_at = ?
      WHERE id = ?
    `).run(user.id, paidAtIso, id);
    return NextResponse.json({ ok: true });
  }

  if (d.action === "unpay") {
    // Unlock: paid → finalized. Requires the admin's own PIN (users.pin_hash)
    // plus a non-empty reason. The unlock event is logged in
    // payroll_period_unlocks for audit. Same PIN used everywhere — no
    // separate "superadmin PIN".
    if (period.status !== "paid") {
      return NextResponse.json({ error: "must_be_paid_to_unpay" }, { status: 400 });
    }
    const pin = (d.pin ?? "").trim();
    const reason = (d.reason ?? "").trim();
    if (!pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
    if (!reason) return NextResponse.json({ error: "reason_required" }, { status: 400 });

    const unpayPinCheck = verifyAdminPin(user.id, pin);
    if (!unpayPinCheck.ok) {
      return NextResponse.json(
        { error: unpayPinCheck.reason === "no_pin" ? "user_pin_not_set" : "pin_invalid" },
        { status: unpayPinCheck.reason === "no_pin" ? 400 : 401 }
      );
    }

    db.prepare(`
      UPDATE payroll_periods
      SET status = 'finalized', paid_by = NULL, paid_at = NULL
      WHERE id = ?
    `).run(id);
    db.prepare(`
      INSERT INTO payroll_period_unlocks (period_id, unlocked_by, reason)
      VALUES (?, ?, ?)
    `).run(id, user.id, reason);
    return NextResponse.json({ ok: true });
  }

  if (d.action === "update_notes") {
    const fields: string[] = [];
    const vals: Array<string | number> = [];
    if ("notes" in d) { fields.push("notes = ?"); vals.push(d.notes ?? ""); }
    if ("pay_date" in d) { fields.push("pay_date = ?"); vals.push(d.pay_date!); }
    if (fields.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
    vals.push(id);
    db.prepare(`UPDATE payroll_periods SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const period = db.prepare(`SELECT id, status FROM payroll_periods WHERE id = ?`).get(id) as
    { id: number; status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") {
    return NextResponse.json({ error: "must_be_draft_to_delete" }, { status: 400 });
  }

  // Cascade deletes lines automatically due to ON DELETE CASCADE
  db.prepare(`DELETE FROM payroll_periods WHERE id = ?`).run(id);
  return NextResponse.json({ ok: true });
}
