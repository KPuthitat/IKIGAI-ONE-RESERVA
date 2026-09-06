// /admin/persona/late-excusals — หัวหน้า/แอดมิน พิจารณาอนุโลมการมาสาย (owner 2026-09-05).
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listExcusalsForReview } from "@/lib/late-excusals";
import LateExcusalsReviewClient from "./LateExcusalsReviewClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "อนุโลมการมาสาย · PERSONA" };

export default function AdminLateExcusalsPage() {
  const user = requireAdmin();
  const db = getDb();
  const branchIds = user.role === "super_admin" ? null : user.adminBranchIds;
  const rows = listExcusalsForReview(db, branchIds, true);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">อนุโลมการมาสาย</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          พิจารณาคำขอของพนักงานที่มาสายโดยมีเหตุผลอันสมควร — เมื่ออนุมัติ วันนั้นจะไม่ถูกนับในเกณฑ์การมาสาย 20% ที่มีผลต่อเซอร์วิสชาร์จ (ยังเก็บเป็นสถิติ)
        </p>
      </div>
      <LateExcusalsReviewClient rows={rows} />
    </div>
  );
}
