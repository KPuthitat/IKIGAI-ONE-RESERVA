import type { Metadata } from "next";
import Link from "next/link";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDfBranch, listRules, importedSpan, eligibleDoctors } from "@/lib/df-db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · ค่าตอบแทนแพทย์ (Doctor Fee)" };

// Doctor-Fee landing — a program card + separate action buttons, mirroring the
// revshare (GP) landing (owner 2026-09-13). Clinic branch only; payroll access.
export default function DoctorFeePage() {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?")
    .get(branchId) as { name: string } | undefined;

  if (!isDfBranch(branchId)) {
    return (
      <div className="space-y-4">
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
        <div className="card text-sm text-slate-500">
          ค่าตอบแทนแพทย์ (Doctor Fee) เปิดใช้เฉพาะสาขาคลินิก — สาขา <b>{branch?.name ?? `#${branchId}`}</b> ยังไม่ได้เปิดใช้งาน
        </div>
      </div>
    );
  }

  const span = importedSpan(branchId);
  const rules = listRules(branchId);
  const doctors = eligibleDoctors();

  return (
    <div className="space-y-4">
      <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ค่าตอบแทนแพทย์ (Doctor Fee)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · คิดจากยอดค่าตรวจ (HSC) ตามไฟล์ยอดขาย × เรท แล้วแบ่งตามวันที่แพทย์อยู่เวร
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          ใช้ติดตามภายในเท่านั้น · แพทย์ที่นับต้องมีบทบาท “แพทย์” และมีชื่อในตารางเวรของวันนั้น
        </p>
      </div>

      <div className="card space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <div className="font-bold text-slate-800">โปรแกรมค่าตอบแทนแพทย์ (DF)</div>
            <div className="text-[11px] text-slate-400">
              สาขา {branch?.name ?? `#${branchId}`} · {doctors.length} แพทย์ · {rules.length} หัวข้อรายการ
              {span.count > 0 ? ` · ข้อมูล ${span.count} บรรทัด (${span.min} – ${span.max})` : " · ยังไม่ได้นำเข้าข้อมูล"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/admin/persona/doctor-fee/rounds"
            className="rounded-full bg-brand text-white px-3 py-1.5 text-sm font-medium hover:bg-brand-dark">รอบจ่ายรายสัปดาห์</Link>
          <Link href="/admin/persona/doctor-fee/overview"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">ภาพรวม / คำนวณย้อนหลัง</Link>
          <Link href="/admin/persona/doctor-fee/config"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">ตั้งค่าการคำนวณค่าตอบแทนแพทย์</Link>
        </div>
      </div>
    </div>
  );
}
