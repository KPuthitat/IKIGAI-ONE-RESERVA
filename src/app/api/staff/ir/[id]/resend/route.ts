import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getReport, canReporterEdit } from "@/lib/ir-db";
import { notifyIrRmGroup } from "@/lib/ir-line";

// POST /api/staff/ir/[id]/resend — the reporter pushes their (edited) report
// to the risk-management LINE group again (owner 2026-10-02: "ยังไม่มีปุ่มส่ง
// รายงานซ้ำในการแก้ไขครั้งถัดไป"). Owner-only, open reports only.

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const report = getReport(id, branchId);
  if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canReporterEdit(report, user.id)) {
    return NextResponse.json({ error: "not_owner", message: "ส่งซ้ำได้เฉพาะรายงานของตนเองที่ยังไม่ปิดเคส" }, { status: 403 });
  }
  const r = await notifyIrRmGroup(branchId, id);
  if (!r.ok) {
    const message = r.skipped === "no_group" ? "สาขานี้ยังไม่ได้ตั้งกลุ่ม LINE ของทีมบริหารความเสี่ยง กรุณาแจ้งผู้ดูแลระบบ"
      : r.skipped === "platform_oa_not_configured" ? "ระบบยังไม่ได้เชื่อมต่อบัญชี LINE กรุณาแจ้งผู้ดูแลระบบ"
      : "ส่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
    return NextResponse.json({ error: r.skipped ?? r.error ?? "send_failed", message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
