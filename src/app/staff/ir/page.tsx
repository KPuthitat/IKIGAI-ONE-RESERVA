// /staff/ir — ความเสี่ยง / IR for every employee (owner 2026-10-01): the branch's
// incident reports (everyone may read them), mine highlighted, plus the
// entry points to file a new one and to the writing guide.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listReports, reportIdsTouching } from "@/lib/ir-db";
import StaffIrClient from "./StaffIrClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ความเสี่ยง / IR" };

export default function StaffIrPage() {
  const user = requireUser();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-slate-800">ความเสี่ยง / IR</h1>
        <div className="card text-sm text-slate-500">
          กรุณาเลือกสาขาก่อน แล้วเปิดหน้านี้อีกครั้ง —{" "}
          <Link href="/staff/branch-picker?next=%2Fstaff%2Fir" className="text-brand hover:underline">เลือกสาขา</Link>
        </div>
      </div>
    );
  }
  const reports = listReports({ branchId, status: "all" });
  const mine = [...reportIdsTouching(branchId, user.id)];
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-800">ความเสี่ยง / IR</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            เกิดเหตุ เกือบพลาด หรือข้อร้องเรียน — แจ้งด้วยตัวเองภายใน 24 ชม. เพื่อหาสาเหตุและกันไม่ให้เกิดซ้ำ (ไม่ใช่เพื่อลงโทษ)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/staff/ir/guide" className="btn btn-secondary text-sm">คู่มือการเขียน</Link>
          <Link href="/staff/ir/new" className="btn btn-primary text-sm">+ แจ้งเหตุการณ์</Link>
        </div>
      </div>
      <StaffIrClient reports={reports} mine={mine} />
    </div>
  );
}
