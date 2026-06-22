import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listOutstandingReceivables, receivablesByEntity, receivablesTotal } from "@/lib/accounta-db";
import ReceivablesClient from "./ReceivablesClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · ลูกหนี้ค้างชำระ" };

// ลูกหนี้ค้างชำระ (owner 2026-06-22): credit sales (e.g. insurer) recognised as
// revenue but not yet collected. Mark "รับชำระแล้ว" when the money arrives →
// it counts as cash on that date.
export default function AccountaReceivablesPage() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  const branch = branchId != null
    ? (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)
    : undefined;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <Link href="/admin/accounta/daybook" className="text-sm text-brand hover:underline">ดูบัญชีรายรับรายจ่าย →</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ลูกหนี้ค้างชำระ</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · ยอดขายเชื่อที่ยังไม่ได้รับเงิน (เช่น บริษัทประกัน) — กด “รับชำระแล้ว” เมื่อเงินเข้า
        </p>
      </div>
      <ReceivablesClient
        initialRows={listOutstandingReceivables(branchId)}
        initialByEntity={receivablesByEntity(branchId)}
        initialTotal={receivablesTotal(branchId)}
      />
    </div>
  );
}
