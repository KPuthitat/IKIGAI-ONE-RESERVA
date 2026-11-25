import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSharedReportData, isAnnualCheckupForbidden } from "@/lib/annual-checkup-db";
import { buildReport } from "@/lib/health-report/report";
import { loadItems } from "@/lib/health-report/store";
import HealthReportView from "@/app/components/HealthReportView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผลตรวจที่พนักงานยินยอมให้ดู · PERSONA", robots: { index: false } };

// HR may open ONE employee's released report only when that employee agreed to share values (checked again in the gateway); every opening is
// written to that employee's own "who opened my data" list.
export default function SharedReportPage({ params }: { params: { roundId: string; userId: string } }) {
  const user = requireUser();
  const roundId = Number(params.roundId), userId = Number(params.userId);
  if (!Number.isInteger(roundId) || !Number.isInteger(userId)) notFound();
  let d: ReturnType<typeof getSharedReportData>;
  try { d = getSharedReportData(user, roundId, userId); } catch (e) { if (isAnnualCheckupForbidden(e)) redirect("/admin/annual-checkup-status"); throw e; }
  if (!d) notFound();
  const db = getDb();
  const texts = Object.fromEntries((db.prepare("SELECT key, title_th, body_th FROM annual_checkup_explanations").all() as Array<{ key: string; title_th: string | null; body_th: string }>).map((r) => [r.key, { title: r.title_th, body: r.body_th }]));
  const report = buildReport(d, loadItems(db), texts, new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  for (const sec of report.sections) sec.file = null;     // attached images stay with the person and the clinic
  return (
    <div className="space-y-4">
      <Link href={`/admin/annual-checkup-status?round=${roundId}`} className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">พนักงานคนนี้ยินยอมให้ฝ่ายบุคคลดูผลตรวจ การเปิดดูครั้งนี้ถูกบันทึกในรายการ "ใครเปิดดูข้อมูลฉัน" ของพนักงาน โปรดใช้เพื่อการดูแลสุขภาพเท่านั้น</div>
      <HealthReportView report={report} consultUrl={null} fileHref={() => "#"} />
    </div>
  );
}
