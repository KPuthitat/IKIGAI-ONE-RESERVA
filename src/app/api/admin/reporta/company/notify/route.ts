import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { getLineGroupId, getCardColor, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { companyOverview } from "@/lib/salesa-analytics";
import { salesaCompanyFlex, notifySalesaHod } from "@/lib/salesa-line";
import { thMonthLabel } from "@/lib/th-month";

// POST /api/admin/reporta/company/notify — push the company overview (รวมทุกสาขา)
// summary card to the HOD LINE group (owner 2026-09-25). PIN-gated, same as the
// per-branch REPORTA send. Routes to the active branch's configured HOD group
// (both branches share the same group).

export const dynamic = "force-dynamic";

const Body = z.object({
  year: z.number().int().min(2000).max(3000).optional(),
  month: z.number().int().min(1).max(12).optional(),
  pin: z.string()
});

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { pin } = parsed.data;

  const gate = verifyAdminPin(user.id, pin);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.reason === "no_pin" ? 400 : 403 });

  const db = getDb();
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(branchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (companyId == null) return NextResponse.json({ error: "no_company", message: "สาขานี้ยังไม่ได้ผูกกับบริษัท" }, { status: 400 });

  const groupId = getLineGroupId(branchId);
  if (!groupId) {
    return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน (ตั้งที่หน้าตั้งค่า ANALYTICA)" }, { status: 400 });
  }

  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const nowY = Number(today.slice(0, 4)), nowM = Number(today.slice(5, 7));
  const year = parsed.data.year ?? nowY;
  const month = parsed.data.month ?? nowM;

  const branchIds = (db.prepare("SELECT id FROM branches WHERE company_id = ?").all(companyId) as Array<{ id: number }>).map((b) => b.id);
  const ov = companyOverview(branchIds, year, month, today);
  // Don't push an empty card. throughDay is today's day for the current month
  // regardless of imports, so gate on the actual figure, not the window.
  if (ov.branchCount === 0 || ov.total.mtdNett === 0) {
    return NextResponse.json({ error: "no_data", message: "เดือนนี้ยังไม่มีข้อมูลยอดขาย" }, { status: 400 });
  }

  const companyName = (db.prepare("SELECT name_th AS name FROM companies WHERE id = ?").get(companyId) as { name: string } | undefined)?.name ?? "บริษัท";
  const flex = salesaCompanyFlex(ov, {
    companyName,
    monthLabel: thMonthLabel(`${year}-${String(month).padStart(2, "0")}`),
    operator: user.display_name,
    color: getCardColor(branchId) ?? SALESA_DEFAULT_CARD_COLOR
  });

  const res = await notifySalesaHod(groupId, flex);
  if (!res.ok) {
    const msg = res.error === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า IKIGAI OS platform OA"
      : res.error === "monthly_quota_exceeded" ? "LINE เกินโควตาข้อความรายเดือนแล้ว"
      : "ส่ง LINE ไม่สำเร็จ";
    return NextResponse.json({ error: res.error ?? "send_failed", message: msg }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
