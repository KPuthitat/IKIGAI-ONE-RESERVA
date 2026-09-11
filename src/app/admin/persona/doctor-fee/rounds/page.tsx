import type { Metadata } from "next";
import Link from "next/link";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDfBranch, importedSpan, eligibleDoctors } from "@/lib/df-db";
import { previewDfRound, listRoundLines, listRounds } from "@/lib/df-rounds";
import DoctorFeeRoundsClient from "./DoctorFeeRoundsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · รอบจ่ายค่าตอบแทนแพทย์ (รายสัปดาห์)" };

export default function DoctorFeeRoundsPage() {
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

  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?")
    .get(branchId) as { name: string } | undefined;

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

  // Land on the week of the latest imported revenue (else this week).
  const span = importedSpan(branchId);
  const anchor = span.max ?? new Date().toISOString().slice(0, 10);
  const preview = previewDfRound(branchId, anchor);
  const lines = preview.round ? listRoundLines(preview.round.id) : [];

  return (
    <div className="space-y-4">
      <Link href="/admin/persona/doctor-fee" className="text-sm text-slate-500 hover:text-brand">← ค่าตอบแทนแพทย์</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รอบจ่ายค่าตอบแทนแพทย์ (รายสัปดาห์)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · ตัดรอบทุกวันจันทร์ (จันทร์–อาทิตย์) · โอนให้หมอแล้วลงบัญชีอัตโนมัติใน accounta
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          ยอดมาจากไฟล์ยอดขายที่อัปโหลดในหน้า “ค่าตอบแทนแพทย์” · ตัดรอบ/โอน ต้องใส่ PIN
        </p>
      </div>
      <DoctorFeeRoundsClient
        initialPreview={preview}
        initialLines={lines}
        initialRounds={listRounds(branchId)}
        initialDoctors={eligibleDoctors()}
      />
    </div>
  );
}
