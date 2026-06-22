import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isRevshareBranch, getPartner, previewSettlement } from "@/lib/revshare-db";
import SettlementClient from "./SettlementClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · สรุป / ใบวางบิล GP" };

function nowBkk(): { y: number; m: number } {
  const d = new Date(Date.now() + 7 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

export default function RevshareSettlementPage({ searchParams }: { searchParams: { partner?: string; year?: string; month?: string } }) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  const partnerId = Number(searchParams.partner);
  if (branchId == null || !isRevshareBranch(branchId)) {
    return <div className="card text-sm text-slate-500">ฟีเจอร์นี้ใช้เฉพาะสาขาที่เปิดส่วนแบ่งยอดขาย</div>;
  }
  const partner = partnerId > 0 ? getPartner(partnerId, branchId) : null;
  if (!partner) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta/revshare" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <div className="card text-sm text-slate-500">ไม่พบคู่ค้า</div>
      </div>
    );
  }
  const now = nowBkk();
  const year = Number(searchParams.year) || now.y;
  const month = Number(searchParams.month) || now.m;
  const preview = previewSettlement(partner.id, branchId, year, month)!;

  const seller = getDb().prepare(
    "SELECT name, reg_address, tax_branch_code, contact_phone FROM branches WHERE id = ?"
  ).get(branchId) as { name: string; reg_address: string | null; tax_branch_code: string | null; contact_phone: string | null };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href={`/admin/accounta/revshare/rounds?partner=${partner.id}&year=${year}&month=${month}`} className="text-sm text-slate-500 hover:text-brand">← กลับรอบยอดขาย</Link>
        <Link href="/admin/accounta/revshare" className="text-sm text-brand hover:underline">รายชื่อคู่ค้า</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สรุป / ใบวางบิล · {partner.name}</h1>
        <p className="text-sm text-slate-500 mt-1">สรุปส่วนแบ่งรายเดือน → ออกใบเรียกเก็บ GP ครั้งเดียวสิ้นเดือน</p>
      </div>
      <SettlementClient
        partner={{ id: partner.id, name: partner.name, venue: partner.venue, vat_enabled: partner.vat_enabled }}
        seller={{ name: seller.name, address: seller.reg_address, taxBranchCode: seller.tax_branch_code, phone: seller.contact_phone }}
        initial={preview} year={year} month={month}
      />
    </div>
  );
}
