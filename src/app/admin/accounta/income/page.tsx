import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import {
  listBranches, listCompanies, listIncomeChannels, listIncome, incomeSummary
} from "@/lib/accounta-db";
import IncomeClient from "./IncomeClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · รายรับ" };

function thisMonth(): string { return new Date().toISOString().slice(0, 7); }

export default function AccountaIncomePage() {
  requirePermission("accounta.manage");
  const month = thisMonth();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ACCOUNTA
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/admin/accounta/channels" className="text-sm text-brand hover:underline">
            จัดการช่องทางรับเงิน →
          </Link>
          <Link href="/admin/accounta/daybook" className="text-sm text-brand hover:underline">
            ดูสมุดรายวัน (แบบเอกเซล) →
          </Link>
        </div>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รายรับ</h1>
        <p className="text-sm text-slate-500 mt-1">
          ลงรายรับแยกตามช่องทางชำระเงิน (เงินสด / QR / บัตรเครดิต ฯลฯ) — เพิ่ม/แก้ช่องทางได้เอง
        </p>
        <p className="text-[11px] text-slate-400 mt-1">การลงบันทึกนี้ไม่ได้อ้างอิงหลักการบัญชี</p>
      </div>
      <IncomeClient
        month={month}
        branches={listBranches()}
        companies={listCompanies()}
        channels={listIncomeChannels()}
        initialIncome={listIncome({ month })}
        initialSummary={incomeSummary(month)}
      />
    </div>
  );
}
