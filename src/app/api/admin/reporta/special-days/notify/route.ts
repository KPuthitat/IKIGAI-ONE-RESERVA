import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { getLineGroupId, getCardColor, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { upcomingSpecialDaysOutlook, SPECIAL_DAYS_HORIZON_DAYS } from "@/lib/salesa-analytics";
import { salesaSpecialDaysFlex, notifySalesaHod } from "@/lib/salesa-line";

// POST /api/admin/reporta/special-days/notify — push the upcoming special-days
// outlook (วันสำคัญที่กำลังจะมาถึง — เตรียมรับมือ) to the HOD LINE group (owner
// 2026-09-29). PIN-gated, company-scoped, same plumbing as the company overview send.

export const dynamic = "force-dynamic";

const HORIZON_DAYS = SPECIAL_DAYS_HORIZON_DAYS;
const Body = z.object({ pin: z.string() });

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });

  const gate = verifyAdminPin(user.id, parsed.data.pin);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.reason === "no_pin" ? 400 : 403 });

  const db = getDb();
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(branchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (companyId == null) return NextResponse.json({ error: "no_company", message: "สาขานี้ยังไม่ได้ผูกกับบริษัท" }, { status: 400 });

  const groupId = getLineGroupId(branchId);
  if (!groupId) {
    return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน (ตั้งที่หน้าตั้งค่า ANALYTICA)" }, { status: 400 });
  }

  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const branchIds = (db.prepare("SELECT id FROM branches WHERE company_id = ?").all(companyId) as Array<{ id: number }>).map((b) => b.id);
  const outlook = upcomingSpecialDaysOutlook(branchIds, today, HORIZON_DAYS);
  if (outlook.days.length === 0) {
    return NextResponse.json({ error: "no_data", message: `ไม่มีวันสำคัญใน ${HORIZON_DAYS} วันข้างหน้า` }, { status: 400 });
  }

  const flex = salesaSpecialDaysFlex(outlook, {
    color: getCardColor(branchId) ?? SALESA_DEFAULT_CARD_COLOR,
    operator: user.display_name,
    horizonDays: HORIZON_DAYS
  });

  const res = await notifySalesaHod(groupId, flex);
  if (!res.ok) {
    const msg = res.error === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า NOKHOOK OS platform OA"
      : res.error === "monthly_quota_exceeded" ? "LINE เกินโควตาข้อความรายเดือนแล้ว"
      : "ส่ง LINE ไม่สำเร็จ";
    return NextResponse.json({ error: res.error ?? "send_failed", message: msg }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
