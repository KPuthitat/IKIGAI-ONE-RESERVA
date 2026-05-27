// /admin/ascenda/revenue — daily revenue override page.
//
// Lets admin view + edit/backfill daily revenue per branch. The
// shift_close form is the canonical capture point (staff types in
// each evening) but two cases need this admin route:
//   • staff forgot / skipped → admin types it in retrospectively
//   • POS reconciliation found a different number → admin corrects
// Branch picker via the active session branch. Shows last 60 days
// of the active branch with inline edits.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin, getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listRecentBranchRevenue } from "@/lib/ascenda";
import RevenueClient from "./RevenueClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ยอดขายรายวัน · ASCENDA" };

export default function AscendaRevenuePage() {
  requireAdmin();
  const user = getSessionUser();
  if (!user?.activeBranchId) {
    return (
      <div className="card text-sm text-amber-700">
        เลือกสาขาที่ต้องการดู/แก้ยอดขายก่อน
      </div>
    );
  }
  const db = getDb();
  const branch = db.prepare("SELECT id, name FROM branches WHERE id = ?")
    .get(user.activeBranchId) as { id: number; name: string } | undefined;
  if (!branch) {
    return <div className="card text-sm text-rose-700">ไม่พบสาขา</div>;
  }

  // 60 days of recent revenue rows. Admin can scroll through;
  // older months reachable via the period chip in Phase 4.
  const rows = listRecentBranchRevenue(branch.id, 60);

  // Build the 60 most-recent dates (today backwards) so the editor
  // shows missing days too — not just days that already have a row.
  // Bangkok-local "YYYY-MM-DD" to match the source-of-truth column.
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dates: string[] = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // Index by date for O(1) lookup in the client. Pass plain values
  // not DB rows so we don't ship recorded_by user-ids to the browser.
  const byDate: Record<string, { revenue: number; source: string | null }> = {};
  for (const r of rows) {
    byDate[r.date] = { revenue: r.revenue, source: r.source };
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/ascenda" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ASCENDA
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">
          ยอดขายรายวัน
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500">
          ค่าตั้งต้นมาจากที่พนักงานกรอกตอนปิดร้าน (shift_close) — แอดมินแก้/เติมย้อนหลังได้ที่นี่
        </p>
      </div>

      <RevenueClient
        branchId={branch.id}
        dates={dates}
        byDate={byDate}
      />
    </div>
  );
}
