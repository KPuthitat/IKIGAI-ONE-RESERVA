import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// /admin/persona — embed Payroll Express ใน iframe
// URL bar คงเป็น /admin/persona ตลอด · ใส้ในเป็น Payroll backend (Express :3000)
// Auth: ผู้ใช้ login ที่ /login แล้ว Payroll trust reserva_session cookie อัตโนมัติ
export default function AdminPersonaPage() {
  requireAdmin();
  return (
    <div className="-mx-4 -my-4">
      <iframe
        src="/payroll/portal"
        className="w-full block border-0 bg-white"
        style={{ height: "calc(100vh - 60px)", minHeight: "500px" }}
        title="PERSONA — ระบบบริหารงานบุคคล"
      />
    </div>
  );
}
