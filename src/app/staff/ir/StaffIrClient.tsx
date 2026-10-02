"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { nameWithPrefix } from "@/lib/name";
import { severityMeta, statusMeta, categoryLabel, incidentTypeLabel, IR_OPEN_STATUSES } from "@/lib/ir-vocab";
import type { IrReportView } from "@/lib/ir-db";
import { fmtIrDateTime } from "@/app/components/ir/IrReportView";

type Scope = "mine" | "open" | "all";

export default function StaffIrClient({ reports, mine }: { reports: IrReportView[]; mine: number[] }) {
  const mineSet = useMemo(() => new Set(mine), [mine]);
  const [scope, setScope] = useState<Scope>(mine.length ? "mine" : "open");
  const list = useMemo(() => reports.filter((r) => {
    if (scope === "mine") return mineSet.has(r.id);
    if (scope === "open") return (IR_OPEN_STATUSES as string[]).includes(r.status);
    return true;
  }), [reports, scope, mineSet]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap text-sm">
        <Chip active={scope === "mine"} onClick={() => setScope("mine")}>ของฉัน ({mine.length})</Chip>
        <Chip active={scope === "open"} onClick={() => setScope("open")}>ค้างดำเนินการ</Chip>
        <Chip active={scope === "all"} onClick={() => setScope("all")}>ทั้งหมดของสาขา</Chip>
        <span className="text-xs text-slate-400 ml-auto">{list.length} รายการ</span>
      </div>
      {list.length === 0 ? (
        <div className="card text-sm text-slate-400">
          {scope === "mine" ? "คุณยังไม่มีรายงาน — ถ้ามีเหตุการณ์ กด “+ แจ้งเหตุการณ์”" : "ไม่มีรายการ"}
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((r) => {
            const sm = severityMeta(r.severity);
            const st = statusMeta(r.status);
            const isMine = mineSet.has(r.id);
            return (
              <Link key={r.id} href={`/staff/ir/${r.id}`}
                className={`card !p-3.5 flex items-start gap-3 hover:border-brand/40 transition-colors group ${isMine ? "border-brand/30" : ""}`}>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${sm.tone}`}>{sm.labelTh}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-slate-400 tabular-nums">{r.code ?? `#${r.id}`}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.tone}`}>{st.labelTh}</span>
                    <span className="text-[11px] text-slate-400">{categoryLabel(r.category)}</span>
                    {isMine && <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/10 text-brand">ของฉัน</span>}
                  </div>
                  <div className="text-sm text-slate-700 group-hover:text-brand mt-0.5 line-clamp-2">{r.description}</div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    {fmtIrDateTime(r.occurred_at)} · {incidentTypeLabel(r.incident_type)} ·{" "}
                    {r.is_anonymous ? "ไม่ระบุผู้แจ้ง" : (r.reporter_name ? nameWithPrefix(r.reporter_prefix, r.reporter_name) : "—")}
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

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
        active ? "bg-brand text-white border-brand" : "bg-white text-slate-600 border-slate-200 hover:border-brand/40"}`}>
      {children}
    </button>
  );
}
