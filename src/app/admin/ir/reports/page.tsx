import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listReports } from "@/lib/ir-db";
import ReportsClient from "./ReportsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IR · รายการเหตุการณ์" };

export default function IrReportsPage() {
  const user = requirePermission("ir.manage");
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/ir" className="text-sm text-slate-500 hover:text-brand">← กลับ IR</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?")
    .get(branchId) as { name: string } | undefined;

  return (
    <div className="space-y-4">
      <Link href="/admin/ir" className="text-sm text-slate-500 hover:text-brand">← กลับแดชบอร์ด IR</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รายการเหตุการณ์</h1>
        <p className="text-sm text-slate-500 mt-1">สาขา <b>{branch?.name ?? `#${branchId}`}</b></p>
      </div>
      <ReportsClient initialReports={listReports({ branchId, status: "all" })} />
    </div>
  );
}
