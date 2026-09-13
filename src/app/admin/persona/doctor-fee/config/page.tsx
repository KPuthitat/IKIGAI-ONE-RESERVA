import type { Metadata } from "next";
import Link from "next/link";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDfBranch, listRules, importedSpan } from "@/lib/df-db";
import DoctorFeeConfigClient from "../DoctorFeeConfigClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · ตั้งค่าการคำนวณค่าตอบแทนแพทย์" };

// Doctor-Fee calculation settings — separated from the landing page
// (owner 2026-09-13). Clinic branch only; payroll access.
export default function DoctorFeeConfigPage() {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/persona/doctor-fee" className="text-sm text-slate-500 hover:text-brand">← กลับ ค่าตอบแทนแพทย์</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?")
    .get(branchId) as { name: string } | undefined;

  if (!isDfBranch(branchId)) {
    return (
      <div className="space-y-4">
        <Link href="/admin/persona/doctor-fee" className="text-sm text-slate-500 hover:text-brand">← กลับ ค่าตอบแทนแพทย์</Link>
        <div className="card text-sm text-slate-500">
          ค่าตอบแทนแพทย์ (Doctor Fee) เปิดใช้เฉพาะสาขาคลินิก — สาขา <b>{branch?.name ?? `#${branchId}`}</b> ยังไม่ได้เปิดใช้งาน
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/admin/persona/doctor-fee" className="text-sm text-slate-500 hover:text-brand">← กลับ ค่าตอบแทนแพทย์</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ตั้งค่าการคำนวณค่าตอบแทนแพทย์</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · นำเข้าไฟล์ยอดขาย และกำหนดว่ารหัสหัตถการใดคิด DF ที่เรทเท่าไร
        </p>
      </div>
      <DoctorFeeConfigClient
        initialRules={listRules(branchId)}
        span={importedSpan(branchId)}
      />
    </div>
  );
}
