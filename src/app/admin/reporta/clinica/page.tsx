// /admin/reporta/clinica — import the AT HOME CLINIC HIS exports (owner 2026-09-26).
// Range-based: any window overwrites the same span. The analytics section (the
// clinic view in ANALYTICA) reads what this imports.

import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { clinicaImportedRange } from "@/lib/clinica-db";
import ClinicaImportClient from "./ClinicaImportClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "นำเข้าข้อมูลคลินิก · ANALYTICA" };

export default function ClinicaImportPage() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  const range = branchId ? clinicaImportedRange(branchId) : null;
  const hasData = !!range && (!!range.billsFrom || !!range.visitsFrom);
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <Link href="/admin/reporta" className="text-xs text-slate-400 hover:text-brand">← ANALYTICA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">นำเข้าข้อมูลคลินิก (HIS)</h1>
        <p className="text-sm text-slate-500 mt-1">
          อัปโหลดไฟล์ <b>Invoice Report</b> และ/หรือ <b>OPD Report</b> (.xlsx) จากระบบคลินิก — จะเป็นช่วงวัน/เดือน/ช่วงไหนก็ได้
          ระบบอ่านช่วงวันที่จากไฟล์เอง แล้ว<b>เขียนทับข้อมูลช่วงเดียวกัน</b>ให้อัตโนมัติ (นำเข้าซ้ำได้ไม่ซ้ำซ้อน)
        </p>
      </div>
      <ClinicaImportClient />
      {hasData && (
        <div className="text-[11px] text-slate-400">
          ข้อมูลที่มีอยู่ตอนนี้ · บิล: {range!.billsFrom ?? "—"} ถึง {range!.billsTo ?? "—"} · OPD: {range!.visitsFrom ?? "—"} ถึง {range!.visitsTo ?? "—"}
        </div>
      )}
    </div>
  );
}
