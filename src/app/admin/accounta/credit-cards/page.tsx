import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { listCashAccounts, creditCardReserve, type CardReserve } from "@/lib/accounta-db";
import CreditCardsClient from "./CreditCardsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · บัตรเครดิตกรรมการ" };

function bkkMonth(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
}

export default function CreditCardsPage() {
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

  const cards = listCashAccounts(branchId)
    .filter((a) => a.type === "credit_card")
    .map((a) => ({ id: a.id, name: a.name, bank_label: a.bank_label, last4: a.card_last4 }));
  const reserve: CardReserve[] = creditCardReserve(branchId, bkkMonth());

  return (
    <div className="space-y-4">
      <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">บัตรเครดิตกรรมการ · เงินสำรองรอจ่ายธนาคาร</h1>
        <p className="text-sm text-slate-500 mt-1">
          ลงรายการรูดบัตร (จ่ายเต็ม/ผ่อน) → ระบบบอกยอดที่ต้องกันไว้จ่ายธนาคารตามรอบ + ตารางแต่ละเดือน
        </p>
      </div>
      <CreditCardsClient
        branchId={branchId}
        currentMonth={bkkMonth()}
        cards={cards}
        initialReserve={reserve}
      />
    </div>
  );
}
