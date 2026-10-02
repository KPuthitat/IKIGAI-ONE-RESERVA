import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getReportDetail, updateReporterSections, canReporterEdit } from "@/lib/ir-db";
import { IrReporterPatchBody, toReporterEdit } from "@/lib/ir-schema";

// GET   /api/staff/ir/[id]  — one report (branch-scoped) + whether I may edit it
// PATCH /api/staff/ir/[id]  — the reporter refines their own sections (facts,
//                             RCA, recommendations, people) until the case closes.
//                             Never touches the RM verdict columns.

function ctx() {
  const user = getSessionUser();
  if (!user) return { user: null, branchId: null };
  return { user, branchId: user.activeBranchId ?? null };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, branchId } = ctx();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const report = getReportDetail(id, branchId);
  if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, report, canEdit: canReporterEdit(report, user.id) });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { user, branchId } = ctx();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = IrReporterPatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const result = updateReporterSections(id, branchId, user.id, toReporterEdit(parsed.data));
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "not_owner" ? 403 : 409;
    const message = result.error === "not_owner"
      ? "แก้ไขได้เฉพาะรายงานที่คุณเป็นผู้แจ้ง (รายงานแบบไม่ระบุตัวตนแก้ไขไม่ได้)"
      : result.error === "closed" ? "รายงานนี้ปิดเคสแล้ว แก้ไขไม่ได้ — ถ้ามีข้อมูลเพิ่มเติม แจ้งทีม RM" : undefined;
    return NextResponse.json({ error: result.error, message }, { status });
  }
  return NextResponse.json({ ok: true, report: result.report, canEdit: true });
}
