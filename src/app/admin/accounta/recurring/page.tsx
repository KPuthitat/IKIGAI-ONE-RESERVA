import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listRecurring, listCategories, listPaymentMethods, listVendors } from "@/lib/accounta-db";
import RecurringClient from "./RecurringClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · รายจ่ายประจำ (อัตโนมัติ)" };

export default function RecurringPage() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน</div>
      </div>
    );
  }

  const branch = getDb().prepare(
    "SELECT b.name AS name, b.company_id AS company_id, c.name_th AS company FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?"
  ).get(branchId) as { name: string; company_id: number | null; company: string | null } | undefined;

  return (
    <div className="space-y-4">
      <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รายจ่ายประจำ (อัตโนมัติ)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · ตั้งครั้งเดียว ระบบลงรายจ่ายให้ทุกเดือนตามวันที่กำหนด จนถึงเดือนสิ้นสุด
        </p>
      </div>
      <RecurringClient
        branchId={branchId}
        companyId={branch?.company_id ?? null}
        branchName={branch?.name ?? `#${branchId}`}
        companyName={branch?.company ?? ""}
        initial={listRecurring(branchId)}
        categories={listCategories().map((c) => ({ code: c.code, name: c.name }))}
        paymentMethods={listPaymentMethods()}
        vendors={listVendors(branchId).map((v) => ({ name: v.name, tax_id: v.tax_id }))}
      />
    </div>
  );
}
