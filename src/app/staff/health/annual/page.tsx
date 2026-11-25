import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getMyAuditTrail, getMyReportData, getMyRounds } from "@/lib/annual-checkup-db";
import { getDb } from "@/lib/db";
import { buildReport } from "@/lib/health-report/report";
import { loadItems } from "@/lib/health-report/store";
import HealthReportView from "@/app/components/HealthReportView";
import { isViewOpen } from "@/lib/annual-checkup-api";
import { getActiveConsent, hasConsented } from "@/lib/annual-checkup-employee";
import { makeFileToken } from "@/lib/annual-checkup-session";
import AnnualGate from "./AnnualGate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ผลตรวจสุขภาพประจำปี · NOKHOOK OS PORTAL" };

// The employee's own annual check-up results. Only their own rows, only released ones (enforced in the gateway); they first accept
// the PDPA notice and then type their PIN, which opens a 15-minute viewing window. Every opening is recorded for the audit list below.
const INTERP_TH: Record<string, string> = { normal: "ปกติ", abnormal: "ผิดปกติ", follow_up: "ต้องติดตาม" };
const INTERP_CLS: Record<string, string> = { normal: "bg-emerald-100 text-emerald-700", abnormal: "bg-rose-100 text-rose-700", follow_up: "bg-amber-100 text-amber-800" };
const ACTION_TH: Record<string, string> = {
  "subject.view": "เปิดดูผลตรวจของท่าน", "subject.release": "เปิดผลให้ท่านดู", "result.record": "บันทึกผล", "result.update": "แก้ไขร่างผล", "result.verify": "ตรวจสอบผล",
  "result.revise": "แก้ไขผลที่ตรวจสอบแล้ว", "result.attach": "แนบไฟล์ผล", "conclusion.save": "บันทึกสรุปผล", "file.view": "เปิดไฟล์ผลตรวจ"
};
const when = (iso: string) => new Date(iso.replace(" ", "T") + "Z").toLocaleString("th-TH", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

function show(r: Record<string, unknown>): string {
  if (r.value_num != null) return `${r.value_num}${r.unit ? ` ${r.unit}` : ""}`;
  if (typeof r.value_text === "string" && r.value_text) return r.value_text;
  if (typeof r.value_json === "string" && r.value_json) {
    try { const o = JSON.parse(r.value_json) as Record<string, unknown>; return Object.entries(o).map(([k, v]) => `${k}: ${String(v)}`).join("\n"); } catch { return r.value_json; }
  }
  return "—";
}

export default function AnnualResultsPage({ searchParams }: { searchParams: { round?: string } }) {
  const user = requireUser();
  const rounds = getMyRounds(user);
  const head = (
    <div>
      <h1 className="text-2xl font-bold text-slate-800">ผลตรวจสุขภาพประจำปี</h1>
      <p className="text-sm text-slate-500">ท่านเห็นได้เฉพาะผลของตนเอง หลังแพทย์เปิดผลแล้ว</p>
    </div>
  );
  if (rounds.length === 0) {
    return <div className="space-y-4">{head}<div className="card p-5 text-sm text-slate-600">ยังไม่มีผลตรวจที่เปิดให้ดู เมื่อแพทย์เปิดผลแล้วระบบจะแจ้งทาง LINE</div></div>;
  }
  if (!hasConsented(user.id)) {
    const c = getActiveConsent();
    return <div className="space-y-4">{head}<AnnualGate step="consent" consent={{ version: c.version, body: c.body }} /></div>;
  }
  if (!isViewOpen(user)) return <div className="space-y-4">{head}<AnnualGate step="pin" /></div>;

  const chosen = rounds.find((r) => String(r.id) === searchParams.round) ?? rounds[0];
  const db = getDb();
  const rd = getMyReportData(user, chosen.id);
  const texts = Object.fromEntries((db.prepare("SELECT key, title_th, body_th FROM annual_checkup_explanations").all() as Array<{ key: string; title_th: string | null; body_th: string }>).map((r) => [r.key, { title: r.title_th, body: r.body_th }]));
  const consultUrl = (db.prepare("SELECT value FROM annual_checkup_config WHERE key = 'consult_url'").get() as { value: string | null } | undefined)?.value?.trim() || null;
  const report = rd ? buildReport(rd, loadItems(db), texts, new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)) : null;
  const trail = getMyAuditTrail(user);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {head}
        <AnnualGate step="lock" />
      </div>
      {rounds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {rounds.map((r) => (
            <Link key={r.id} href={`/staff/health/annual?round=${r.id}`} className={r.id === chosen.id ? "btn-primary text-sm" : "btn-secondary text-sm"}>{r.name}</Link>
          ))}
        </div>
      )}
      {report
        ? <HealthReportView report={report} consultUrl={consultUrl} pdfHref={`/api/annual-checkup/me/report-pdf?round=${chosen.id}`} fileHref={(id) => `/api/annual-checkup/me/file/${id}?t=${encodeURIComponent(makeFileToken(id, user.id))}`} />
        : <div className="card p-5 text-sm text-slate-600">ผลของรอบนี้ยังไม่ได้เปิดให้ดู</div>}
      <div className="card p-4">
        <div className="font-semibold text-slate-800 mb-2">ใครเปิดดูข้อมูลฉัน</div>
        {trail.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีผู้อื่นเปิดดูข้อมูลของท่าน</p> : (
          <ul className="text-sm divide-y divide-slate-100">
            {trail.map((a, i) => <li key={i} className="py-1.5 flex flex-wrap justify-between gap-2"><span>{a.by_name} · {ACTION_TH[a.action] ?? a.action}</span><span className="text-slate-500">{when(a.created_at)}</span></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
