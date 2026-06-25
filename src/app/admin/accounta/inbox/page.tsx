import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { listExpenses } from "@/lib/accounta-db";
import { accountaAccessFor } from "@/lib/accounta-access";
import InboxClient from "./InboxClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · เอกสารรอลงบัญชี" };

// Scanned-bill inbox (owner 2026-06-25): all น้องฮูก-scanned drafts in one place,
// grouped by branch, scoped to the branches this user has ACCOUNTA access to.
export default function AccountaInboxPage() {
  const user = requirePermission("accounta.manage");
  const access = accountaAccessFor(user.id, user.role);
  const isSuper = user.role === "super_admin";
  const canSomeConfirm = isSuper || [...access.values()].includes("confirm");

  const drafts = listExpenses({ reviewStatus: "draft" })
    .filter((d) => (d.branch_id != null && access.has(d.branch_id)) || (d.branch_id == null && canSomeConfirm))
    .map((d) => ({
      id: d.id, branch_id: d.branch_id, branch_name: d.branch_name,
      vendor_name: d.vendor_name, category: d.category, amount_total: d.amount_total,
      bill_date: d.bill_date, has_doc: d.has_doc, note: d.note
    }));

  const confirmable = isSuper ? "all" : [...access.entries()].filter(([, l]) => l === "confirm").map(([b]) => b);

  return (
    <div className="space-y-4">
      <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">เอกสารรอลงบัญชี</h1>
        <p className="text-sm text-slate-500 mt-1">
          บิล/ใบเสร็จที่สแกนผ่านน้องฮูก รวมไว้ที่เดียว แยกตามสาขา — ตรวจแล้วกด “ยืนยันลงบัญชี” เพื่อเข้าสมุด
        </p>
        {access.size === 0 && !isSuper && (
          <p className="text-[11px] text-amber-600 mt-1">คุณยังไม่ได้รับสิทธิ์เข้าถึงสาขาใด — แจ้งผู้ดูแลระบบให้เปิดสิทธิ์ที่ “สิทธิ์เข้าถึงตามสาขา”</p>
        )}
      </div>
      <InboxClient drafts={drafts} confirmable={confirmable} />
    </div>
  );
}
