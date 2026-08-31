"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { nameWithPrefix } from "@/lib/name";
import { FormSection, Field } from "@/app/components/FormKit";
import {
  IR_SEVERITIES, IR_STATUSES, IR_INCIDENT_TYPES, IR_CATEGORY_GROUPS,
  severityMeta, statusMeta, categoryLabel, incidentTypeLabel,
  type IrSeverity, type IrIncidentType
} from "@/lib/ir-vocab";
import type { IrReportView } from "@/lib/ir-db";

// datetime-local value → the same wall-clock as an ISO-ish string the API
// stores verbatim (occurred_at). We keep it simple: "YYYY-MM-DDTHH:mm".
function nowLocalInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtOccurred(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ReportsClient({ initialReports }: { initialReports: IrReportView[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [reports, setReports] = useState<IrReportView[]>(initialReports);
  const [showForm, setShowForm] = useState(params.get("new") === "1");

  const [fStatus, setFStatus] = useState<string>("open");
  const [fSeverity, setFSeverity] = useState<number | 0>(0);
  const [fCategory, setFCategory] = useState<string>("");

  const filtered = useMemo(() => reports.filter((r) => {
    if (fStatus === "open" && !["new", "reviewing", "action"].includes(r.status)) return false;
    if (fStatus !== "open" && fStatus !== "all" && r.status !== fStatus) return false;
    if (fSeverity && r.severity !== fSeverity) return false;
    if (fCategory && r.category !== fCategory) return false;
    return true;
  }), [reports, fStatus, fSeverity, fCategory]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap text-sm">
          {/* status filter */}
          <FilterChip active={fStatus === "open"} onClick={() => setFStatus("open")}>ค้างดำเนินการ</FilterChip>
          <FilterChip active={fStatus === "all"} onClick={() => setFStatus("all")}>ทั้งหมด</FilterChip>
          {IR_STATUSES.map((s) => (
            <FilterChip key={s.value} active={fStatus === s.value} onClick={() => setFStatus(s.value)}>{s.labelTh}</FilterChip>
          ))}
        </div>
        <button type="button" className="btn btn-primary text-sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "ปิดฟอร์ม" : "+ แจ้งเหตุการณ์"}
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <select className="input !py-1.5 !w-auto text-xs" value={fSeverity} onChange={(e) => setFSeverity(Number(e.target.value))}>
          <option value={0}>ทุกระดับ</option>
          {IR_SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.value} · {s.labelTh}</option>)}
        </select>
        <select className="input !py-1.5 !w-auto text-xs" value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
          <option value="">ทุกหมวด</option>
          {IR_CATEGORY_GROUPS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((it) => <option key={it.key} value={it.key}>{it.labelTh}</option>)}
            </optgroup>
          ))}
        </select>
        <span className="text-slate-400">{filtered.length} รายการ</span>
      </div>

      {showForm && (
        <NewReportForm
          onDone={(refreshed) => { setReports(refreshed); setShowForm(false); router.refresh(); }}
        />
      )}

      {filtered.length === 0 ? (
        <div className="card text-sm text-slate-400">ไม่มีเหตุการณ์ตามตัวกรองนี้</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => {
            const sm = severityMeta(r.severity);
            const st = statusMeta(r.status);
            return (
              <Link key={r.id} href={`/admin/ir/${r.id}`}
                className="card !p-3.5 flex items-start gap-3 hover:border-brand/40 transition-colors group">
                <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${sm.tone}`}>{sm.labelTh}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-slate-400 tabular-nums">{r.code ?? `#${r.id}`}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.tone}`}>{st.labelTh}</span>
                    <span className="text-[11px] text-slate-400">{categoryLabel(r.category)}</span>
                  </div>
                  <div className="text-sm text-slate-700 group-hover:text-brand mt-0.5 line-clamp-2">{r.description}</div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    {fmtOccurred(r.occurred_at)} · {incidentTypeLabel(r.incident_type)}
                    {" · "}
                    {r.is_anonymous ? "ไม่ระบุผู้แจ้ง" : (r.reporter_name ? nameWithPrefix(r.reporter_prefix, r.reporter_name) : "—")}
                    {r.assignee_name ? ` · ผู้รับผิดชอบ: ${nameWithPrefix(r.assignee_prefix, r.assignee_name)}` : ""}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
        active ? "bg-brand text-white border-brand" : "bg-white text-slate-600 border-slate-200 hover:border-brand/40"}`}>
      {children}
    </button>
  );
}

function NewReportForm({ onDone }: { onDone: (refreshed: IrReportView[]) => void }) {
  const [occurredAt, setOccurredAt] = useState(nowLocalInput());
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState(IR_CATEGORY_GROUPS[0].items[0].key);
  const [incidentType, setIncidentType] = useState<IrIncidentType>("actual");
  const [severity, setSeverity] = useState<IrSeverity>(2);
  const [description, setDescription] = useState("");
  const [immediate, setImmediate] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!description.trim()) { setErr("กรุณากรอกรายละเอียดเหตุการณ์"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/ir"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          occurred_at: occurredAt,
          location_detail: location.trim() || undefined,
          category, incident_type: incidentType, severity,
          description: description.trim(),
          immediate_action: immediate.trim() || undefined,
          anonymous
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "บันทึกไม่สำเร็จ")); return; }
      onDone(j.reports as IrReportView[]);
    } catch {
      setErr("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  const sevMeta = severityMeta(severity);

  return (
    <div className="card space-y-4">
      <FormSection title="แจ้งเหตุการณ์ / ความเสี่ยง">
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="เกิดขึ้นเมื่อ">
            <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </Field>
          <Field label="จุดเกิดเหตุ" hint="ถ้ามี">
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="เช่น ครัว / ห้องหัตถการ / หน้าร้าน" />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="หมวดเหตุการณ์">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {IR_CATEGORY_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.items.map((it) => <option key={it.key} value={it.key}>{it.labelTh}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="ชนิด">
            <select value={incidentType} onChange={(e) => setIncidentType(e.target.value as IrIncidentType)}>
              {IR_INCIDENT_TYPES.map((it) => <option key={it.value} value={it.value}>{it.labelTh}</option>)}
            </select>
          </Field>
        </div>
      </FormSection>

      <FormSection title="ระดับความรุนแรง">
        <div className="flex flex-wrap gap-1.5">
          {IR_SEVERITIES.map((s) => (
            <button type="button" key={s.value} onClick={() => setSeverity(s.value)}
              className={`px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
                severity === s.value ? s.tone + " ring-1 ring-current font-semibold" : "bg-white text-slate-600 border-slate-200 hover:border-brand/40"}`}>
              {s.value} · {s.labelTh}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400">{sevMeta.descTh}</p>
      </FormSection>

      <FormSection title="รายละเอียด">
        <Field label="เกิดอะไรขึ้น">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="อธิบายเหตุการณ์ตามจริง ใคร ทำอะไร ที่ไหน ผลเป็นอย่างไร" />
        </Field>
        <Field label="แก้ไขเฉพาะหน้าไปแล้วอย่างไร" hint="ถ้ามี">
          <textarea rows={2} value={immediate} onChange={(e) => setImmediate(e.target.value)}
            placeholder="เช่น ปฐมพยาบาล / เปลี่ยนของ / แจ้งหัวหน้า" />
        </Field>
      </FormSection>

      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="w-4 h-4" />
        แจ้งโดยไม่ระบุตัวตน (ระบบจะไม่บันทึกว่าใครเป็นผู้แจ้ง)
      </label>

      {err && <div className="text-sm text-rose-600">{err}</div>}
      <div className="flex justify-end">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? "กำลังบันทึก…" : "ส่งรายงาน"}
        </button>
      </div>
    </div>
  );
}
