import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getMyAuditTrail, getMyReleasedResults, getMyRounds } from "@/lib/annual-checkup-db";
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
  const data = getMyReleasedResults(user, chosen.id);
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
      <div className="card overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">{chosen.name}</div>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500"><tr><th className="px-4 py-2">รายการตรวจ</th><th className="px-4 py-2">ผล</th><th className="px-4 py-2">ค่าอ้างอิง</th><th className="px-4 py-2">การแปลผล</th><th className="px-4 py-2">ไฟล์</th></tr></thead>
          <tbody>
            {data.results.map((r) => (
              <tr key={r.result_id as number} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2 text-slate-800">{r.name_th as string}</td>
                <td className="px-4 py-2 whitespace-pre-line text-slate-800">{show(r)}</td>
                <td className="px-4 py-2 text-slate-600">{(r.ref_text as string | null) || "—"}</td>
                <td className="px-4 py-2">{r.interpretation ? <span className={`px-2 py-0.5 rounded-full text-xs ${INTERP_CLS[r.interpretation as string] ?? ""}`}>{INTERP_TH[r.interpretation as string]}</span> : "—"}</td>
                <td className="px-4 py-2">{r.has_file ? <a className="text-sky-700 underline" target="_blank" rel="noreferrer" href={`/api/annual-checkup/me/file/${r.result_id}?t=${encodeURIComponent(makeFileToken(r.result_id as number, user.id))}`}>เปิดไฟล์</a> : "—"}</td>
              </tr>
            ))}
            {data.results.length === 0 && <tr><td colSpan={5} className="px-4 py-4 text-slate-500">ไม่มีรายการ</td></tr>}
          </tbody>
        </table>
      </div>
      {data.conclusion && (
        <div className="card p-4 space-y-1">
          <div className="font-semibold text-slate-800">สรุปผลและความเห็นแพทย์</div>
          {data.conclusion.summary && <div><span className={`px-2 py-0.5 rounded-full text-xs ${INTERP_CLS[data.conclusion.summary] ?? ""}`}>{INTERP_TH[data.conclusion.summary]}</span></div>}
          <p className="text-sm text-slate-700 whitespace-pre-line">{data.conclusion.doctor_comment || "—"}</p>
          <div className="text-xs text-slate-500">เปิดผลเมื่อ {when(data.conclusion.released_at)}</div>
        </div>
      )}
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
