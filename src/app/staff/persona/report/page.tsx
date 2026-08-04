// /staff/persona/report — ส่งรายงานปิดกะ/สถานการณ์/เข้าประชุม (ฝั่งพนักงาน,
// owner 2026-08-04). "คนที่ปิดกะเป็นคนส่ง" — พนักงานที่อยู่สาขานั้นส่งได้เลย.
// แอดมินรวม+ให้ AI สรุปที่ /admin/persona/meetings/prep.
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { listManagerReports, getTodayReportForAuthor } from "@/lib/manager-reports";
import StaffReportClient from "./StaffReportClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "รายงานปิดกะ · PERSONA" };

export default function StaffReportPage() {
  const user = requireUser();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;
  const today = todayBkk();
  const from = new Date(Date.now() + 7 * 3600_000 - 13 * 86400_000).toISOString().slice(0, 10);

  // เฉพาะรายงานของตัวเอง (พนักงานเห็นของตัวเอง) — 14 วันล่าสุด
  const myReports = branchId == null ? [] : listManagerReports(db, {
    branchId, authorUserId: user.id, from, to: today
  });
  const todayReport = branchId == null ? undefined : getTodayReportForAuthor(db, user.id, branchId, today);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800">รายงานปิดกะ / เข้าประชุม</h1>
        <p className="text-sm text-slate-500 mt-1">
          จบกะแล้วส่งรายงานให้หัวหน้า — สรุปยอด/ปัญหาวันนี้ + เรื่องที่อยากให้ยกเข้าประชุมประจำสัปดาห์
        </p>
      </div>
      {branchId == null ? (
        <div className="card text-sm text-amber-700 bg-amber-50 border-amber-200">
          ยังไม่ได้เลือกสาขา — เลือกสาขาก่อนส่งรายงาน
        </div>
      ) : (
        <StaffReportClient
          myReports={myReports}
          todayReport={todayReport ?? null}
          today={today}
        />
      )}
    </div>
  );
}
