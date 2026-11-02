import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { isRevshareBranch, listWeekTransfers, postWeekTransferExpense, TransferPostError } from "@/lib/revshare-db";

// Book a weekly transfer to a revenue-share partner as an ACCOUNTA expense (ส่วนแบ่งจ่ายพันธมิตร). The partner's
// sales themselves are NOT booked here — they are already in the shop's daily shift-close revenue.
// GET  ?partner=&year=&month=  → each week's amount to book + whether it is already booked (and for how much)
// POST {partner, year, month, week_start, date, pin}  → book it (PIN-gated, like every partner-facing action)

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function gate() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) return { error: NextResponse.json({ error: "not_revshare_branch" }, { status: 403 }) } as const;
  return { user, branchId } as const;
}

export async function GET(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const q = new URL(req.url).searchParams;
  const partner = Number(q.get("partner")), year = Number(q.get("year")), month = Number(q.get("month"));
  if (!partner || !year || !month || month < 1 || month > 12) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  const weeks = listWeekTransfers(partner, g.branchId, year, month);
  if (!weeks) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, weeks });
}

const Body = z.object({
  partner: z.number().int().positive(), year: z.number().int(), month: z.number().int().min(1).max(12),
  week_start: z.string().regex(ISO), date: z.string().regex(ISO), pin: z.string().optional()
});

export async function POST(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const status = verifyAdminPin(g.user.id, p.data.pin ?? "");
  if (!status.ok) return NextResponse.json({ error: status.reason }, { status: status.reason === "no_pin" ? 400 : 403 });
  try {
    const r = postWeekTransferExpense(p.data.partner, g.branchId, p.data.year, p.data.month, p.data.week_start, p.data.date, g.user.id);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof TransferPostError) {
      return NextResponse.json({ ok: false, error: e.code, message: e.code === "week_not_found" ? "ไม่พบสัปดาห์ที่เลือก" : "ไม่พบคู่ค้า" }, { status: e.code === "not_found" ? 404 : 422 });
    }
    throw e;
  }
}
