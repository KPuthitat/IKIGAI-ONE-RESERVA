import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listAllAccountaAccess } from "@/lib/accounta-access";
import AccessMatrixClient from "./AccessMatrixClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · สิทธิ์เข้าถึงตามสาขา" };

// Who can see/process each branch's accounting (owner 2026-06-25). super_admin
// only — it governs access to financial data.
export default function AccountaAccessPage() {
  requireSuperAdmin();
  const db = getDb();
  const users = db.prepare(`
    SELECT id, display_name, title_prefix, role FROM users
     WHERE role IN ('admin','super_admin') AND status NOT IN ('disabled','resigned','terminated')
     ORDER BY role = 'super_admin' DESC, display_name COLLATE NOCASE
  `).all() as Array<{ id: number; display_name: string; title_prefix: string | null; role: string }>;
  const branches = db.prepare("SELECT id, name FROM branches ORDER BY id").all() as Array<{ id: number; name: string }>;
  const grants = listAllAccountaAccess();

  return (
    <div className="space-y-4">
      <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สิทธิ์เข้าถึง ACCOUNTA ตามสาขา</h1>
        <p className="text-sm text-slate-500 mt-1">
          กำหนดว่าแต่ละคนเข้าถึงข้อมูลบัญชีของสาขาไหนได้บ้าง — <b>ดูอย่างเดียว</b> หรือ <b>ยืนยันลงบัญชี</b> ·
          แยกจากสาขาที่สังกัด (ผูกพนักงาน) เพื่อให้ผู้ทำบัญชีกลางเข้าได้หลายสาขา
        </p>
        <p className="text-[11px] text-slate-400 mt-1">เจ้าของระบบ (super admin) เข้าถึงทุกสาขา + ยืนยันได้เสมอ</p>
      </div>
      <AccessMatrixClient users={users} branches={branches} grants={grants} />
    </div>
  );
}
