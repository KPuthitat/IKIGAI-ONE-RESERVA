"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { thDateBE } from "@/lib/th-month";
import { humanizeApiError } from "@/lib/error-messages";
import { nameWithPrefix } from "@/lib/name";
import { FormSection, Field } from "@/app/components/FormKit";
import IrReportView from "@/app/components/ir/IrReportView";
import {
  IR_SEVERITIES, IR_STATUSES, irCategoryGroupsFor,
  type IrSeverity, type IrStatus
} from "@/lib/ir-vocab";
import type { IrReportDetail } from "@/lib/ir-db";
import Mascot from "@/app/components/Mascot";

const fmtSent = (iso: string) => thDateBE(new Date(iso), { time: true });

export type AssigneeOption = { id: number; display_name: string; title_prefix: string | null };

export default function ReportDetailClient({
  initialReport, assignees, canDelete = false, isClinic = true
}: {
  initialReport: IrReportDetail;
  assignees: AssigneeOption[];
  canDelete?: boolean;
  isClinic?: boolean;
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

  // Delete — top executive only, PIN-gated (owner 2026-10-11).
  const [delOpen, setDelOpen] = useState(false);
  const [delPin, setDelPin] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  async function remove() {
    setDelBusy(true); setDelErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/ir/${r.id}`), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ admin_pin: delPin }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setDelErr(j.message ?? humanizeApiError(j, "ลบไม่สำเร็จ")); return; }
      router.push("/admin/ir/reports");
      router.refresh();
    } catch { setDelErr("เชื่อมต่อไม่สำเร็จ"); }
    finally { setDelBusy(false); }
  }

  async function resend() {
    setResending(true); setResendMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/ir/${r.id}/resend`), { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setR((x) => ({ ...x, line_sent_at: j.line_sent_at ?? new Date().toISOString() }));
      setResendMsg(res.ok && j.ok ? "ส่งรายงานเข้ากลุ่ม LINE ของทีมบริหารความเสี่ยงแล้ว" : humanizeApiError(j, "ส่งไม่สำเร็จ"));
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
      {r.severity >= 4 && (
        <div className="lg:col-span-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 flex items-center gap-3 text-sm text-rose-800">
          <Mascot pose="shock" size={64} className="flex-shrink-0" />
          <span>เหตุการณ์ระดับรุนแรง — ควรทบทวนและมอบผู้รับผิดชอบโดยเร็ว</span>
        </div>
      )}
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
                  {irCategoryGroupsFor(isClinic, [r.category]).map((g) => (
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
            <span className="text-xs text-slate-500">{resendMsg ?? (r.line_sent_at ? `ส่งเข้ากลุ่ม LINE ของทีมบริหารความเสี่ยงล่าสุดเมื่อ ${fmtSent(r.line_sent_at)}` : "ยังไม่ได้ส่งรายงานนี้เข้ากลุ่ม LINE ของทีมบริหารความเสี่ยง")}</span>
            <button type="button" className="btn btn-secondary text-sm" onClick={resend} disabled={resending}>
              {resending ? "กำลังส่ง…" : r.line_sent_at ? "ส่งอีกครั้ง" : "ส่งรายงาน"}
            </button>
          </div>
          {canDelete && (
            <div className="border-t border-slate-100 pt-3 space-y-2">
              {!delOpen ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">ลบเหตุการณ์นี้ออกจากระบบถาวร (เฉพาะผู้บริหารสูงสุด)</span>
                  <button type="button" className="btn btn-secondary text-sm text-rose-700" onClick={() => { setDelOpen(true); setDelPin(""); setDelErr(null); }}>ลบเหตุการณ์</button>
                </div>
              ) : (
                <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 space-y-2">
                  <div className="text-sm text-rose-800">ลบเหตุการณ์ {r.code ?? `#${r.id}`} ถาวร กู้คืนไม่ได้ กรุณาใส่ PIN เพื่อยืนยัน</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="password" inputMode="numeric" autoFocus placeholder="PIN" value={delPin} onChange={(e) => setDelPin(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && delPin && !delBusy) { e.preventDefault(); void remove(); } }}
                      className="border border-slate-300 rounded px-2 py-1 text-sm w-28 bg-white" />
                    <button type="button" className="btn btn-primary text-sm whitespace-nowrap" disabled={delBusy || !delPin} onClick={remove}>{delBusy ? "กำลังลบ…" : "ยืนยันลบ"}</button>
                    <button type="button" className="btn btn-secondary text-sm whitespace-nowrap" disabled={delBusy} onClick={() => setDelOpen(false)}>ยกเลิก</button>
                  </div>
                  {delErr && <div className="text-sm text-rose-700">{delErr}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
