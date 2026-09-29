import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import FacebookSettingsClient from "./FacebookSettingsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "เชื่อม Facebook Messenger · Inbox" };

export default function FacebookSettingsPage() {
  const user = requireAdmin();
  return (
    <div className="space-y-4 max-w-2xl">
      <Link href="/admin/inbox" className="text-sm text-slate-500 hover:text-brand">← กลับกล่องข้อความ</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">เชื่อม Facebook Messenger</h1>
        <p className="text-sm text-slate-500 mt-1">ต่อเพจ Facebook เข้ากล่องข้อความน้องฮูก — แชทจาก Messenger จะมาโผล่รวมกับ LINE ตอบกลับได้จากที่เดียว</p>
      </div>
      {user.role !== "super_admin"
        ? <div className="card text-sm text-slate-500">หน้านี้เฉพาะผู้ดูแลระบบสูงสุด (super admin) เท่านั้น</div>
        : <FacebookSettingsClient />}
    </div>
  );
}
