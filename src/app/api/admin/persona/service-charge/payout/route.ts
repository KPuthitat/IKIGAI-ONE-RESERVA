import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { postSvcToAccounta, removeSvcFromAccounta } from "@/lib/accounta-db";
import { isManualSvcMonth, isSharedSvcMonth } from "@/lib/service-charge";

// PATCH /api/admin/persona/service-charge/payout — 3-step flow mirroring payroll
// (owner 2026-07-21): draft → finalize → paid → posted.
//   finalize     — ปิดยอด (lock the month). PIN.
//   unfinalize   — back to draft.
//   mark_paid    — ทำจ่าย (record the payout was made).
//   unpay        — back to finalized.
//   post         — ลงบัญชี ACCOUNTA (ค่าแรง SVC จ่ายแล้ว + ภาษีหัก ณ ที่จ่าย รอจ่าย). PIN.
//   unpost       — ยกเลิกลงบัญชี (remove the รายจ่าย, back to paid). PIN.
//
// Guarded by userCanViewPayroll since posting writes salary-like expenses. The
// branch is the caller's active branch — never trusted from the client.

const Body = z.object({
  action: z.enum(["finalize", "unfinalize", "mark_paid", "unpay", "post", "unpost"]),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  pin: z.string().optional()
});

function getBatch(branchId: number, yearMonth: string) {
  return getDb().prepare(
    "SELECT id, status, posted_at FROM svc_payout_batches WHERE branch_id = ? AND year_month = ?"
  ).get(branchId, yearMonth) as { id: number; status: string; posted_at: string | null } | undefined;
}

function requirePin(userId: number, pin: string | undefined): NextResponse | null {
  const pinStr = (pin ?? "").trim();
  if (!pinStr) return NextResponse.json({ error: "pin_required", message: "ต้องใส่ PIN ก่อน" }, { status: 400 });
  const check = verifyAdminPin(userId, pinStr);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.reason, message: check.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" },
      { status: 401 }
    );
  }
  return null;
}

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const branchId = user.activeBranchId;
  if (!branchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const db = getDb();
  const now = new Date().toISOString();

  // เดือนที่เปิด "รวมกอง (รวมทั้งบริษัท)" ให้จัดการปิดยอด/จ่าย/ลงบัญชีที่หน้ารวม
  // ที่เดียว — กันทำรายการซ้ำรายสาขา (owner 2026-09-03).
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(branchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (companyId && isSharedSvcMonth(companyId, d.yearMonth)) {
    return NextResponse.json({
      error: "managed_company_wide",
      message: "เดือนนี้รวมกองทั้งบริษัท — ปิดยอด/จ่าย/ลงบัญชีที่หน้ารวมทั้งบริษัท"
    }, { status: 400 });
  }

  // ── Step 1: finalize / unfinalize ──────────────────────────────────────
  if (d.action === "finalize") {
    const batch = getBatch(branchId, d.yearMonth);
    if (batch && batch.status !== "draft") {
      return NextResponse.json({ error: "already_finalized" }, { status: 400 });
    }
    // Don't allow finalize until the month's data is complete (owner 2026-07-21:
    // ไม่อนุญาตให้ finalize จนกว่าจะมีข้อมูลครบทั้งเดือน). For computed months that
    // means every calendar day must have a daily_service_charge entry (enter 0 for
    // closed days). Manual (pre-system) months have no daily ledger — skipped.
    if (!isManualSvcMonth(d.yearMonth)) {
      const [yyyy, mm] = d.yearMonth.split("-").map(Number);
      const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
      const filled = (db.prepare(
        "SELECT COUNT(DISTINCT date) AS c FROM daily_service_charge WHERE branch_id = ? AND date >= ? AND date <= ?"
      ).get(branchId, `${d.yearMonth}-01`, `${d.yearMonth}-31`) as { c: number }).c;
      if (filled < daysInMonth) {
        return NextResponse.json({
          error: "month_incomplete",
          message: `ยังลงข้อมูลเซอร์วิสชาร์จไม่ครบทั้งเดือน (ลงแล้ว ${filled}/${daysInMonth} วัน) — ต้องครบก่อนปิดยอด (วันหยุด/ปิดร้าน ให้ลง 0)`
        }, { status: 400 });
      }
    }
    const pinErr = requirePin(user.id, d.pin);
    if (pinErr) return pinErr;
    if (batch) {
      db.prepare(`UPDATE svc_payout_batches SET status = 'finalized', finalized_by_user_id = ?, finalized_at = ? WHERE id = ?`)
        .run(user.id, now, batch.id);
    } else {
      db.prepare(`INSERT INTO svc_payout_batches (branch_id, year_month, status, finalized_by_user_id, finalized_at) VALUES (?, ?, 'finalized', ?, ?)`)
        .run(branchId, d.yearMonth, user.id, now);
    }
    return NextResponse.json({ ok: true });
  }

  const batch = getBatch(branchId, d.yearMonth);
  if (!batch) return NextResponse.json({ error: "batch_not_found" }, { status: 404 });

  if (d.action === "unfinalize") {
    if (batch.status !== "finalized") return NextResponse.json({ error: "must_be_finalized" }, { status: 400 });
    db.prepare(`UPDATE svc_payout_batches SET status = 'draft', finalized_by_user_id = NULL, finalized_at = NULL WHERE id = ?`).run(batch.id);
    return NextResponse.json({ ok: true });
  }

  // ── Step 2: mark_paid / unpay ──────────────────────────────────────────
  if (d.action === "mark_paid") {
    if (batch.status !== "finalized") return NextResponse.json({ error: "must_be_finalized_to_pay" }, { status: 400 });
    db.prepare(`UPDATE svc_payout_batches SET status = 'paid', paid_by_user_id = ?, paid_at = ? WHERE id = ?`).run(user.id, now, batch.id);
    return NextResponse.json({ ok: true });
  }

  if (d.action === "unpay") {
    if (batch.status !== "paid") return NextResponse.json({ error: "must_be_paid" }, { status: 400 });
    if (batch.posted_at) return NextResponse.json({ error: "must_unpost_first", message: "ต้องยกเลิกลงบัญชีก่อน" }, { status: 400 });
    db.prepare(`UPDATE svc_payout_batches SET status = 'finalized', paid_by_user_id = NULL, paid_at = NULL WHERE id = ?`).run(batch.id);
    return NextResponse.json({ ok: true });
  }

  // ── Step 3: post / unpost to ACCOUNTA ──────────────────────────────────
  if (d.action === "post") {
    if (batch.status !== "paid") return NextResponse.json({ error: "must_be_paid_to_post" }, { status: 400 });
    const pinErr = requirePin(user.id, d.pin);
    if (pinErr) return pinErr;
    let posted: { staff: number; net: number; wht: number; groupInsurance: number };
    try {
      posted = postSvcToAccounta(batch.id, user.id);
    } catch (e) {
      return NextResponse.json({ error: "post_failed", detail: (e as Error).message }, { status: 500 });
    }
    db.prepare(`
      UPDATE svc_payout_batches
      SET status = 'posted', total_net = ?, total_wht = ?,
          posted_by_user_id = ?, posted_at = COALESCE(posted_at, ?)
      WHERE id = ?
    `).run(posted.net, posted.wht, user.id, now, batch.id);
    return NextResponse.json({ ok: true, accounta: posted });
  }

  if (d.action === "unpost") {
    if (batch.status !== "posted") return NextResponse.json({ error: "must_be_posted" }, { status: 400 });
    const pinErr = requirePin(user.id, d.pin);
    if (pinErr) return pinErr;
    try {
      removeSvcFromAccounta(batch.id);
    } catch (e) {
      return NextResponse.json({ error: "unpost_failed", detail: (e as Error).message }, { status: 500 });
    }
    db.prepare(`
      UPDATE svc_payout_batches
      SET status = 'paid', total_net = 0, total_wht = 0, posted_by_user_id = NULL, posted_at = NULL
      WHERE id = ?
    `).run(batch.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid_action" }, { status: 400 });
}
