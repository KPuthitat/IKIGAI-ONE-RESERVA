import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { confirmMeetingFees } from "@/lib/service-charge";

// POST /api/admin/persona/service-charge/meeting-fee/confirm  {year_month, items:[{user_id, amount}], pin}
//
// Confirm the month's เบี้ยประชุม summary (owner 2026-10-20): the edited list becomes the manual meeting fees
// that show on each person's row, and the attendance-computed fees stop being added on top. Needs the admin
// PIN; refused once any branch of the company has closed/paid/posted the month's payout.

const Body = z.object({
  year_month: z.string().regex(/^\d{4}-\d{2}$/),
  items: z.array(z.object({ user_id: z.number().int().positive(), amount: z.number().min(0).max(9_999_999) })).max(200),
  pin: z.string()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { year_month, items, pin } = parsed.data;

  const pinCheck = verifyAdminPin(user.id, pin.trim());
  if (!pinCheck.ok) return NextResponse.json({ error: pinCheck.reason, message: pinCheck.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง" }, { status: 401 });

  const db = getDb();
  const company = (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(user.activeBranchId) as { company_id: number | null } | undefined)?.company_id;
  if (!company) return NextResponse.json({ error: "no_company" }, { status: 400 });
  const locked = db.prepare(`
    SELECT 1 FROM svc_payout_batches s JOIN branches b ON b.id = s.branch_id
     WHERE b.company_id = ? AND s.year_month = ? AND s.status IN ('finalized','paid','posted') LIMIT 1`).get(company, year_month);
  if (locked) return NextResponse.json({ error: "payout_locked", message: "ปิดยอดเซอร์วิสชาร์จเดือนนี้แล้ว แก้เบี้ยประชุมไม่ได้" }, { status: 409 });
  // every listed person must belong to this company
  const inCo = db.prepare(`SELECT 1 FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = ? AND b.company_id = ? LIMIT 1`);
  for (const i of items) if (i.amount > 0 && !inCo.get(i.user_id, company)) return NextResponse.json({ error: "user_out_of_scope" }, { status: 403 });

  const r = confirmMeetingFees({ yearMonth: year_month, items: items.map((i) => ({ userId: i.user_id, amount: i.amount })), byUserId: user.id });
  logPersonaAction(user.id, "svc.meeting_fee.confirm", 0);
  return NextResponse.json({ ok: true, ...r });
}
