import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { canModule, requireUser } from "@/lib/auth";
import { isApprover, viewerOf } from "@/lib/purchasing";
import PurchasingClient from "./PurchasingClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · งบ OPEX/CAPEX · PR/PO" };

// ระบบสำหรับผู้บริหาร: งบ OPEX/CAPEX เทียบยอดใช้จริง + ใบขอซื้อ (PR) → อนุมัติ → ใบสั่งซื้อ (PO) → รับของ → ผูกบิล (owner 2026-10-27).
export default function PurchasingPage({ searchParams }: { searchParams: { pr?: string } }) {
  const user = requireUser();
  if (!canModule(user, "accounta.manage") && !isApprover(viewerOf(user))) redirect("/admin");
  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">งบประมาณ OPEX / CAPEX · ใบขอซื้อ (PR) · ใบสั่งซื้อ (PO)</h1>
        <p className="text-sm text-slate-500">ตั้งงบรายปีต่อสาขา เทียบกับยอดใช้จริงใน ACCOUNTA และยอดที่ผูกพันแล้ว · ผู้บริหารอนุมัติใบขอซื้อ แล้วออกใบสั่งซื้อ รับของ และผูกกับบิลที่ลงบัญชี</p>
      </div>
      <PurchasingClient openPrId={searchParams.pr ? Number(searchParams.pr) || null : null} />
    </div>
  );
}
