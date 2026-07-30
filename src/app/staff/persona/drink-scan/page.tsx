import type { Metadata } from "next";
import Link from "next/link";
import { requireUser, userCan } from "@/lib/auth";
import PartnerDrinkScanClient from "./PartnerDrinkScanClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "จ้อจี้ · สแกนรับเครื่องดื่ม" };

// Partner (จ้อจี้) redemption screen — scan a staff member's drink QR to fulfil
// the order. Strictly gated on the partner.drink.redeem permission (owner
// 2026-07-30) so only partner accounts see it.
export default function DrinkScanPage() {
  const user = requireUser();
  if (!userCan(user, "partner.drink.redeem")) {
    return (
      <div className="space-y-3">
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <div className="card text-sm text-slate-500">
          หน้านี้สำหรับบัญชีพาร์ทเนอร์ (จ้อจี้) เท่านั้น — ติดต่อแอดมินหากคุณควรมีสิทธิ์นี้
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">สแกนรับเครื่องดื่ม (จ้อจี้)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สแกน QR ของพนักงานเพื่อจ่ายเครื่องดื่ม · ระบบจะหักค่าเครื่องดื่มจากพนักงานให้อัตโนมัติ
        </p>
      </div>
      <PartnerDrinkScanClient />
    </div>
  );
}
