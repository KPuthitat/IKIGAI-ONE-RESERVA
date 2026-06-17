import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · IKIGAI OS" };

// ACCOUNTA — accounting module (owner 2026-06-16). Landing that groups the
// sub-areas: บัญชีรายรับ-รายจ่าย (coming) + FEASIBILITY (project payback).
export default function AccountaHome() {
  requirePermission("accounta.manage");
  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">
          ← กลับหน้ารวมโมดูล
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ACCOUNTA</h1>
        <p className="text-sm text-slate-500 mt-1">
          ระบบบัญชี — ลงรายรับ-รายจ่าย ภาษีซื้อ-ขาย และประเมินความเป็นไปได้/จุดคืนทุนของแต่ละสาขา
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link href="/admin/accounta/feasibility"
          className="card hover:shadow-lg transition group block space-y-1">
          <div className="text-[11px] tracking-[1px] text-slate-400">โมดูลย่อย</div>
          <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            FEASIBILITY
          </h2>
          <p className="text-slate-500 text-sm">
            ประเมินความเป็นไปได้ของโปรเจคลงทุน + บัญชีเงินลงทุนตั้งต้น และจุดคืนทุน
          </p>
          <p className="text-brand font-bold text-sm pt-2">เปิด →</p>
        </Link>

        <Link href="/admin/accounta/expenses"
          className="card hover:shadow-lg transition group block space-y-1">
          <div className="text-[11px] tracking-[1px] text-slate-400">โมดูลย่อย</div>
          <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            รายจ่าย
          </h2>
          <p className="text-slate-500 text-sm">
            ลงบิลผู้ค้า (ชำระแล้ว/ค้างชำระ) · ภาษีซื้อเรียลไทม์ · มุมมองตามบิล vs กระแสเงินสด · สแกนบิลด้วย OCR
          </p>
          <p className="text-brand font-bold text-sm pt-2">เปิด →</p>
        </Link>
      </div>
    </div>
  );
}
