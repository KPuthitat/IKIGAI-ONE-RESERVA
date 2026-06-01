import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { hasAdminPin } from "@/lib/admin-pin";
import PinManageClient from "./PinManageClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ตั้งค่า PIN · IKIGAI OS" };

// /admin/me/pin — admin sets or changes their personal PIN. The PIN
// is required for high-trust actions like approving a RECRUITA stage
// change (which itself needs two different admins each entering their
// own PIN). Plain staff don't see this — only admins + super-admins.

export default function PinManagePage() {
  const user = getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "super_admin" && user.role !== "admin") {
    redirect("/admin");
  }
  const exists = hasAdminPin(user.id);
  return (
    <div className="space-y-4 max-w-md">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ตั้งค่า PIN ผู้ดูแล</h1>
        <p className="text-sm text-slate-500 mt-1">
          PIN ตัวเลข 4-6 หลัก ใช้ยืนยันก่อนทำรายการสำคัญ เช่น อนุมัติการเปลี่ยน stage
          ของใบสมัครงาน. ไม่ใช่รหัสผ่านเข้าระบบ
        </p>
      </div>
      <PinManageClient hasPin={exists} />
    </div>
  );
}
