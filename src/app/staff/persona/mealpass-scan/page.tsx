import type { Metadata } from "next";
import Link from "next/link";
import { requireUser, userCan } from "@/lib/auth";
import MealpassPartnerScanClient from "./MealpassPartnerScanClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ศาลาชิลล์ · สแกนยืนยันอาหาร" };

// Partner (ศาลาชิลล์) confirm screen — scan a staff member's SC-xxxx code to
// confirm a cross-company meal. Strictly gated on partner.mealpass.confirm so
// only the selling-company's partner accounts see it.
export default function MealpassScanPage() {
  const user = requireUser();
  if (!userCan(user, "partner.mealpass.confirm")) {
    return (
      <div className="space-y-3">
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <div className="card text-sm text-slate-500">
          หน้านี้สำหรับบัญชีพาร์ทเนอร์ (ศาลาชิลล์) เท่านั้น — ติดต่อแอดมินหากคุณควรมีสิทธิ์นี้
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">สแกนยืนยันอาหารข้ามบริษัท (ศาลาชิลล์)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สแกน QR ของพนักงานเพื่อยืนยัน · ระบบจะหักค่าอาหารจากค่าตอบแทนพนักงานให้อัตโนมัติ (บริษัทชำระให้ตามรอบสัปดาห์)
        </p>
      </div>
      <MealpassPartnerScanClient />
    </div>
  );
}
