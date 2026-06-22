import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isRevshareBranch, listPartners } from "@/lib/revshare-db";
import RevshareHomeClient from "./RevshareHomeClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · ส่วนแบ่งยอดขาย (GP)" };

// Revenue-Share GP landing — only for branches with revshare_enabled
// (HYPOPLARAEMIA). Lists partners + lets the admin create one.
export default function RevshareHome() {
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
  if (!isRevshareBranch(branchId)) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">
          ฟีเจอร์ส่วนแบ่งยอดขาย (GP) เปิดใช้เฉพาะบางสาขาเท่านั้น — สาขา <b>{branch?.name ?? `#${branchId}`}</b> ยังไม่ได้เปิดใช้งาน
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ส่วนแบ่งยอดขาย (GP)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · คำนวณส่วนแบ่งยอดขายจากคู่ค้าที่เข้ามาดำเนินการขายในร้าน (แบ่งขั้นบันได)
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          การลงบันทึกนี้ใช้ติดตามภายในเท่านั้น ไม่ได้อ้างอิงหลักการบัญชี/ไม่ใช้แทนเอกสารทางภาษีอย่างเป็นทางการ
        </p>
      </div>
      <RevshareHomeClient initialPartners={listPartners(branchId)} />
    </div>
  );
}
