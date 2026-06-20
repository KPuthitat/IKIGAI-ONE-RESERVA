import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { listDriveConfigs, driveOAuthConfigured } from "@/lib/google-drive";
import DriveClient, { type DriveRow } from "./DriveClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · Google Drive" };

export default function AccountaDrivePage({ searchParams }: { searchParams: { drive?: string; msg?: string } }) {
  const user = getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "super_admin") redirect("/admin/accounta");

  const rows: DriveRow[] = listDriveConfigs().map((c) => ({
    branch_id: c.branch_id,
    branch_name: c.branch_name,
    company_name: c.company_name,
    enabled: !!c.enabled,
    connected: !!c.connected,
    oauth_email: c.oauth_email,
    last_ok_at: c.last_ok_at,
    last_error: c.last_error
  }));

  const serverReady = driveOAuthConfigured();
  const status = searchParams.drive ?? null;

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
          <p className="font-medium text-slate-600">วิธีตั้งค่า (ต่อสาขา):</p>
          <p>กดปุ่ม <b>“เชื่อมต่อ Google Drive”</b> ที่การ์ดสาขา → เข้าสู่ระบบด้วย <b>บัญชี Google ของสาขานั้น</b> → อนุญาต</p>
          <p>ระบบจะสร้างโฟลเดอร์ <b>“ACCOUNTA - บิลค่าใช้จ่าย”</b> ในไดรฟ์ของสาขาให้เอง ไม่ต้องสร้าง/แชร์โฟลเดอร์เอง</p>
          <p className="text-amber-600">ไฟล์จะอยู่ในไดรฟ์ของบัญชีสาขา (ใช้พื้นที่ 15GB ของสาขา) แยกขาดจริงทุกสาขา</p>
        </div>
      </div>

      {!serverReady && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ⚠️ เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า <code>GOOGLE_OAUTH_CLIENT_ID</code> / <code>GOOGLE_OAUTH_CLIENT_SECRET</code> —
          ต้องวาง 2 ค่านี้บนเซิร์ฟเวอร์ก่อน ปุ่มเชื่อมต่อจึงจะใช้ได้
        </div>
      )}
      {status === "connected" && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          เชื่อมต่อ Google Drive สำเร็จ ✓ ลองกด “ทดสอบ” แล้วยืนยันบิลสักใบเพื่อตรวจว่าไฟล์ขึ้น
        </div>
      )}
      {status === "denied" && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">ยกเลิกการเชื่อมต่อ (ไม่ได้กดอนุญาต)</div>
      )}
      {(status === "error" || status === "bad_state") && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          เชื่อมต่อไม่สำเร็จ{searchParams.msg ? `: ${searchParams.msg}` : ""} — ลองใหม่อีกครั้ง
        </div>
      )}

      <DriveClient rows={rows} serverReady={serverReady} />
    </div>
  );
}
