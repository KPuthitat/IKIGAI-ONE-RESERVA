"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { nameWithPrefix } from "@/lib/name";
import IrReportForm, { type ColleagueOption } from "@/app/components/ir/IrReportForm";
import {
  IR_SEVERITIES, IR_STATUSES, IR_CATEGORY_GROUPS,
  severityMeta, statusMeta, categoryLabel, incidentTypeLabel
} from "@/lib/ir-vocab";
import type { IrReportView } from "@/lib/ir-db";

function fmtOccurred(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("th-TH", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ReportsClient({ initialReports, colleagues, selfUserId }: {
  initialReports: IrReportView[]; colleagues: ColleagueOption[]; selfUserId: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [reports] = useState<IrReportView[]>(initialReports);
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

      {/* The SAME detailed form staff use (owner 2026-10-01) — facts, 5 Whys,
          factors, recommendations, people. Lands on the new report's page. */}
      {showForm && (
        <IrReportForm
          apiBase="/api/admin/ir"
          guideHref="/admin/ir/guide"
          colleagues={colleagues}
          selfUserId={selfUserId}
          onDone={(r) => { router.push(`/admin/ir/${r.id}`); router.refresh(); }}
          onCancel={() => setShowForm(false)}
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
