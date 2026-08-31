"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { nameWithPrefix } from "@/lib/name";
import { FormSection, Field } from "@/app/components/FormKit";
import {
  IR_SEVERITIES, IR_STATUSES, IR_CATEGORY_GROUPS,
  severityMeta, statusMeta, categoryLabel, incidentTypeLabel,
  type IrSeverity, type IrStatus
} from "@/lib/ir-vocab";
import type { IrReportView } from "@/lib/ir-db";

export type AssigneeOption = { id: number; display_name: string; title_prefix: string | null };

function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") || s.includes(" ") ? s : `${s}T00:00:00`);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ReportDetailClient({
  initialReport, assignees
}: {
  initialReport: IrReportView;
  assignees: AssigneeOption[];
}) {
  const router = useRouter();
  const [r, setR] = useState<IrReportView>(initialReport);

  // Review form state (seeded from the row).
  const [status, setStatus] = useState<IrStatus>(r.status);
  const [severity, setSeverity] = useState<IrSeverity>(r.severity as IrSeverity);
  const [category, setCategory] = useState(r.category);
  const [rootCause, setRootCause] = useState(r.root_cause ?? "");
  const [corrective, setCorrective] = useState(r.corrective_action ?? "");
  const [assignedTo, setAssignedTo] = useState<number | 0>(r.assigned_to ?? 0);
  const [dueDate, setDueDate] = useState(r.due_date ?? "");
  const [discussedAt, setDiscussedAt] = useState(r.discussed_at ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const sm = severityMeta(r.severity);
  const st = statusMeta(r.status);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/ir/${r.id}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status, severity, category,
          root_cause: rootCause.trim() || null,
          corrective_action: corrective.trim() || null,
          assigned_to: assignedTo || null,
          due_date: dueDate || null,
          discussed_at: discussedAt || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      setR(j.report as IrReportView);
      setSavedAt(Date.now());
      router.refresh();
    } catch {
      setErr("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-5 gap-4">
      {/* Left: the report as filed (read-only) */}
      <div className="lg:col-span-3 space-y-4">
        <div className="card space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-400 tabular-nums">{r.code ?? `#${r.id}`}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded border ${sm.tone}`}>{sm.labelTh}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded border ${st.tone}`}>{st.labelTh}</span>
              </div>
              <h1 className="text-lg font-bold text-slate-800 mt-1.5">{categoryLabel(r.category)}</h1>
            </div>
          </div>

          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Row label="เกิดขึ้นเมื่อ" value={fmtDateTime(r.occurred_at)} />
            <Row label="ชนิด" value={incidentTypeLabel(r.incident_type)} />
            <Row label="จุดเกิดเหตุ" value={r.location_detail || "—"} />
            <Row label="ผู้แจ้ง" value={r.is_anonymous ? "ไม่ระบุตัวตน" : (r.reporter_name ? nameWithPrefix(r.reporter_prefix, r.reporter_name) : "—")} />
          </dl>

          <div>
            <div className="text-xs text-slate-400 mb-1">เกิดอะไรขึ้น</div>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{r.description}</p>
          </div>
          {r.immediate_action && (
            <div>
              <div className="text-xs text-slate-400 mb-1">แก้ไขเฉพาะหน้า</div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{r.immediate_action}</p>
            </div>
          )}
        </div>

        {/* Audit trail */}
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-2 text-sm">ประวัติการดำเนินการ</h2>
          <ul className="text-xs text-slate-500 space-y-1">
            <li>แจ้งเมื่อ {fmtDateTime(r.created_at)}</li>
            {r.reviewed_at && <li>เริ่มทบทวนเมื่อ {fmtDateTime(r.reviewed_at)}</li>}
            {r.discussed_at && <li>เข้าประชุมทบทวนวันที่ {fmtDateTime(r.discussed_at)}</li>}
            {r.resolved_at && <li>ปิดเคสเมื่อ {fmtDateTime(r.resolved_at)}</li>}
          </ul>
        </div>
      </div>

      {/* Right: RM review / PDCA */}
      <div className="lg:col-span-2 space-y-4">
        <div className="card space-y-4">
          <FormSection title="ทบทวนและติดตาม (RM)">
            <Field label="สถานะ">
              <div className="flex flex-wrap gap-1.5">
                {IR_STATUSES.map((s) => (
                  <button type="button" key={s.value} onClick={() => setStatus(s.value)}
                    className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                      status === s.value ? s.tone + " ring-1 ring-current font-semibold" : "bg-white text-slate-600 border-slate-200 hover:border-brand/40"}`}>
                    {s.labelTh}
                  </button>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="ระดับความรุนแรง">
                <select value={severity} onChange={(e) => setSeverity(Number(e.target.value) as IrSeverity)}>
                  {IR_SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.value} · {s.labelTh}</option>)}
                </select>
              </Field>
              <Field label="หมวด">
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {IR_CATEGORY_GROUPS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((it) => <option key={it.key} value={it.key}>{it.labelTh}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Field>
            </div>
          </FormSection>

          <FormSection title="สาเหตุและการแก้ไข (PDCA)">
            <Field label="สาเหตุราก (Root cause)">
              <textarea rows={2} value={rootCause} onChange={(e) => setRootCause(e.target.value)}
                placeholder="ทำไมถึงเกิด — วิเคราะห์ถึงต้นตอ ไม่ใช่แค่อาการ" />
            </Field>
            <Field label="แนวทางแก้ไข/ป้องกัน">
              <textarea rows={2} value={corrective} onChange={(e) => setCorrective(e.target.value)}
                placeholder="จะทำอะไรเพื่อไม่ให้เกิดซ้ำ" />
            </Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="ผู้รับผิดชอบ">
                <select value={assignedTo} onChange={(e) => setAssignedTo(Number(e.target.value))}>
                  <option value={0}>— ยังไม่กำหนด —</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>{nameWithPrefix(a.title_prefix, a.display_name)}</option>
                  ))}
                </select>
              </Field>
              <Field label="กำหนดเสร็จ">
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
            </div>
            <Field label="วันที่เข้าประชุมทบทวน" hint="ถ้ามี">
              <input type="date" value={discussedAt} onChange={(e) => setDiscussedAt(e.target.value)} />
            </Field>
          </FormSection>

          {err && <div className="text-sm text-rose-600">{err}</div>}
          <div className="flex items-center justify-between">
            {savedAt ? <span className="text-xs text-emerald-600">บันทึกแล้ว ✓</span> : <span />}
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "กำลังบันทึก…" : "บันทึกการทบทวน"}
            </button>
          </div>
        </div>
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
