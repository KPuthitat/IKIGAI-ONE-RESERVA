"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { STAGE_META, type ApplicationStage } from "@/lib/recruita";
import type { ApplicationRow } from "./page";

type PositionOption = {
  id: number;
  title: string;
  code: string | null;
  application_count: number;
};

const ALL_STAGES: ApplicationStage[] = [
  "applied", "screening", "interview", "offered",
  "accepted", "hired", "rejected", "withdrawn"
];

export default function ApplicationsListClient({
  rows, positions
}: {
  rows: ApplicationRow[];
  positions: PositionOption[];
}) {
  const [q, setQ] = useState("");
  const [positionFilter, setPositionFilter] = useState<string>("");
  const [stageFilter, setStageFilter] = useState<ApplicationStage | "">("");

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (positionFilter && String(r.position_id) !== positionFilter) return false;
      if (stageFilter && r.stage !== stageFilter) return false;
      if (!term) return true;
      const fields = [
        r.first_name_th, r.last_name_th, r.nickname_th,
        r.mobile_phone, r.personal_email,
        r.position_title, r.position_code,
        r.info_source
      ];
      return fields.some((v) => (v ?? "").toLowerCase().includes(term));
    });
  }, [rows, q, positionFilter, stageFilter]);

  const activeFilters = (positionFilter ? 1 : 0) + (stageFilter ? 1 : 0);

  function clearFilters() {
    setQ(""); setPositionFilter(""); setStageFilter("");
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="card space-y-3">
        <input className="input" value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นชื่อ / เบอร์ / อีเมล / ตำแหน่ง" />
        <div className="flex flex-wrap gap-2 items-center text-xs">
          <label className="flex items-center gap-1">
            <span className="text-slate-500">ตำแหน่ง:</span>
            <select className="input !py-1 !px-2 !w-auto text-xs"
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value)}>
              <option value="">— ทั้งหมด —</option>
              {positions.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.code ? `[${p.code}] ` : ""}{p.title} ({p.application_count})
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-slate-500">สถานะ:</span>
            <select className="input !py-1 !px-2 !w-auto text-xs"
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value as ApplicationStage | "")}>
              <option value="">— ทั้งหมด —</option>
              {ALL_STAGES.map((s) => (
                <option key={s} value={s}>{STAGE_META[s].label}</option>
              ))}
            </select>
          </label>
          {(activeFilters > 0 || q) && (
            <button type="button" onClick={clearFilters}
              className="ml-auto text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
              ล้าง
            </button>
          )}
          <span className="text-slate-400">แสดง {filtered.length} / {rows.length} รายการ</span>
        </div>
      </div>

      {/* List */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="card text-sm text-slate-400 text-center py-8">
            ไม่พบใบสมัครตามเงื่อนไข
          </div>
        )}
        {filtered.map((r) => {
          const meta = STAGE_META[r.stage];
          const name = [r.first_name_th, r.last_name_th].filter(Boolean).join(" ") || "—";
          const nick = r.nickname_th ? ` (${r.nickname_th})` : "";
          return (
            <Link key={r.id} href={`/admin/recruita/applications/${r.id}`}
              className="card hover:shadow-md transition flex flex-col sm:flex-row gap-2 sm:items-center">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-700 text-sm">#{r.id}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${meta.chip}`}>
                    {meta.label}
                  </span>
                  <span className="font-bold text-slate-800">{name}{nick}</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {r.position_code ? `[${r.position_code}] ` : ""}{r.position_title}
                  {r.branch_name && <> · <span className="font-semibold">{r.branch_name}</span></>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-x-3 gap-y-1 flex-wrap">
                  {r.mobile_phone && <span>{r.mobile_phone}</span>}
                  {r.personal_email && <span>{r.personal_email}</span>}
                  {r.expected_salary != null && (
                    <span className="text-emerald-700">฿{r.expected_salary.toLocaleString("th-TH")}</span>
                  )}
                  {r.info_source && <span className="text-slate-400">ทราบจาก: {r.info_source}</span>}
                </div>
              </div>
              <div className="text-[11px] text-slate-400 flex-shrink-0">
                {r.submitted_at.slice(0, 16).replace("T", " ")}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
