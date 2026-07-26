import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { isRevshareBranch, getPartner, getTiers, getFloors } from "@/lib/revshare-db";
import { listBranches } from "@/lib/accounta-db";
import PartnerConfigClient from "./PartnerConfigClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · ตั้งค่าคู่ค้า GP" };

export default function RevshareConfigPage({ searchParams }: { searchParams: { partner?: string } }) {
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

  return (
    <div className="space-y-4">
      <Link href="/admin/accounta/revshare" className="text-sm text-slate-500 hover:text-brand">← กลับรายชื่อคู่ค้า</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ตั้งค่าคู่ค้า · {partner.name}</h1>
        <p className="text-sm text-slate-500 mt-1">ขั้นบันได GP, ยอดขั้นต่ำ, VAT/WHT, ฐานยอดขาย และหมวด POS</p>
      </div>
      <PartnerConfigClient partner={partner} tiers={getTiers(partner.id)} floors={getFloors(partner.id)}
        branches={listBranches().map((b) => ({ id: b.id, name: b.name }))} />
    </div>
  );
}
