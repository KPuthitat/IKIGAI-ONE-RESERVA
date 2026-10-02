// /staff/ir/[id] — one incident report, as every employee of the branch may read
// it; the reporter can keep editing their own sections until the RM closes it.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getReportDetail, canReporterEdit, irColleagues } from "@/lib/ir-db";
import StaffIrDetailClient from "./StaffIrDetailClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รายละเอียดเหตุการณ์ · IR" };

export default function StaffIrDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { sent?: string } }) {
  const user = requireUser();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/staff/ir" className="text-sm text-slate-500 hover:text-brand">← ความเสี่ยง / IR</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const report = getReportDetail(id, branchId);
  if (!report) notFound();
  const canEdit = canReporterEdit(report, user.id);
  return (
    <div className="space-y-4">
      <Link href="/staff/ir" className="text-sm text-slate-500 hover:text-brand">← ความเสี่ยง / IR</Link>
      {searchParams.sent === "1" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm px-3 py-2">
          ส่งรายงานเรียบร้อยแล้ว ขอบคุณที่แจ้ง ทีมบริหารความเสี่ยงจะทบทวนและแจ้งผลผ่านสถานะของรายงานนี้ ท่านยังแก้ไขเพิ่มเติมได้จนกว่าจะปิดเคส
        </div>
      )}
      <StaffIrDetailClient
        initialReport={report}
        canEdit={canEdit}
        colleagues={canEdit ? irColleagues() : []}
        selfUserId={user.id}
      />
    </div>
  );
}
