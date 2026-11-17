import { NextResponse } from "next/server";
import { z } from "zod";
import { canModule, requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { getCardColor, getLineGroupId, isSalesaBranch, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { buyingMoreShifts, defaultRange, NO_CATEGORY, purchaseTrend, vendorShifts, WINDOW } from "@/lib/purchase-trend";
import { purchaseBuyingMoreFlex } from "@/lib/purchase-trend-card";
import { notifySalesaHod } from "@/lib/salesa-line";

// POST /api/admin/reporta/purchase/notify {bucket, pin} — push a card to the branch's HOD LINE group with ONLY the suppliers bought from more
// relative to sales (owner 2026-11-17). Same permissions as the page (ANALYTICA + ACCOUNTA), PIN-gated like the other REPORTA sends.

export const dynamic = "force-dynamic";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const Body = z.object({ bucket: z.enum(["day", "week", "month"]), pin: z.string(), category: z.string().max(200).optional() });

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) return NextResponse.json({ error: "no_branch", message: "กรุณาเลือกสาขาก่อน" }, { status: 403 });
  if (!canModule(user, "accounta.manage")) return NextResponse.json({ error: "forbidden", message: "ต้องมีสิทธิ์ ACCOUNTA" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { bucket, pin, category } = parsed.data;   // category: undefined = all categories, "" = bills with no category

  const gate = verifyAdminPin(user.id, pin);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.reason === "no_pin" ? 400 : 403 });

  const groupId = getLineGroupId(branchId);
  if (!groupId) return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน (ตั้งที่หน้าตั้งค่า ANALYTICA)" }, { status: 400 });

  const db = getDb();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const { from, to } = defaultRange(bucket, today);
  const items = buyingMoreShifts(vendorShifts(purchaseTrend(db, branchId, from, to, bucket, category), WINDOW[bucket]));
  if (items.length === 0) return NextResponse.json({ error: "no_items", message: "ช่วงนี้ไม่มีผู้ขายที่ซื้อมากขึ้นเมื่อเทียบกับยอดขาย จึงไม่ส่งการ์ด" }, { status: 400 });

  const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const flex = purchaseBuyingMoreFlex(items, {
    branchName: branch?.name ?? `สาขา ${branchId}`, bucket, windowSize: WINDOW[bucket], operator: user.display_name,
    color: getCardColor(branchId) ?? SALESA_DEFAULT_CARD_COLOR, category: category ?? null,
    link: `${PUBLIC_BASE}/admin/reporta/purchase?b=${bucket}${category == null ? "" : `&c=${encodeURIComponent(category === "" ? NO_CATEGORY : category)}`}`
  });
  const res = await notifySalesaHod(groupId, flex);
  if (!res.ok) {
    const msg = res.error === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า NOKHOOK OS platform OA"
      : res.error === "monthly_quota_exceeded" ? "LINE เกินโควตาข้อความรายเดือนแล้ว" : "ส่ง LINE ไม่สำเร็จ";
    return NextResponse.json({ error: res.error ?? "send_failed", message: msg }, { status: 502 });
  }
  return NextResponse.json({ ok: true, sent: items.length });
}
