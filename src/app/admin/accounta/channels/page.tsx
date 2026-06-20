import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { listAllIncomeChannels } from "@/lib/accounta-db";
import ChannelsClient from "./ChannelsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · ช่องทางรับเงิน" };

// ช่องทางรับเงิน — the single master list (owner 2026-06-21). It drives
// both the manual รายรับ picklist AND the mandatory per-channel breakdown
// staff fill on every shift-close. Add a channel here → it appears on the
// close form for every branch that records daily sales.
export default function AccountaChannelsPage() {
  requirePermission("accounta.manage");
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <Link href="/admin/accounta/income" className="text-sm text-brand hover:underline">ไปหน้ารายรับ →</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ช่องทางรับเงิน</h1>
        <p className="text-sm text-slate-500 mt-1">
          รายการช่องทางรับชำระเงินกลาง — ใช้ทั้งหน้ารายรับ และฟอร์มปิดกะ (พนักงานกรอกยอดแยกช่องทางทุกวัน)
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          เพิ่มช่องทางที่นี่ จะไปขึ้นในฟอร์มปิดกะของทุกสาขาที่บันทึกยอดขายให้อัตโนมัติ (บังคับกรอก ไม่มีก็ใส่ 0) ·
          ปิดใช้งานช่องทางที่ไม่ใช้แล้วได้ (ของเก่าไม่หาย)
        </p>
      </div>
      <ChannelsClient initialChannels={listAllIncomeChannels()} />
    </div>
  );
}
