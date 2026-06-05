import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { listHealthFacilities } from "@/lib/health-facility";
import FacilitiesClient from "./FacilitiesClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สถานพยาบาลที่ปรึกษาสุขภาพ · IKIGAI OS" };

// /admin/health/facilities — super_admin maintains the company's
// health-consulting clinic(s). The default facility's name/license/address
// is pulled into the employee health portal, the consent card and the
// clinical UI (replacing the old hardcoded "AT HOME CLINIC").
export default function HealthFacilitiesPage() {
  requireSuperAdmin();
  const facilities = listHealthFacilities();
  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สถานพยาบาลที่ปรึกษาสุขภาพของบริษัท</h1>
        <p className="text-sm text-slate-500 mt-1">
          ข้อมูลสถานพยาบาลที่ดูแลโครงการสุขภาพของพนักงาน (ชื่อ · เลขที่ใบอนุญาต · ที่อยู่) —
          ระบบจะดึงข้อมูล<b>สถานพยาบาลหลัก</b>ไปแสดงในพอร์ทัลสุขภาพ ข้อความยินยอม และหน้าแพทย์
        </p>
      </div>
      <FacilitiesClient facilities={facilities} />
    </div>
  );
}
