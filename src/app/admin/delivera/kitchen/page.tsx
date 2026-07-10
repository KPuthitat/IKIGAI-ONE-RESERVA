import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDeliveraBranch } from "@/lib/delivera/db";
import KitchenClient from "./KitchenClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "กระดานครัว · DELIVERA" };

export default function DeliveraKitchenPage() {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">ยังไม่ได้เลือกสาขา</div>;
  }
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(user.activeBranchId) as { name: string } | undefined;

  if (!isDeliveraBranch(user.activeBranchId)) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold text-slate-800">DELIVERA</h1>
        <div className="card text-sm text-slate-600">
          สาขา <b>{branch?.name ?? `#${user.activeBranchId}`}</b> ยังไม่ได้เปิดใช้ DELIVERA —
          เปิดใช้งานได้เมื่อพร้อม (LINE channel + SlipOK) แล้วตั้งค่าที่หน้าตั้งค่าสาขา
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">กระดานครัว · DELIVERA</h1>
          <p className="text-sm text-slate-500">สาขา <b>{branch?.name ?? `#${user.activeBranchId}`}</b> · ออเดอร์เดลิเวอรี่แบบเรียลไทม์</p>
        </div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
      </div>
      <KitchenClient />
    </div>
  );
}
