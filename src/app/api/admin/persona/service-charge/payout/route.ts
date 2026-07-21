import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { postSvcToAccounta, removeSvcFromAccounta } from "@/lib/accounta-db";

// PATCH /api/admin/persona/service-charge/payout
//   action: post   — mark the month's SVC "ทำจ่ายแล้ว" + post the payout to
//                     ACCOUNTA (ค่าแรง SVC จ่ายแล้ว + ภาษีหัก ณ ที่จ่าย รอจ่าย). PIN.
//   action: unpost — reverse: remove the ACCOUNTA rows + back to draft. PIN.
//   action: repost — re-run the (idempotent) post to reflect a correction.
//
// Posting mirrors payroll finalize; guarded by userCanViewPayroll since it
// writes salary-like expenses to the books. The branch is the caller's active
// branch — never trusted from the client, so an admin can't post another
// branch's payout.

const Body = z.object({
  action: z.enum(["post", "unpost", "repost"]),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  pin: z.string().optional()
});

function getOrCreateBatch(branchId: number, yearMonth: string): { id: number; status: string } {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id, status FROM svc_payout_batches WHERE branch_id = ? AND year_month = ?"
  ).get(branchId, yearMonth) as { id: number; status: string } | undefined;
  if (existing) return existing;
  const info = db.prepare(
    "INSERT INTO svc_payout_batches (branch_id, year_month, status) VALUES (?, ?, 'draft')"
  ).run(branchId, yearMonth);
  return { id: Number(info.lastInsertRowid), status: "draft" };
}

function requirePin(userId: number, pin: string | undefined): NextResponse | null {
  const pinStr = (pin ?? "").trim();
  if (!pinStr) {
    return NextResponse.json({ error: "pin_required", message: "ต้องใส่ PIN ก่อนทำจ่าย" }, { status: 400 });
  }
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
  const nowIso = new Date().toISOString();

  if (d.action === "post" || d.action === "repost") {
    const batch = getOrCreateBatch(branchId, d.yearMonth);
    if (d.action === "post" && batch.status === "posted") {
      return NextResponse.json({ error: "already_posted" }, { status: 400 });
    }
    if (d.action === "repost" && batch.status !== "posted") {
      return NextResponse.json({ error: "must_be_posted" }, { status: 400 });
    }
    // PIN on the first post (repost is an idempotent re-run of an already-posted
    // batch, like payroll repost_accounta — no PIN).
    if (d.action === "post") {
      const pinErr = requirePin(user.id, d.pin);
      if (pinErr) return pinErr;
    }
    let posted: { staff: number; net: number; wht: number };
    try {
      posted = postSvcToAccounta(batch.id, user.id);
    } catch (e) {
      return NextResponse.json({ error: "post_failed", detail: (e as Error).message }, { status: 500 });
    }
    db.prepare(`
      UPDATE svc_payout_batches
      SET status = 'posted', total_net = ?, total_wht = ?,
          posted_by_user_id = ?, posted_at = COALESCE(posted_at, ?),
          paid_by_user_id = ?, paid_at = COALESCE(paid_at, ?)
      WHERE id = ?
    `).run(posted.net, posted.wht, user.id, nowIso, user.id, nowIso, batch.id);
    return NextResponse.json({ ok: true, accounta: posted });
  }

  if (d.action === "unpost") {
    const batch = db.prepare(
      "SELECT id, status FROM svc_payout_batches WHERE branch_id = ? AND year_month = ?"
    ).get(branchId, d.yearMonth) as { id: number; status: string } | undefined;
    if (!batch || batch.status !== "posted") {
      return NextResponse.json({ error: "must_be_posted" }, { status: 400 });
    }
    const pinErr = requirePin(user.id, d.pin);
    if (pinErr) return pinErr;
    try {
      removeSvcFromAccounta(batch.id);
    } catch (e) {
      return NextResponse.json({ error: "unpost_failed", detail: (e as Error).message }, { status: 500 });
    }
    db.prepare(`
      UPDATE svc_payout_batches
      SET status = 'draft', total_net = 0, total_wht = 0,
          posted_by_user_id = NULL, posted_at = NULL,
          paid_by_user_id = NULL, paid_at = NULL
      WHERE id = ?
    `).run(batch.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid_action" }, { status: 400 });
}
