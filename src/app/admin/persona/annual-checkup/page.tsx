import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canImportCheckup } from "@/lib/annual-checkup-import";
import { getActiveConsent } from "@/lib/annual-checkup-employee";
import ConsentEditor from "./ConsentEditor";
import ImportClient, { type RoundOption } from "./ImportClient";

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
      <ImportClient rounds={rounds} />
      {user.role === "super_admin" && <ConsentEditor version={consent.version} body={consent.body} />}
    </div>
  );
}
