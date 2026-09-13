import type { Metadata } from "next";
import Link from "next/link";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDfBranch, importedSpan, eligibleDoctors } from "@/lib/df-db";
import { buildDfMonthRounds } from "@/lib/df-rounds";
import DoctorFeeRoundsClient from "./DoctorFeeRoundsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · รอบจ่ายค่าตอบแทนแพทย์ (รายสัปดาห์)" };

function nowBkk(): { y: number; m: number } {
  const d = new Date(Date.now() + 7 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

export default function DoctorFeeRoundsPage({ searchParams }: { searchParams: { year?: string; month?: string } }) {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/persona/doctor-fee" className="text-sm text-slate-500 hover:text-brand">← ค่าตอบแทนแพทย์</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  if (!isDfBranch(branchId)) {
    return (
      <div className="space-y-4">
        <Link href="/admin/persona/doctor-fee" className="text-sm text-slate-500 hover:text-brand">← ค่าตอบแทนแพทย์</Link>
        <div className="card text-sm text-slate-500">
          รอบจ่ายค่าตอบแทนแพทย์เปิดใช้เฉพาะสาขาคลินิก — สาขา <b>{branch?.name ?? `#${branchId}`}</b> ยังไม่ได้เปิดใช้งาน
        </div>
      </div>
    );
  }

  // Default to the month of the latest imported revenue, else this month.
  const span = importedSpan(branchId);
  const now = nowBkk();
  const anchor = span.max ?? `${now.y}-${String(now.m).padStart(2, "0")}-01`;
  const y = Number(searchParams.year) || Number(anchor.slice(0, 4));
  const m = Number(searchParams.month) || Number(anchor.slice(5, 7));
  // Clamp to a sane range so a hand-edited ?month=13 can't build an empty month.
  const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now.y;
  const month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : now.m;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/persona/doctor-fee" className="text-sm text-slate-500 hover:text-brand">← นำเข้ารายงาน / ตั้งกฎ</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รอบจ่ายค่าตอบแทนแพทย์ · {branch?.name ?? `#${branchId}`}</h1>
        <p className="text-sm text-slate-500 mt-1">
          นำเข้าไฟล์รายงานประจำวัน · ระบบรวมรอบจ่ายรายสัปดาห์ (จันทร์–อาทิตย์) ให้อัตโนมัติ · จ่ายจันทร์ถัดไปแล้วลงบัญชี accounta
        </p>
      </div>
      <DoctorFeeRoundsClient
        key={`${year}-${month}`}
        view={buildDfMonthRounds(branchId, year, month)}
        doctors={eligibleDoctors()}
      />
    </div>
  );
}
