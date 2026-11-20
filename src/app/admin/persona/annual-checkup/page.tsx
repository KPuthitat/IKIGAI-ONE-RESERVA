import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canImportCheckup } from "@/lib/annual-checkup-import";
import { isRecorderEligible } from "@/lib/annual-checkup-db";
import { getActiveConsent } from "@/lib/annual-checkup-employee";
import ConsentEditor from "./ConsentEditor";
import ImportClient, { type RoundOption } from "./ImportClient";
import RoundStatus from "./RoundStatus";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ตรวจสุขภาพประจำปี · PERSONA" };

// /admin/persona/annual-checkup — import the planning workbook for a round (phase 3). Owner or clinic recorder only.
// Phase 4 adds the result-entry screens; this page only sets up who is ordered which test.
export default function AnnualCheckupPage() {
  const user = requireAdmin();
  if (!canImportCheckup(user)) redirect("/admin?error=forbidden");
  const consent = getActiveConsent();
  const rounds = getDb().prepare(`
    SELECT r.id, r.name, r.status,
           (SELECT COUNT(*) FROM annual_checkup_orders o WHERE o.round_id = r.id) AS orders,
           (SELECT COUNT(DISTINCT COALESCE(o.user_id, -o.external_id)) FROM annual_checkup_orders o WHERE o.round_id = r.id) AS people
      FROM annual_checkup_rounds r ORDER BY r.id DESC
  `).all() as RoundOption[];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ตรวจสุขภาพประจำปี</h1>
        <p className="text-sm text-slate-500">นำเข้ารายชื่อและรายการตรวจของรอบจากไฟล์ Excel — ดูตัวอย่างก่อนเสมอ ระบบไม่เดาแถวที่จับคู่ไม่ได้ และนำเข้าซ้ำได้โดยไม่เกิดข้อมูลซ้ำ</p>
      </div>
      <div className="flex gap-2"><Link href="/admin/persona/annual-checkup/queue" className="btn-secondary text-sm">แก้ลำดับคิว / เวลานัด</Link><Link href="/admin/persona/annual-checkup/stations" className="btn-secondary text-sm">สถานีตรวจ</Link></div>
      {isRecorderEligible(user.id) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Link href="/staff/health/annual-checkup/queue"
            className="flex items-center gap-4 rounded-2xl px-5 py-5 text-white shadow-lg"
            style={{ background: "linear-gradient(100deg,#7A5AE6 0%,#5C86EA 48%,#33C6B5 100%)" }}>
            <span className="text-4xl" aria-hidden>📷</span>
            <span><span className="block text-xl font-extrabold">สแกน QR เช็กอิน / ประจำสถานี</span><span className="block text-sm opacity-90">สแกน QR ประจำตัวพนักงาน เปิดลงทะเบียน แล้วลงผลได้ทันที</span></span>
          </Link>
          <Link href="/staff/health/annual-checkup"
            className="flex items-center gap-4 rounded-2xl border-2 border-brand/30 bg-white px-5 py-5 text-slate-800 shadow-sm">
            <span className="text-4xl" aria-hidden>🧪</span>
            <span><span className="block text-xl font-extrabold">ลงผลตรวจ</span><span className="block text-sm text-slate-500">เลือกรอบ เลือกคน แล้วบันทึกผลแล็บและผลตรวจ</span></span>
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">ปุ่มสแกน QR และลงผลตรวจ แสดงเฉพาะเจ้าหน้าที่คลินิกที่ได้รับสิทธิ์ผู้ลงผล (บัญชีนี้ยังไม่มีสิทธิ์)</div>
      )}
      <RoundStatus rounds={rounds.map((r) => ({ id: r.id, name: r.name, status: r.status, people: r.people }))} />
      <ImportClient rounds={rounds} />
      {user.role === "super_admin" && <ConsentEditor version={consent.version} body={consent.body} />}
    </div>
  );
}
