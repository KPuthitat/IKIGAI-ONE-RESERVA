import { thDateBE } from "@/lib/th-month";
import { nameWithPrefix } from "@/lib/name";
import {
  severityMeta, statusMeta, categoryLabel, incidentTypeLabel, factorLabel, personRoleLabel
} from "@/lib/ir-vocab";
import type { IrReportDetail } from "@/lib/ir-db";

// Read-only rendering of a detailed incident report (owner 2026-10-01). Both the
// staff detail page and the admin review page show the report through this one
// component, so what the reporter wrote reads identically everywhere.

export function fmtIrDateTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") || s.includes(" ") ? s : `${s}T00:00:00`);
  if (isNaN(d.getTime())) return s;
  return thDateBE(d, { time: true });
}

export default function IrReportView({ r, showVerdict = true }: { r: IrReportDetail; showVerdict?: boolean }) {
  const sm = severityMeta(r.severity);
  const st = statusMeta(r.status);
  const reporter = r.is_anonymous ? "ไม่ระบุตัวตน" : (r.reporter_name ? nameWithPrefix(r.reporter_prefix, r.reporter_name) : "—");
  const hasRca = r.rca.whyChain.length > 0 || r.rca.contributing.length > 0 || !!r.reporter_root_cause;
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-400 tabular-nums">{r.code ?? `#${r.id}`}</span>
          <span className={`text-[11px] px-1.5 py-0.5 rounded border ${sm.tone}`}>{sm.value} · {sm.labelTh}</span>
          <span className={`text-[11px] px-1.5 py-0.5 rounded border ${st.tone}`}>{st.labelTh}</span>
          <span className="text-[11px] text-slate-400">{incidentTypeLabel(r.incident_type)}</span>
        </div>
        <h1 className="text-lg font-bold text-slate-800">{categoryLabel(r.category)}</h1>
        <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Row label="เกิดขึ้นเมื่อ" value={fmtIrDateTime(r.occurred_at)} />
          <Row label="จุดเกิดเหตุ" value={r.location_detail || "—"} />
          <Row label="ผู้แจ้ง" value={`${reporter}${!r.is_anonymous && r.self_involved === 1 ? " · เป็นผู้เกี่ยวข้องโดยตรง" : ""}`} />
          <Row label="แจ้งเมื่อ" value={fmtIrDateTime(r.created_at)} />
        </dl>
        {r.people.length > 0 && (
          <div>
            <div className="text-xs text-slate-400 mb-1">ผู้เกี่ยวข้องอื่น</div>
            <ul className="text-sm text-slate-700 space-y-0.5">
              {r.people.map((p) => (
                <li key={p.id} className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{personRoleLabel(p.role)}{p.user_id == null ? " · บุคคลภายนอก" : ""}</span>
                  {p.note && <span className="text-xs text-slate-500">{p.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold text-slate-700 text-sm">เกิดอะไรขึ้น</h2>
        <p className="text-sm text-slate-700 whitespace-pre-wrap">{r.description}</p>
        {r.timeline && <Block label="ลำดับเหตุการณ์" text={r.timeline} />}
        {r.impact && <Block label="ผลกระทบ" text={r.impact} />}
        {r.immediate_action && <Block label="แก้ไขเฉพาะหน้า" text={r.immediate_action} />}
      </div>

      {hasRca && (
        <div className="card space-y-3">
          <h2 className="font-semibold text-slate-700 text-sm">วิเคราะห์สาเหตุราก (โดยผู้แจ้ง)</h2>
          {r.rca.whyChain.length > 0 && (
            <ol className="space-y-1">
              {r.rca.whyChain.map((w, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-700">
                  <span className="text-xs text-slate-400 w-14 shrink-0 mt-0.5">ทำไม #{i + 1}</span>
                  <span>{w}</span>
                </li>
              ))}
            </ol>
          )}
          {r.rca.contributing.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {r.rca.contributing.map((k) => (
                <span key={k} className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">{factorLabel(k)}</span>
              ))}
            </div>
          )}
          {r.reporter_root_cause && <Block label="สรุปสาเหตุราก" text={r.reporter_root_cause} />}
        </div>
      )}

      {r.rca.recommendations.length > 0 && (
        <div className="card space-y-2">
          <h2 className="font-semibold text-slate-700 text-sm">ข้อเสนอแนะ / แนวทางป้องกัน (โดยผู้แจ้ง)</h2>
          <ol className="list-decimal pl-5 text-sm text-slate-700 space-y-1">
            {r.rca.recommendations.map((x, i) => <li key={i}>{x}</li>)}
          </ol>
        </div>
      )}

      {showVerdict && (r.root_cause || r.corrective_action || r.assignee_name || r.due_date || r.reviewed_at) && (
        <div className="card space-y-2 border-sky-200 bg-sky-50/40">
          <h2 className="font-semibold text-sky-800 text-sm">ผลการทบทวนโดยทีมบริหารความเสี่ยง (RM)</h2>
          {r.root_cause && <Block label="สาเหตุราก (ทีมบริหารความเสี่ยง)" text={r.root_cause} />}
          {r.corrective_action && <Block label="แนวทางแก้ไข/ป้องกัน" text={r.corrective_action} />}
          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {r.assignee_name && <Row label="ผู้รับผิดชอบ" value={nameWithPrefix(r.assignee_prefix, r.assignee_name)} />}
            {r.due_date && <Row label="กำหนดเสร็จ" value={fmtIrDateTime(r.due_date)} />}
          </dl>
        </div>
      )}

      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-2 text-sm">ประวัติการดำเนินการ</h2>
        <ul className="text-xs text-slate-500 space-y-1">
          <li>แจ้งเมื่อ {fmtIrDateTime(r.created_at)}</li>
          {r.reporter_updated_at && r.reporter_updated_at !== r.created_at && <li>ผู้แจ้งแก้ไขล่าสุด {fmtIrDateTime(r.reporter_updated_at)}</li>}
          {r.reviewed_at && <li>เริ่มทบทวนเมื่อ {fmtIrDateTime(r.reviewed_at)}</li>}
          {r.discussed_at && <li>เข้าประชุมทบทวนวันที่ {fmtIrDateTime(r.discussed_at)}</li>}
          {r.resolved_at && <li>ปิดเคสเมื่อ {fmtIrDateTime(r.resolved_at)}</li>}
        </ul>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-slate-700">{value}</dd>
    </div>
  );
}
function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <p className="text-sm text-slate-700 whitespace-pre-wrap">{text}</p>
    </div>
  );
}
