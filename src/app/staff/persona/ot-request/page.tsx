// /staff/persona/ot-request — พนักงานขอค่าล่วงเวลา (OT) ย้อนหลัง (owner 2026-09-26).
// เลือกวันที่ทำงานจริงในรอบเงินเดือนที่ยังไม่ปิด แล้วระบุเวลาที่มาก่อนเวลา (early)
// และ/หรืออยู่เกินเวลา (late) → หัวหน้าอนุมัติ → ระบบจ่ายเป็น OT ให้.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { openPeriodsForUser, eligibleBackdateDays, type BackdateDay } from "@/lib/ot-backdate";
import OtRequestClient from "./OtRequestClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ขอค่าล่วงเวลาย้อนหลัง · PERSONA" };

export default function StaffOtRequestPage() {
  const user = requireUser();
  const db = getDb();
  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const branchId = user.activeBranchId ?? null;

  const employmentType = (db.prepare("SELECT employment_type FROM users WHERE id = ?").get(user.id) as { employment_type: string | null } | undefined)?.employment_type ?? null;

  let days: BackdateDay[] = [];
  if (branchId != null) {
    const byDate = new Map<string, BackdateDay>();
    for (const period of openPeriodsForUser(db, { branchId, employmentType })) {
      for (const d of eligibleBackdateDays(db, { userId: user.id, branchId, period, todayBkk })) {
        if (!byDate.has(d.date)) byDate.set(d.date, d);
      }
    }
    days = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">ขอค่าล่วงเวลา (OT) ย้อนหลัง</h1>
        <Link href="/staff/persona" className="text-sm text-brand hover:underline">← ลงเวลา</Link>
      </div>
      <p className="text-sm text-slate-500 -mt-2">
        เลือกวันที่ทำงานจริงในรอบเงินเดือนที่ยังไม่ปิด แล้วระบุเวลาที่ <b>อยู่เกินเวลา</b> (และ <b>มาก่อนเวลา</b> ถ้ามี)
        จากนั้นให้หัวหน้าอนุมัติ เมื่ออนุมัติแล้วส่วนที่เกิน 8 ชม./วัน จะจ่ายเป็นค่าล่วงเวลา (OT).
        ของวันนี้ให้ขอตอนกดออกงานตามปกติ
      </p>
      <OtRequestClient days={days} hasActiveBranch={branchId != null} />
    </div>
  );
}
