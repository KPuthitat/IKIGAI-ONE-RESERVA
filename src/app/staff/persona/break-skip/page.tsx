// /staff/persona/break-skip — พนักงานขอ "ทำงานช่วงพัก" (ไม่พัก) สำหรับวันนี้
// (owner 2026-09-13). ต้องยื่นก่อนถึงเวลาพักของวันนั้น → หัวหน้าอนุมัติ (ย้อนหลังได้).
// เมื่ออนุมัติ เวลาพักจะไม่ถูกหัก และเวลาที่เกิน 8 ชม. จะจ่ายเป็นค่าล่วงเวลา.
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listMyBreakSkips } from "@/lib/break-skip";
import { breakWindowForUserDate } from "@/lib/roster";
import BreakSkipClient from "./BreakSkipClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ขอทำงานช่วงพัก · PERSONA" };

export default function StaffBreakSkipPage() {
  const user = requireUser();
  const db = getDb();
  const rows = listMyBreakSkips(db, user.id);
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const todayBreak = user.activeBranchId
    ? breakWindowForUserDate(user.id, user.activeBranchId, today)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">ขอทำงานช่วงพัก (ไม่พัก)</h1>
        <Link href="/staff/persona" className="text-sm text-brand hover:underline">← ลงเวลา</Link>
      </div>
      <p className="text-sm text-slate-500 -mt-2">
        ถ้าวันนี้ไม่ต้องการพัก กดขอที่นี่ <b>ก่อนถึงเวลาพัก</b> แล้วให้หัวหน้าอนุมัติ เมื่ออนุมัติแล้วเวลาพักจะไม่ถูกหัก
        และเวลาที่ทำให้เกิน 8 ชม./วัน จะจ่ายเป็นค่าล่วงเวลา (OT)
      </p>
      <BreakSkipClient
        rows={rows}
        today={today}
        todayBreak={todayBreak}
        hasActiveBranch={user.activeBranchId != null}
      />
    </div>
  );
}
