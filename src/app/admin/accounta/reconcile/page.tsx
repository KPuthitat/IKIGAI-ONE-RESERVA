import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { canModule, requireUser } from "@/lib/auth";
import { viewerOf } from "@/lib/purchasing";
import ReconcileClient from "./ReconcileClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · กระทบยอดบัญชีธนาคาร" };

// กระทบยอดรายเดือน (owner 2026-11-26): นำเข้า statement จากธนาคาร → จับคู่กับรายจ่าย/รายรับ/การโอนระหว่างบัญชี → ปิดงวด.
export default function ReconcilePage() {
  const user = requireUser();
  if (user.role !== "super_admin" && !viewerOf(user).isCLevel && !canModule(user, "accounta.manage")) redirect("/admin");
  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">กระทบยอดบัญชีธนาคาร (รายเดือน)</h1>
        <p className="text-sm text-slate-500">นำเข้ารายการจากธนาคาร (ไฟล์ CSV / Excel) ระบบจับคู่กับรายจ่าย รายรับ และการโอนระหว่างบัญชีให้เมื่อมีตัวเลือกเดียวที่ชัดเจน ที่เหลือให้คนตัดสิน แล้วปิดงวดของเดือนนั้น</p>
      </div>
      <ReconcileClient />
    </div>
  );
}
