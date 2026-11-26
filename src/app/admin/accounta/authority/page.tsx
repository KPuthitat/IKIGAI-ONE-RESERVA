import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import AuthorityClient from "./AuthorityClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · อำนาจอนุมัติ PR" };

// อำนาจอนุมัติใบขอซื้อ แบ่งตามบัญชีที่จ่ายและยอดเงิน (owner 2026-11-26) — เจ้าของระบบเท่านั้น.
export default function AuthorityPage() {
  const user = requireUser();
  if (user.role !== "super_admin") redirect("/admin");
  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/accounta/purchasing" className="text-sm text-slate-500 hover:text-brand">← กลับ งบ / PR / PO</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">อำนาจอนุมัติใบขอซื้อ (PR)</h1>
        <p className="text-sm text-slate-500">กำหนดว่าใบขอซื้อยอดเท่าไรต้องมีผู้บริหารกี่คนอนุมัติ แยกตามบัญชีที่จ่าย — ใบที่ไม่ระบุบัญชีหรือบัญชีที่ไม่ได้ตั้งเอง ใช้ค่าเริ่มต้นทั้งบริษัท (ถ้าไม่ได้ตั้งเลย = ผู้บริหาร 2 คน หรือผู้บริหารสูงสุด 1 คน)</p>
      </div>
      <AuthorityClient />
    </div>
  );
}
