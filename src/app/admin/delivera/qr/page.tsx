import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDeliveraBranch } from "@/lib/delivera/db";
import QrSheetClient from "./QrSheetClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QR สั่งอาหารหน้าร้าน · DELIVERA" };

export default function DeliveraQrPage() {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return <div className="card text-sm text-slate-600">ยังไม่ได้เลือกสาขา</div>;
  const branch = getDb().prepare("SELECT name, slug FROM branches WHERE id = ?").get(user.activeBranchId) as { name: string; slug: string | null } | undefined;
  if (!branch || !isDeliveraBranch(user.activeBranchId)) {
    return <div className="card text-sm text-slate-600">สาขานี้ยังไม่ได้เปิด DELIVERA</div>;
  }
  if (!branch.slug) return <div className="card text-sm text-slate-600">สาขานี้ยังไม่มี slug สำหรับสร้างลิงก์</div>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">QR สั่งอาหารหน้าร้าน</h1>
          <p className="text-sm text-slate-500">สาขา <b>{branch.name}</b> · ลูกค้าสแกนแล้วสั่งและจ่ายได้เลย ไม่ต้องล็อกอิน</p>
        </div>
        <Link href="/admin/delivera/kitchen" className="text-sm text-slate-500 hover:text-brand">← กระดานครัว</Link>
      </div>
      <QrSheetClient slug={branch.slug} branchName={branch.name} />
    </div>
  );
}
