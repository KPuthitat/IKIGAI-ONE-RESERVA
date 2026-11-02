import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { isRevshareBranch, getPartner, IncomePostError, postDailyRoundsToAccounta, postedDailyIncome } from "@/lib/revshare-db";

// Book a partner's daily sales to ACCOUNTA without sending the LINE card (the same posting "ส่งยอดวันนี้" does).
// GET  ?partner=&year=&month=  → where it books to + which days are already booked and for how much
// POST {partner, dates[], pin}  → book those days (PIN-gated like every partner-facing action)

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
  if (!getPartner(partner, g.branchId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const mm = String(month).padStart(2, "0");
  const end = `${year}-${mm}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  return NextResponse.json({ ok: true, ...postedDailyIncome(partner, g.branchId, `${year}-${mm}-01`, end) });
}

const Body = z.object({ partner: z.number().int().positive(), dates: z.array(z.string().regex(ISO)).min(1).max(31), pin: z.string().optional() });

export async function POST(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const status = verifyAdminPin(g.user.id, p.data.pin ?? "");
  if (!status.ok) return NextResponse.json({ error: status.reason }, { status: status.reason === "no_pin" ? 400 : 403 });
  try {
    const posted = postDailyRoundsToAccounta(p.data.partner, g.branchId, p.data.dates, g.user.id);
    return NextResponse.json({ ok: true, posted });
  } catch (e) {
    if (e instanceof IncomePostError) {
      const message = e.code === "no_income_branch" ? "ยังไม่ได้ตั้งสาขาที่รับรายรับของคู่ค้านี้ (ตั้งที่หน้าตั้งค่าคู่ค้า)" : e.code === "day_not_found" ? "ไม่พบยอดของวันที่เลือก" : "ไม่พบคู่ค้า";
      return NextResponse.json({ ok: false, error: e.code, message }, { status: e.code === "not_found" ? 404 : 422 });
    }
    throw e;
  }
}
