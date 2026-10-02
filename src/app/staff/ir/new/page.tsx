// /staff/ir/new — file a detailed incident report as the signed-in employee
// (owner 2026-10-01: the person involved writes it themselves).
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { irColleagues } from "@/lib/ir-db";
import NewReportClient from "./NewReportClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "แจ้งเหตุการณ์ · IR" };

export default function StaffIrNewPage() {
  const user = requireUser();
  if (user.activeBranchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/staff/ir" className="text-sm text-slate-500 hover:text-brand">← ความเสี่ยง / IR</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Link href="/staff/ir" className="text-sm text-slate-500 hover:text-brand">← ความเสี่ยง / IR</Link>
      <NewReportClient colleagues={irColleagues()} selfUserId={user.id} />
    </div>
  );
}
