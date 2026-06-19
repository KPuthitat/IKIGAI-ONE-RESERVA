import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { listDriveConfigs } from "@/lib/google-drive";
import DriveClient, { type DriveRow } from "./DriveClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · Google Drive" };

export default function AccountaDrivePage() {
  const user = getSessionUser();
  if (!user) redirect("/login");
  // Holds service-account credentials → super_admin only.
  if (user.role !== "super_admin") redirect("/admin/accounta");

  // Strip the encrypted key before sending to the client — expose only
  // whether a key is set + its (non-secret) client_email.
  const rows: DriveRow[] = listDriveConfigs().map((c) => ({
    branch_id: c.branch_id,
    branch_name: c.branch_name,
    company_name: c.company_name,
    enabled: !!c.enabled,
    has_key: !!c.sa_json_enc,
    sa_client_email: c.sa_client_email,
    root_folder_id: c.root_folder_id,
    last_ok_at: c.last_ok_at,
    last_error: c.last_error
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta/expenses" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ รายจ่าย
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Google Drive — เก็บไฟล์บิลแยกสาขา</h1>
        <p className="text-sm text-slate-500 mt-1">
          เมื่อ <b>ยืนยันบิล</b> ระบบจะอัปไฟล์ใบเสร็จขึ้น Drive ของสาขานั้น จัดเข้าโฟลเดอร์ตามเดือนของบิลอัตโนมัติ
        </p>
        <div className="text-[12px] text-slate-500 mt-2 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 space-y-1">
          <p className="font-medium text-slate-600">วิธีตั้งค่าต่อสาขา (ทำใน Google Cloud / Drive ของสาขา):</p>
          <p>1. สร้าง <b>Service Account</b> ใน Google Cloud + เปิด Google Drive API → ดาวน์โหลด key เป็นไฟล์ JSON</p>
          <p>2. ใน Google Drive ของสาขา สร้างโฟลเดอร์ปลายทาง แล้ว <b>แชร์โฟลเดอร์นั้นให้อีเมลของ service account</b> (สิทธิ์ Editor)</p>
          <p>3. คัดลอก <b>Folder ID</b> (จาก URL ของโฟลเดอร์) มาวางด้านล่าง + วางเนื้อหาไฟล์ JSON</p>
          <p className="text-amber-600">คีย์ถูกเก็บแบบเข้ารหัส และแสดงผลเฉพาะอีเมล service account เท่านั้น</p>
        </div>
      </div>
      <DriveClient rows={rows} />
    </div>
  );
}
