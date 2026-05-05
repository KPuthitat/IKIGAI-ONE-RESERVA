import Link from "next/link";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function AdminPersonaPage() {
  requireAdmin();
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand mb-3 inline-block">
          ← กลับเลือก module
        </Link>
        <h1 className="text-2xl font-bold text-slate-800">PERSONA — หลังบ้าน</h1>
        <p className="text-sm text-slate-500 mt-1">ระบบบริหารงานบุคคล</p>
      </div>

      <div className="card max-w-2xl">
        <p className="text-slate-600 mb-4">
          จัดการพนักงาน · เงินเดือน · OT · ลา · ตรวจเวลาเข้าออกงาน
        </p>
        <a href="/payroll" className="btn-primary inline-flex">เข้าระบบ PERSONA →</a>
        <p className="text-xs text-slate-400 mt-3">
          ใช้ session เดียวกับ IKIGAI OS — ไม่ต้องล็อกอินซ้ำ
        </p>
      </div>
    </div>
  );
}
