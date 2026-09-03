import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { postSvcToAccounta, removeSvcFromAccounta } from "@/lib/accounta-db";
import { companySvcPayoutState } from "@/lib/service-charge";

// PATCH /api/admin/persona/service-charge/company/payout — company-wide payout,
// mirroring the per-branch flow but fanned out across every participating branch
// (owner 2026-09-03, like company-wide FT payroll). draft → finalize → paid →
// posted. Finalize is blocked until EVERY branch's month is complete; posting
// reuses the per-branch postSvcToAccounta so each branch's ACCOUNTA rows stay
// attributed to that branch.
//
// The company is the caller's active-branch company — never trusted from client.
// Guarded by userCanViewPayroll; PIN required for finalize / post / unpost.

const Body = z.object({
  action: z.enum(["finalize", "unfinalize", "mark_paid", "unpay", "post", "unpost"]),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  pin: z.string().optional()
});

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
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const db = getDb();
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(user.activeBranchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (!companyId) return NextResponse.json({ error: "no_company" }, { status: 400 });

  const state = companySvcPayoutState(companyId, d.yearMonth);
  if (state.branches.length === 0) {
    return NextResponse.json({ error: "no_svc", message: "ไม่มีสาขาที่มีเซอร์วิสชาร์จในเดือนนี้" }, { status: 400 });
  }
  const now = new Date().toISOString();

  // ── finalize ──────────────────────────────────────────────────────────────
  if (d.action === "finalize") {
    if (state.status !== "draft") return NextResponse.json({ error: "already_finalized", message: "ปิดยอดไปแล้ว" }, { status: 400 });
    if (!state.allComplete) {
      const names = state.incomplete.map((b) => `${b.name} (${b.filled}/${b.days} วัน)`).join(", ");
      return NextResponse.json({
        error: "month_incomplete",
        message: `ยังลงเซอร์วิสชาร์จไม่ครบทั้งเดือนในบางสาขา: ${names} — ต้องครบทุกสาขาก่อนปิดยอด (วันหยุด/ปิดร้าน ลง 0)`
      }, { status: 400 });
    }
    const pinErr = requirePin(user.id, d.pin);
    if (pinErr) return pinErr;
    const upd = db.prepare(`UPDATE svc_payout_batches SET status = 'finalized', finalized_by_user_id = ?, finalized_at = ? WHERE branch_id = ? AND year_month = ?`);
    const ins = db.prepare(`INSERT INTO svc_payout_batches (branch_id, year_month, status, finalized_by_user_id, finalized_at) VALUES (?, ?, 'finalized', ?, ?)`);
    const tx = db.transaction(() => {
      for (const b of state.branches) {
        if (b.status === "draft") {
          const changed = upd.run(user.id, now, b.id, d.yearMonth).changes;
          if (!changed) ins.run(b.id, d.yearMonth, user.id, now);
        }
      }
    });
    tx();
    return NextResponse.json({ ok: true });
  }

  // ── unfinalize ──────────────────────────────────────────────────────────────
  if (d.action === "unfinalize") {
    if (state.status !== "finalized") return NextResponse.json({ error: "must_be_finalized" }, { status: 400 });
    db.transaction(() => {
      for (const b of state.branches) if (b.status === "finalized") {
        db.prepare(`UPDATE svc_payout_batches SET status = 'draft', finalized_by_user_id = NULL, finalized_at = NULL WHERE branch_id = ? AND year_month = ?`).run(b.id, d.yearMonth);
      }
    })();
    return NextResponse.json({ ok: true });
  }

  // ── mark_paid / unpay ───────────────────────────────────────────────────────
  if (d.action === "mark_paid") {
    if (state.status !== "finalized") return NextResponse.json({ error: "must_be_finalized_to_pay", message: "ต้องปิดยอดก่อน" }, { status: 400 });
    db.transaction(() => {
      for (const b of state.branches) if (b.status === "finalized") {
        db.prepare(`UPDATE svc_payout_batches SET status = 'paid', paid_by_user_id = ?, paid_at = ? WHERE branch_id = ? AND year_month = ?`).run(user.id, now, b.id, d.yearMonth);
      }
    })();
    return NextResponse.json({ ok: true });
  }

  if (d.action === "unpay") {
    if (state.status !== "paid") return NextResponse.json({ error: "must_be_paid" }, { status: 400 });
    db.transaction(() => {
      for (const b of state.branches) if (b.status === "paid") {
        db.prepare(`UPDATE svc_payout_batches SET status = 'finalized', paid_by_user_id = NULL, paid_at = NULL WHERE branch_id = ? AND year_month = ?`).run(b.id, d.yearMonth);
      }
    })();
    return NextResponse.json({ ok: true });
  }

  // ── post / unpost to ACCOUNTA (per-branch split reused) ──────────────────────
  if (d.action === "post") {
    if (state.status !== "paid") return NextResponse.json({ error: "must_be_paid_to_post", message: "ต้องทำจ่ายก่อน" }, { status: 400 });
    const pinErr = requirePin(user.id, d.pin);
    if (pinErr) return pinErr;
    let net = 0, wht = 0, staff = 0;
    try {
      const tx = db.transaction(() => {
        for (const b of state.branches) if (b.status === "paid") {
          const batch = db.prepare("SELECT id FROM svc_payout_batches WHERE branch_id = ? AND year_month = ?").get(b.id, d.yearMonth) as { id: number };
          const r = postSvcToAccounta(batch.id, user.id);
          net += r.net; wht += r.wht; staff += r.staff;
          db.prepare(`UPDATE svc_payout_batches SET status = 'posted', total_net = ?, total_wht = ?, posted_by_user_id = ?, posted_at = COALESCE(posted_at, ?) WHERE id = ?`)
            .run(r.net, r.wht, user.id, now, batch.id);
        }
      });
      tx();
    } catch (e) {
      return NextResponse.json({ error: "post_failed", detail: (e as Error).message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, accounta: { staff, net, wht } });
  }

  if (d.action === "unpost") {
    if (state.status !== "posted") return NextResponse.json({ error: "must_be_posted" }, { status: 400 });
    const pinErr = requirePin(user.id, d.pin);
    if (pinErr) return pinErr;
    try {
      const tx = db.transaction(() => {
        for (const b of state.branches) if (b.status === "posted") {
          const batch = db.prepare("SELECT id FROM svc_payout_batches WHERE branch_id = ? AND year_month = ?").get(b.id, d.yearMonth) as { id: number };
          removeSvcFromAccounta(batch.id);
          db.prepare(`UPDATE svc_payout_batches SET status = 'paid', total_net = 0, total_wht = 0, posted_by_user_id = NULL, posted_at = NULL WHERE id = ?`).run(batch.id);
        }
      });
      tx();
    } catch (e) {
      return NextResponse.json({ error: "unpost_failed", detail: (e as Error).message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid_action" }, { status: 400 });
}
