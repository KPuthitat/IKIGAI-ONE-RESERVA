import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listCashAccounts } from "@/lib/accounta-db";
import CashAccountsClient from "./CashAccountsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · เงินสด/บัญชีธนาคาร" };

// เงินสด/บัญชีธนาคารที่ติดตาม (owner 2026-06-22). Balances are manual snapshots
// (we don't tag each transaction to an account) — the owner records the ยอดคงเหลือ
// + วันที่ของยอด, and the dashboard shows the total เงินคงเหลือ.
export default function CashAccountsPage() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  const branch = branchId != null
    ? (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)
    : undefined;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <Link href="/admin/accounta/daybook" className="text-sm text-brand hover:underline">ไปหน้าภาพรวมบัญชี →</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ช่องทางการเงิน / บัญชี</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · เงินสด · บัญชีธนาคาร · บัตรเครดิตกรรมการ — ตั้งค่าครั้งเดียว ใช้เป็นช่องทางรับ/จ่ายเงิน
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          ช่องทางที่ติ๊ก “ใช้จ่ายเงิน” จะมาเป็นตัวเลือกวิธีจ่ายตอนบันทึกรายจ่าย · ยอดคงเหลือเป็นการบันทึกเอง (snapshot) ·
          บัตรเครดิตเก็บเฉพาะ 4 ตัวท้าย ไม่เก็บเลขบัตรเต็ม · ช่องทาง “ทั้งบริษัท” เห็นในทุกสาขา
        </p>
      </div>
      <CashAccountsClient initialAccounts={listCashAccounts(branchId, true)} branchName={branch?.name ?? `#${branchId}`} />
    </div>
  );
}
