// /admin/persona/meetings/prep — เตรียมประชุมประจำสัปดาห์ (owner 2026-08-04).
// รวมรายงานผู้จัดการทั้งสัปดาห์ → ปุ่ม "สรุปด้วย AI" → เก็บผลไว้อ่านวันพุธ →
// ปุ่ม "สร้างประชุมจากสรุปนี้" ต่อเข้าระบบประชุมเดิม.
import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listManagerReports } from "@/lib/manager-reports";
import { getLatestPrepSummary, meetingPrepEnabled } from "@/lib/meeting-prep";
import MeetingPrepClient from "./MeetingPrepClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เตรียมประชุม · PERSONA" };

export default function MeetingPrepPage() {
  const user = requireAdmin();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() + 7 * 3600_000 - 6 * 86400_000).toISOString().slice(0, 10);

  const reports = listManagerReports(db, { branchId, from, to: today });
  const latest = getLatestPrepSummary(db, branchId);
  const branchName = branchId == null
    ? "ทั้งบริษัท"
    : ((db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)?.name ?? "สาขา");

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">เตรียมประชุมประจำสัปดาห์</h1>
          <p className="text-sm text-slate-500 mt-1">
            รวมรายงานผู้จัดการทั้งสัปดาห์ให้ AI ช่วยสรุปเป็นวาระประชุม — {branchName}
          </p>
        </div>
        <Link href="/admin/persona/manager-reports"
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 whitespace-nowrap">
          ← รายงานผู้จัดการ
        </Link>
      </div>

      <MeetingPrepClient
        initialFrom={from}
        initialTo={today}
        reports={reports}
        latest={latest ?? null}
        aiEnabled={meetingPrepEnabled()}
      />
    </div>
  );
}
