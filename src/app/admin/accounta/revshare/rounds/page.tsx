import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isRevshareBranch, getPartner, getTiers, listRounds } from "@/lib/revshare-db";
import RoundsClient from "./RoundsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · รอบยอดขาย GP" };

function nowBkk(): { y: number; m: number } {
  const d = new Date(Date.now() + 7 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

export default function RevshareRoundsPage({ searchParams }: { searchParams: { partner?: string; year?: string; month?: string } }) {
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
  const sellerName = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string }).name;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta/revshare" className="text-sm text-slate-500 hover:text-brand">← กลับรายชื่อคู่ค้า</Link>
        <Link href={`/admin/accounta/revshare/settlement?partner=${partner.id}&year=${year}&month=${month}`} className="text-sm text-brand hover:underline">สรุปยอด / สร้างใบวางบิล →</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รอบยอดขาย · {partner.name}</h1>
        <p className="text-sm text-slate-500 mt-1">นำเข้าไฟล์ยอดขายประจำวัน · ระบบรวมยอดโอนรายสัปดาห์ (จันทร์–อาทิตย์) ให้อัตโนมัติ · ส่วนแบ่งคำนวณรายเดือนที่หน้าสรุปยอด</p>
      </div>
      <RoundsClient
        partner={partner}
        tiers={getTiers(partner.id)}
        rounds={listRounds(partner.id, branchId, year, month)}
        year={year} month={month}
        operatorName={user.display_name}
        sellerName={sellerName}
      />
    </div>
  );
}
