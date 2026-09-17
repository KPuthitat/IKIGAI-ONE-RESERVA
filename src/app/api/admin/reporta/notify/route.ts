import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { isSalesaBranch, getLineGroupId, markDailySent, markWeeklySent } from "@/lib/salesa-db";
import { dailyAnalytics, weeklyAnalytics } from "@/lib/salesa-analytics";
import { salesaDailyFlex, salesaWeeklyFlex, notifySalesaHod } from "@/lib/salesa-line";

// Push a REPORTA summary to the branch's HOD LINE group. PIN-gated (owner
// 2026-09-16: ตรวจยอดแล้วกด PIN ก่อนส่ง). Kinds: daily (one day) or weekly
// (Mon–Sun, sent the following Monday). Owner 2026-09-16.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  kind: z.enum(["daily", "weekly"]),
  date: z.string().regex(ISO).optional(),
  week: z.string().regex(ISO).optional(),
  pin: z.string()
});

function branchName(branchId: number): string {
  const r = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  return r?.name ?? `สาขา #${branchId}`;
}

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return NextResponse.json({ error: "no_branch" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { kind, date, week, pin } = parsed.data;

  const gate = verifyAdminPin(user.id, pin);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.reason === "no_pin" ? 400 : 403 });

  const groupId = getLineGroupId(branchId);
  if (!groupId) {
    return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน (ตั้งที่หน้าตั้งค่า REPORTA)" }, { status: 400 });
  }
  const meta = { branchName: branchName(branchId), operator: user.display_name };

  let flex;
  if (kind === "daily") {
    if (!date) return NextResponse.json({ error: "date_required" }, { status: 400 });
    const a = dailyAnalytics(branchId, date);
    if (!a) return NextResponse.json({ error: "day_not_found" }, { status: 404 });
    if (a.row.has_sales !== 1) {
      return NextResponse.json({ error: "no_sales", message: "วันนี้ยังไม่ได้นำเข้าไฟล์ยอดขาย (Close up)" }, { status: 400 });
    }
    flex = salesaDailyFlex(a, meta);
  } else {
    if (!week) return NextResponse.json({ error: "week_required" }, { status: 400 });
    const w = weeklyAnalytics(branchId, week);
    if (w.dayCount === 0) return NextResponse.json({ error: "no_days", message: "สัปดาห์นี้ยังไม่มีข้อมูลยอดขาย" }, { status: 400 });
    flex = salesaWeeklyFlex(w, meta);
  }

  const res = await notifySalesaHod(groupId, flex);
  if (!res.ok) {
    const msg = res.error === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า IKIGAI OS platform OA"
      : res.error === "monthly_quota_exceeded" ? "LINE เกินโควตาข้อความรายเดือนแล้ว"
      : "ส่ง LINE ไม่สำเร็จ";
    return NextResponse.json({ error: res.error ?? "send_failed", message: msg }, { status: 502 });
  }

  if (kind === "daily" && date) markDailySent(branchId, date, user.id);
  else if (kind === "weekly" && week) markWeeklySent(branchId, weeklyAnalytics(branchId, week).weekStart, user.id);
  return NextResponse.json({ ok: true });
}
