import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isSalesaBranch } from "@/lib/salesa-db";
import ReportaClient from "./ReportaClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "REPORTA · วิเคราะห์ยอดขายรายวัน" };

export default function ReportaPage() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;

  if (branchId == null || !isSalesaBranch(branchId)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-800">REPORTA · วิเคราะห์ยอดขายรายวัน</h1>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">REPORTA · วิเคราะห์ยอดขายรายวัน</h1>
          <p className="text-sm text-slate-500 mt-1">
            นำเข้าไฟล์ยอดขายจาก POS ทุกวัน · ระบบวิเคราะห์ยอดขาย/เมนูทำรายได้สูงสุด · ส่งการ์ดสรุปเข้ากลุ่ม LINE หัวหน้างาน (รายวัน) และสรุปรายสัปดาห์ทุกวันจันทร์
          </p>
        </div>
        <Link href="/admin/reporta/settings" className="btn-secondary text-sm">⚙️ ตั้งค่ากลุ่ม LINE</Link>
      </div>
      <ReportaClient branchName={branch?.name ?? `#${branchId}`} />
    </div>
  );
}
