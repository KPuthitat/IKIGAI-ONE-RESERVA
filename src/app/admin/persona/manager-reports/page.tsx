// /admin/persona/manager-reports — รายงานผู้จัดการ (owner 2026-08-04).
// ผู้จัดการสาขาส่งรายงานปิดกะ + สถานการณ์ประจำวัน + เรื่องที่อยากยกเข้าประชุม
// ประจำสัปดาห์. รายงานเหล่านี้จะถูกรวมให้ AI สรุปที่หน้า "เตรียมประชุม".
import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listManagerReports, getTodayReportForAuthor } from "@/lib/manager-reports";
import ManagerReportsClient from "./ManagerReportsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รายงานผู้จัดการ · PERSONA" };

export default function ManagerReportsPage() {
  const user = requireAdmin();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;
  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  // 14 วันล่าสุด (พอครอบคลุมรอบสัปดาห์ที่จะสรุป)
  const from = new Date(Date.now() + 7 * 3600_000 - 13 * 86400_000).toISOString().slice(0, 10);

  const reports = listManagerReports(db, { branchId, from, to: todayBkk });
  const todayReport = getTodayReportForAuthor(db, user.id, branchId, todayBkk);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">รายงานผู้จัดการ</h1>
          <p className="text-sm text-slate-500 mt-1">
            ส่งรายงานปิดกะ + สถานการณ์ประจำวัน + เรื่องที่อยากยกเข้าประชุมประจำสัปดาห์
            — ระบบจะรวมให้ AI ช่วยสรุปที่หน้าเตรียมประชุม
          </p>
        </div>
        <Link href="/admin/persona/meetings/prep"
          className="text-xs px-3 py-1.5 rounded border border-brand text-brand font-bold hover:bg-brand/5 whitespace-nowrap">
          🗓 เตรียมประชุม (สรุปด้วย AI) →
        </Link>
      </div>
      <ManagerReportsClient
        reports={reports}
        todayReport={todayReport ?? null}
        currentUserId={user.id}
        today={todayBkk}
      />
    </div>
  );
}
