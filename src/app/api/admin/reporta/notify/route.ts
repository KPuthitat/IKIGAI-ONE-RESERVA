import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { isSalesaBranch, getLineGroupId, markDailySent, markWeeklySent, markMonthlySent, getCardColor, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { dailyAnalytics, weeklyAnalytics, monthlyAnalytics } from "@/lib/salesa-analytics";
import { isClinicaBranch } from "@/lib/clinica-db";
import { clinicaMonth } from "@/lib/clinica-analytics";
import { salesPushPlan } from "@/lib/salesa-push";
import { salesaDailyFlex, salesaWeeklyFlex, salesaMonthlyFlex, salesaPushFlex, clinicaMonthlyFlex, notifySalesaHod } from "@/lib/salesa-line";
import { thMonthLabel } from "@/lib/th-month";

// Push a REPORTA summary to the branch's HOD LINE group. PIN-gated (owner
// 2026-09-16: ตรวจยอดแล้วกด PIN ก่อนส่ง). Kinds: daily (one day), weekly
// (Mon–Sun) or monthly (whole month, sent on the 1st). Owner 2026-09-17.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  kind: z.enum(["daily", "weekly", "monthly", "push", "clinica"]),
  date: z.string().regex(ISO).optional(),
  week: z.string().regex(ISO).optional(),
  year: z.number().int().optional(),
  month: z.number().int().min(1).max(12).optional(),
  days: z.number().int().min(1).max(31).optional(),
  target: z.number().int().min(1).optional(),
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
  const { kind, date, week, year, month, days, target, pin } = parsed.data;

  const gate = verifyAdminPin(user.id, pin);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.reason === "no_pin" ? 400 : 403 });

  const groupId = getLineGroupId(branchId);
  if (!groupId) {
    return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน (ตั้งที่หน้าตั้งค่า ANALYTICA)" }, { status: 400 });
  }
  const meta = { branchName: branchName(branchId), operator: user.display_name, color: getCardColor(branchId) ?? SALESA_DEFAULT_CARD_COLOR };

  let flex;
  if (kind === "daily") {
    if (!date) return NextResponse.json({ error: "date_required" }, { status: 400 });
    const a = dailyAnalytics(branchId, date);
    if (!a) return NextResponse.json({ error: "day_not_found" }, { status: 404 });
    if (a.row.has_sales !== 1) {
      return NextResponse.json({ error: "no_sales", message: "วันนี้ยังไม่ได้นำเข้าไฟล์ยอดขาย (Close up)" }, { status: 400 });
    }
    flex = salesaDailyFlex(a, meta);
  } else if (kind === "weekly") {
    if (!week) return NextResponse.json({ error: "week_required" }, { status: 400 });
    const w = weeklyAnalytics(branchId, week);
    if (w.dayCount === 0) return NextResponse.json({ error: "no_days", message: "สัปดาห์นี้ยังไม่มีข้อมูลยอดขาย" }, { status: 400 });
    flex = salesaWeeklyFlex(w, meta);
  } else if (kind === "monthly") {
    if (!year || !month) return NextResponse.json({ error: "month_required" }, { status: 400 });
    const mo = monthlyAnalytics(branchId, year, month);
    if (mo.dayCount === 0) return NextResponse.json({ error: "no_days", message: "เดือนนี้ยังไม่มีข้อมูลยอดขาย" }, { status: 400 });
    flex = salesaMonthlyFlex(mo, meta);
  } else if (kind === "clinica") {
    if (!year || !month) return NextResponse.json({ error: "month_required" }, { status: 400 });
    if (!isClinicaBranch(branchId)) return NextResponse.json({ error: "not_clinica", message: "สาขานี้ยังไม่มีข้อมูลคลินิก (นำเข้าไฟล์ HIS ก่อน)" }, { status: 400 });
    const cm = clinicaMonth(branchId, year, month);
    if (!cm.hasData) return NextResponse.json({ error: "no_data", message: "เดือนนี้ยังไม่มีข้อมูลคลินิก" }, { status: 400 });
    flex = clinicaMonthlyFlex(cm, meta, thMonthLabel(`${year}-${String(month).padStart(2, "0")}`));
  } else {
    // push: short-horizon sales-push brief for the HOD.
    if (!days || !target) return NextResponse.json({ error: "push_input_required", message: "ระบุจำนวนวันและยอดเป้าหมาย" }, { status: 400 });
    const todayIso = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const plan = salesPushPlan(branchId, target, days, todayIso);
    if (!plan.hasBaseline) return NextResponse.json({ error: "no_baseline", message: "ยังไม่มีข้อมูลยอดขายย้อนหลังพอจะวางแผน — นำเข้าไฟล์ให้ครบก่อน" }, { status: 400 });
    flex = salesaPushFlex(plan, meta);
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
  else if (year && month) {
    // Clinic and restaurant monthly cards are distinct reports for one branch, so
    // the clinic sent-marker gets a "clinica:" prefixed ym key — same table, its
    // own flag (owner 2026-09-26).
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    if (kind === "monthly") markMonthlySent(branchId, ym, user.id);
    else if (kind === "clinica") markMonthlySent(branchId, `clinica:${ym}`, user.id);
  }
  return NextResponse.json({ ok: true });
}
