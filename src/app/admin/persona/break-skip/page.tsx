// /admin/persona/break-skip — หัวหน้า/แอดมิน พิจารณาคำขอทำงานช่วงพัก (owner 2026-09-13).
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listBreakSkipsForReview } from "@/lib/break-skip";
import BreakSkipReviewClient from "./BreakSkipReviewClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "อนุมัติทำงานช่วงพัก · PERSONA" };

export default function AdminBreakSkipPage() {
  const user = requireAdmin();
  const db = getDb();
  const branchIds = user.role === "super_admin" ? null : user.adminBranchIds;
  const rows = listBreakSkipsForReview(db, branchIds, true);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">อนุมัติทำงานช่วงพัก</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          พิจารณาคำขอของพนักงานที่ไม่ต้องการพัก — เมื่ออนุมัติ เวลาพักของวันนั้นจะไม่ถูกหัก และเวลาที่ทำให้เกิน 8 ชม./วัน จะจ่ายเป็นค่าล่วงเวลา (ทั้งประจำและพาร์ทไทม์)
        </p>
      </div>
      <BreakSkipReviewClient rows={rows} />
    </div>
  );
}
