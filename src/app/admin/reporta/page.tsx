import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isSalesaBranch, getCardColor, SALESA_DEFAULT_CARD_COLOR } from "@/lib/salesa-db";
import { isDfBranch } from "@/lib/df-db";
import { clinicaImportedRange } from "@/lib/clinica-db";
import ReportaClient from "./ReportaClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ANALYTICA · วิเคราะห์ยอดขายรายวัน" };

export default function ReportaPage() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;

  if (branchId == null || !isSalesaBranch(branchId)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-800">ANALYTICA · วิเคราะห์ยอดขายรายวัน</h1>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }
  // A clinic branch (df_enabled = 1, e.g. AT HOME CLINIC) imports from the APSX
  // HIS, not a restaurant POS — the page label and the import box switch on this
  // (owner 2026-09-26).
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const isClinic = isDfBranch(branchId);
  const clinicaRange = isClinic ? clinicaImportedRange(branchId) : null;
  const cardColor = getCardColor(branchId) ?? SALESA_DEFAULT_CARD_COLOR;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ANALYTICA · {isClinic ? "วิเคราะห์คลินิก" : "วิเคราะห์ยอดขายรายวัน"}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {isClinic
              ? "นำเข้าไฟล์จาก APSX (HIS) — Invoice / OPD Report · ระบบวิเคราะห์ยอดบิล เงินเข้าจริง/รอเบิก และส่งสรุปเข้ากลุ่ม LINE ผู้บริหาร"
              : "นำเข้าไฟล์ยอดขายจาก POS ทุกวัน · ระบบวิเคราะห์ยอดขาย/เมนูทำรายได้สูงสุด · ส่งการ์ดสรุปเข้ากลุ่ม LINE หัวหน้างาน (รายวัน) และสรุปรายสัปดาห์ทุกวันจันทร์"}
          </p>
        </div>
        <Link href="/admin/reporta/settings" className="btn-secondary text-sm">⚙️ ตั้งค่ากลุ่ม LINE</Link>
      </div>
      <ReportaClient branchName={branch?.name ?? `#${branchId}`} operatorName={user.display_name} defaultColor={cardColor} isClinic={isClinic} clinicaRange={clinicaRange} />
    </div>
  );
}
