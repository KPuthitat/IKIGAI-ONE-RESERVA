import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getReport } from "@/lib/ir-db";
import ReportDetailClient, { type AssigneeOption } from "./ReportDetailClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IR · รายละเอียดเหตุการณ์" };

export default function IrReportDetail({ params }: { params: { id: string } }) {
  const user = requirePermission("ir.manage");
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/ir/reports" className="text-sm text-slate-500 hover:text-brand">← กลับรายการ</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const report = getReport(id, branchId);
  if (!report) notFound();

  // Assignee options — active staff/admin who could own the corrective action.
  const assignees = getDb().prepare(
    `SELECT id, display_name, title_prefix FROM users
     WHERE role IN ('staff','admin')
       AND status NOT IN ('disabled','resigned')
     ORDER BY display_name`
  ).all() as AssigneeOption[];

  return (
    <div className="space-y-4">
      <Link href="/admin/ir/reports" className="text-sm text-slate-500 hover:text-brand">← กลับรายการ</Link>
      <ReportDetailClient initialReport={report} assignees={assignees} />
    </div>
  );
}
