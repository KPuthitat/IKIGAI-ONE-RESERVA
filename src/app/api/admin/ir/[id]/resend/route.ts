import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getReport } from "@/lib/ir-db";
import { notifyIrRmGroup } from "@/lib/ir-line";

// POST /api/admin/ir/[id]/resend — push a report to the risk-management LINE
// group again (owner 2026-10-02). Gate: ir.manage.

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("ir.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!getReport(id, branchId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await notifyIrRmGroup(branchId, id);
  if (!r.ok) {
    const message = r.skipped === "no_group" ? "ยังไม่ได้ตั้งกลุ่ม LINE ของทีมบริหารความเสี่ยง (ตั้งที่แดชบอร์ด IR)"
      : r.skipped === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่าบัญชี LINE ของระบบ"
      : `LINE ปฏิเสธการส่ง (${r.error ?? "unknown"})`;
    return NextResponse.json({ error: r.skipped ?? r.error ?? "send_failed", message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
