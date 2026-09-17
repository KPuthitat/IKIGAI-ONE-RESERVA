import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isSalesaBranch, getLineGroupId, getMonthlyTarget } from "@/lib/salesa-db";
import ReportaSettingsClient from "./ReportaSettingsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "REPORTA · ตั้งค่ากลุ่ม LINE หัวหน้างาน" };

export default function ReportaSettingsPage() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return (
      <div className="space-y-4">
        <Link href="/admin/reporta" className="text-sm text-slate-500 hover:text-brand">← REPORTA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน</div>
      </div>
    );
  }
  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;

  return (
    <div className="space-y-4 max-w-xl">
      <Link href="/admin/reporta" className="text-sm text-slate-500 hover:text-brand">← REPORTA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ตั้งค่ากลุ่ม LINE หัวหน้างาน</h1>
        <p className="text-sm text-slate-500 mt-1">สาขา {branch?.name ?? `#${branchId}`} · การ์ดสรุปยอดขายรายวัน/รายสัปดาห์จะถูกส่งเข้ากลุ่มนี้</p>
      </div>
      <ReportaSettingsClient initialGroupId={getLineGroupId(branchId)} initialTarget={getMonthlyTarget(branchId)} />
    </div>
  );
}
