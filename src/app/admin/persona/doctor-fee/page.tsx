import type { Metadata } from "next";
import Link from "next/link";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  isDfBranch, computeDoctorFees, listRules, importedSpan, eligibleDoctors
} from "@/lib/df-db";
import DoctorFeeClient from "./DoctorFeeClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · ค่าตอบแทนแพทย์ (Doctor Fee)" };

// Month bounds around a YYYY-MM-DD anchor (default = imported max, else today).
function monthBounds(anchor: string): { start: string; end: string } {
  const [y, m] = anchor.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { start, end };
}

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
  const anchor = span.max ?? new Date().toISOString().slice(0, 10);
  const { start, end } = monthBounds(anchor);

  return (
    <div className="space-y-4">
      <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ค่าตอบแทนแพทย์ (Doctor Fee)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · คิดจากยอดค่าตรวจ (HSC) ตามไฟล์ยอดขาย × เรท แล้วแบ่งตามวันที่หมออยู่เวร
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          ใช้ติดตามภายในเท่านั้น · หมอที่นับต้องมีบทบาท “แพทย์” และมีชื่อในตารางเวรของวันนั้น
        </p>
      </div>
      <DoctorFeeClient
        initialStart={start}
        initialEnd={end}
        initialResult={computeDoctorFees(branchId, start, end)}
        initialRules={listRules(branchId)}
        span={span}
        eligibleDoctors={eligibleDoctors()}
      />
    </div>
  );
}
