"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { nameWithPrefix } from "@/lib/name";
import { FormSection, Field } from "@/app/components/FormKit";
import IrReportView from "@/app/components/ir/IrReportView";
import {
  IR_SEVERITIES, IR_STATUSES, IR_CATEGORY_GROUPS,
  type IrSeverity, type IrStatus
} from "@/lib/ir-vocab";
import type { IrReportDetail } from "@/lib/ir-db";

export type AssigneeOption = { id: number; display_name: string; title_prefix: string | null };

export default function ReportDetailClient({
  initialReport, assignees
}: {
  initialReport: IrReportDetail;
  assignees: AssigneeOption[];
}) {
  const router = useRouter();
  const [r, setR] = useState<IrReportDetail>(initialReport);

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
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  async function resend() {
    setResending(true); setResendMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/ir/${r.id}/resend`), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      setResendMsg(res.ok && j.ok ? "ส่งเข้ากลุ่ม LINE ของทีมบริหารความเสี่ยงแล้ว" : humanizeApiError(j, "ส่งไม่สำเร็จ"));
    } catch { setResendMsg("เชื่อมต่อไม่สำเร็จ"); }
    finally { setResending(false); }
  }

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
      setR(j.report as IrReportDetail);
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
      {/* Left: the report as the reporter wrote it — facts, RCA, recommendations,
          people — through the SAME view staff see (owner 2026-10-01). */}
      <div className="lg:col-span-3">
        <IrReportView r={r} showVerdict={false} />
      </div>

      {/* Right: RM review / PDCA */}
      <div className="lg:col-span-2 space-y-4">
        <div className="card space-y-4">
          <FormSection title="ทบทวนและติดตาม (ทีมบริหารความเสี่ยง)">
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
            <Field label="สาเหตุราก (Root cause)" hint={r.reporter_root_cause && !rootCause ? (
              <button type="button" className="text-brand hover:underline" onClick={() => setRootCause(r.reporter_root_cause ?? "")}>ใช้ข้อความของผู้แจ้ง</button>
            ) : undefined}>
              <textarea rows={2} value={rootCause} onChange={(e) => setRootCause(e.target.value)}
                placeholder="ทำไมถึงเกิด — วิเคราะห์ถึงต้นตอ ไม่ใช่แค่อาการ" />
            </Field>
            <Field label="แนวทางแก้ไข/ป้องกัน" hint={r.rca.recommendations.length > 0 && !corrective ? (
              <button type="button" className="text-brand hover:underline" onClick={() => setCorrective(r.rca.recommendations.map((x, i) => `${i + 1}. ${x}`).join("\n"))}>ใช้ข้อเสนอแนะของผู้แจ้ง</button>
            ) : undefined}>
              <textarea rows={3} value={corrective} onChange={(e) => setCorrective(e.target.value)}
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
            {savedAt ? <span className="text-xs text-emerald-600">บันทึกแล้ว</span> : <span />}
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "กำลังบันทึก…" : "บันทึกการทบทวน"}
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
            <span className="text-xs text-slate-500">{resendMsg ?? "ส่งรายงานนี้เข้ากลุ่ม LINE ของทีมบริหารความเสี่ยงอีกครั้ง"}</span>
            <button type="button" className="btn btn-secondary text-sm" onClick={resend} disabled={resending}>
              {resending ? "กำลังส่ง…" : "ส่งเข้ากลุ่ม LINE อีกครั้ง"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
