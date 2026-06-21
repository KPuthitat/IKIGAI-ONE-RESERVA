import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listAllIncomeChannels, listDefaultChannelNames } from "@/lib/accounta-db";
import ChannelsClient from "./ChannelsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · ช่องทางรับเงิน" };

// ช่องทางรับเงิน — PER BRANCH (owner 2026-06-21). Each branch keeps its own
// channel list (a clinic's insurer accounts differ from a restaurant's cards).
// Drives both the manual รายรับ picklist AND the shift-close breakdown for the
// branch selected at the top of the console.
export default function AccountaChannelsPage() {
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
        <Link href="/admin/accounta/income" className="text-sm text-brand hover:underline">ไปหน้ารายรับ →</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ช่องทางรับเงิน</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · ช่องทางรับชำระเงินของสาขานี้ — ใช้ทั้งหน้ารายรับ และฟอร์มปิดกะ
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          แต่ละสาขาตั้งช่องทางของตัวเองได้ (เช่น คลินิกใช้ เงินสด/PromptPay + บริษัทประกัน · ร้านอาหารใช้ เงินสด/QR/บัตร) ·
          เพิ่มที่นี่ → ขึ้นในฟอร์มปิดกะของสาขานี้ (บังคับกรอก ไม่มีก็ใส่ 0) · ปิดใช้งานได้ (ของเก่าไม่หาย)
        </p>
      </div>
      <ChannelsClient
        initialChannels={listAllIncomeChannels(branchId)}
        defaults={listDefaultChannelNames()}
      />
    </div>
  );
}
