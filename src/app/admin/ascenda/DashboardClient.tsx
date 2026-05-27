"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
// Client component — import from ascenda-types (no DB / better-sqlite3
// in the browser bundle). The server-side variant @/lib/ascenda
// transitively pulls getDb which webpack can't resolve for the browser.
import type { AscendaKpi, AscendaResult, ResultStatus } from "@/lib/ascenda-types";
import { evaluateStatus, statusLabelTh } from "@/lib/ascenda-types";

// Interactive dashboard wrapper. Server page does the heavy lifting
// (engine run + queries); this component just renders + handles the
// inline-edit modal for manual-kind cells. Clicking an auto cell
// shows a hint instead of opening the modal (those refresh on page
// load — no manual override).

type BranchScore = {
  branchId: number;
  branchName: string;
  percent: number;
  pass: number;
  fail: number;
  pending: number;
};

export default function DashboardClient({
  periodKey,
  branches,
  companies,
  branchKpis,
  companyKpis,
  results,
  branchScores,
  autoKindIds
}: {
  periodKey: string;
  branches: Array<{ id: number; name: string }>;
  companies: Array<{ id: number; name: string }>;
  branchKpis: AscendaKpi[];
  companyKpis: AscendaKpi[];
  results: AscendaResult[];
  branchScores: BranchScore[];
  autoKindIds: number[];
}) {
  const router = useRouter();
  const [edit, setEdit] = useState<
    | {
        kpi: AscendaKpi;
        branchId: number | null;
        companyId: number | null;
        current: AscendaResult | null;
      }
    | null
  >(null);

  const autoSet = useMemo(() => new Set(autoKindIds), [autoKindIds]);

  // Index results by (kpi_id, branch_id, company_id) for O(1) cell
  // lookup. Composite key handles both scope kinds — branch-scope
  // rows have company_id=null and vice versa, so the key shape
  // distinguishes them cleanly.
  const resultMap = useMemo(() => {
    const m = new Map<string, AscendaResult>();
    for (const r of results) {
      m.set(`${r.kpi_id}:b${r.branch_id ?? "_"}:c${r.company_id ?? "_"}`, r);
    }
    return m;
  }, [results]);

  const keyFor = (kpiId: number, branchId: number | null, companyId: number | null) =>
    `${kpiId}:b${branchId ?? "_"}:c${companyId ?? "_"}`;

  function onCellClick(kpi: AscendaKpi, branchId: number | null, companyId: number | null) {
    if (autoSet.has(kpi.id)) return; // auto cells are read-only
    const current = resultMap.get(keyFor(kpi.id, branchId, companyId)) ?? null;
    setEdit({ kpi, branchId, companyId, current });
  }

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {branchScores.map((bs) => (
          <ScoreCardChip key={bs.branchId} {...bs} />
        ))}
      </div>

      {/* ระดับบริษัท — one column per company, evaluated separately.
          Owner direction 2026-05-27: every company gets its own
          assessment row rather than aggregating to one global. */}
      {companyKpis.length > 0 && companies.length > 0 && (
        <div className="card overflow-x-auto mt-4">
          <div className="font-bold text-slate-700 text-sm uppercase tracking-[0.5px] mb-3">
            ระดับบริษัท
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left">
                <th className="py-2 pr-3 font-semibold text-slate-600 min-w-[200px]">เกณฑ์</th>
                <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-16">น้ำหนัก</th>
                {companies.map((c) => (
                  <th key={c.id}
                    className="py-2 pr-3 font-semibold text-slate-600 text-center min-w-[160px]">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {companyKpis.map((k) => {
                const isAuto = autoSet.has(k.id);
                return (
                  <tr key={k.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-800 flex items-center gap-1.5">
                        {k.title}
                        {isAuto && (
                          <span className="text-[9px] bg-slate-200 text-slate-600 rounded px-1 py-0.5">
                            อัตโนมัติ
                          </span>
                        )}
                      </div>
                      {k.target_value != null && k.target_op && (
                        <div className="text-[10px] text-slate-400">
                          เป้า {k.target_op === "lte" ? "≤" : k.target_op === "gte" ? "≥" : "="}
                          {" "}{k.target_value}{k.unit ?? ""}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-center text-slate-500">×{k.weight}</td>
                    {companies.map((c) => {
                      const r = resultMap.get(keyFor(k.id, null, c.id)) ?? null;
                      return (
                        <td key={c.id} className="py-2 pr-3 text-center">
                          <Cell kpi={k} result={r} isAuto={isAuto}
                            onClick={() => onCellClick(k, null, c.id)} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card overflow-x-auto mt-4">
        <div className="font-bold text-slate-700 text-sm uppercase tracking-[0.5px] mb-3">
          ระดับสาขา
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="py-2 pr-3 font-semibold text-slate-600 min-w-[200px]">เกณฑ์</th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-16">น้ำหนัก</th>
              {branches.map((b) => (
                <th key={b.id}
                  className="py-2 pr-3 font-semibold text-slate-600 text-center min-w-[120px]">
                  {b.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {branchKpis.map((k) => {
              const isAuto = autoSet.has(k.id);
              return (
                <tr key={k.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5">
                      {k.title}
                      {isAuto && (
                        <span className="text-[9px] bg-slate-200 text-slate-600 rounded px-1 py-0.5">
                          อัตโนมัติ
                        </span>
                      )}
                    </div>
                    {k.target_value != null && k.target_op && (
                      <div className="text-[10px] text-slate-400">
                        เป้า {k.target_op === "lte" ? "≤" : k.target_op === "gte" ? "≥" : "="}
                        {" "}{k.target_value}{k.unit ?? ""}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-center text-slate-500">×{k.weight}</td>
                  {branches.map((b) => {
                    const r = resultMap.get(keyFor(k.id, b.id, null)) ?? null;
                    return (
                      <td key={b.id} className="py-2 pr-3 text-center">
                        <Cell kpi={k} result={r} isAuto={isAuto}
                          onClick={() => onCellClick(k, b.id, null)} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {branchKpis.length === 0 && (
              <tr>
                <td colSpan={branches.length + 2} className="py-6 text-center text-slate-400">
                  ยังไม่มีเกณฑ์ระดับสาขา
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {edit && (
        <EditModal
          kpi={edit.kpi}
          branchId={edit.branchId}
          companyId={edit.companyId}
          periodKey={periodKey}
          current={edit.current}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function ScoreCardChip({
  branchName, percent, pass, fail, pending
}: BranchScore) {
  const tone = percent >= 80 ? "emerald" : percent >= 60 ? "amber" : "rose";
  const cls = tone === "emerald" ? "bg-emerald-50 border-emerald-200 text-emerald-800"
    : tone === "amber" ? "bg-amber-50 border-amber-200 text-amber-800"
    : "bg-rose-50 border-rose-200 text-rose-800";
  return (
    <div className={`rounded-xl border-[1.5px] px-4 py-3 ${cls}`}>
      <div className="text-[10px] uppercase tracking-[0.5px] font-bold opacity-70">
        {branchName}
      </div>
      <div className="text-2xl font-bold mt-1 font-mono tabular-nums">
        {percent.toFixed(1)}%
      </div>
      <div className="text-[10px] mt-0.5 opacity-80">
        ผ่าน {pass} · ไม่ผ่าน {fail} · รอ {pending}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ResultStatus }) {
  const cls = status === "pass"
    ? "bg-emerald-100 text-emerald-700"
    : status === "fail"
      ? "bg-rose-100 text-rose-700"
      : status === "pending"
        ? "bg-slate-200 text-slate-500"
        : "bg-slate-100 text-slate-400";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${cls}`}>
      {statusLabelTh(status)}
    </span>
  );
}

function Cell({
  kpi, result, isAuto, onClick
}: {
  kpi: AscendaKpi;
  result: AscendaResult | null;
  isAuto: boolean;
  onClick: () => void;
}) {
  const status = result?.status ?? evaluateStatus(
    result?.actual_value ?? null, kpi.target_value, kpi.target_op
  );
  const empty = !result || result.actual_value == null;
  const className = isAuto
    ? "cursor-default"
    : "cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1 py-0.5";
  return (
    <button type="button" onClick={onClick}
      disabled={isAuto && empty}
      className={`${className} block w-full text-center`}>
      {empty ? (
        <span className={isAuto ? "text-slate-300" : "text-brand text-[10px]"}>
          {isAuto ? "—" : "+ กรอก"}
        </span>
      ) : (
        <div className="space-y-0.5">
          <div className="font-mono tabular-nums font-medium text-slate-800">
            {result!.actual_value!.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            {kpi.unit ?? ""}
          </div>
          <StatusPill status={status} />
        </div>
      )}
    </button>
  );
}

function KpiRow({
  kpi, result, isAuto, onClick
}: {
  kpi: AscendaKpi;
  result: AscendaResult | null;
  isAuto: boolean;
  onClick: () => void;
}) {
  const status = result?.status ?? evaluateStatus(
    result?.actual_value ?? null, kpi.target_value, kpi.target_op
  );
  const empty = !result || result.actual_value == null;
  return (
    <button type="button"
      onClick={onClick}
      disabled={isAuto && empty}
      className={`flex items-center justify-between gap-3 text-sm w-full text-left ${
        isAuto ? "" : "hover:bg-slate-50 rounded px-2 -mx-2 py-1 cursor-pointer"
      }`}>
      <div className="flex-1">
        <div className="font-medium text-slate-800 flex items-center gap-1.5">
          {kpi.title}
          {isAuto && (
            <span className="text-[9px] bg-slate-200 text-slate-600 rounded px-1 py-0.5">
              อัตโนมัติ
            </span>
          )}
        </div>
        {kpi.target_value != null && kpi.target_op && (
          <div className="text-[10px] text-slate-400">
            เป้า {kpi.target_op === "lte" ? "≤" : kpi.target_op === "gte" ? "≥" : "="}
            {" "}{kpi.target_value}{kpi.unit ?? ""} · น้ำหนัก ×{kpi.weight}
          </div>
        )}
      </div>
      <div className="text-right">
        {empty ? (
          <span className={isAuto ? "text-slate-300" : "text-brand text-[11px]"}>
            {isAuto ? "—" : "+ กรอก"}
          </span>
        ) : (
          <>
            <div className="font-mono tabular-nums font-medium text-slate-800">
              {result!.actual_value!.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              {kpi.unit ?? ""}
            </div>
            <StatusPill status={status} />
          </>
        )}
      </div>
    </button>
  );
}

function EditModal({
  kpi, branchId, companyId, periodKey, current, onClose, onSaved
}: {
  kpi: AscendaKpi;
  branchId: number | null;
  companyId: number | null;
  periodKey: string;
  current: AscendaResult | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(
    current?.actual_value != null ? String(current.actual_value) : ""
  );
  const [notes, setNotes] = useState(current?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(clearIt = false) {
    setErr(null);
    let actual: number | null = null;
    if (!clearIt) {
      if (value.trim() === "") {
        setErr("กรอกค่าหรือกด \"ล้างค่า\"");
        return;
      }
      const n = Number(value);
      if (!isFinite(n) || n < 0) {
        setErr("ใส่ตัวเลข ≥ 0 เท่านั้น");
        return;
      }
      actual = n;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/ascenda/results"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kpi_id: kpi.id,
          branch_id: branchId,
          company_id: companyId,
          period_key: periodKey,
          actual_value: actual,
          notes: notes.trim() || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.message || j.error || "บันทึกไม่สำเร็จ");
        return;
      }
      onSaved();
    } catch {
      setErr("เกิดข้อผิดพลาดเครือข่าย");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-card">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-800">{kpi.title}</h2>
              <div className="text-xs text-slate-500 mt-0.5">
                {periodKey} · {kpi.scope === "branch" ? "ระดับสาขา" : "ระดับบริษัท"}
                {kpi.target_value != null && kpi.target_op && (
                  <> · เป้า {kpi.target_op === "lte" ? "≤" : kpi.target_op === "gte" ? "≥" : "="}
                    {" "}{kpi.target_value}{kpi.unit ?? ""}</>
                )}
              </div>
            </div>
            <button type="button" onClick={onClose}
              className="text-slate-400 hover:text-slate-600">✕</button>
          </div>

          <div>
            <label className="label">ค่าจริง{kpi.unit ? ` (${kpi.unit})` : ""}</label>
            <input
              type="number" inputMode="decimal" step="0.01" min={0}
              autoFocus
              className="input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
            />
          </div>

          <div>
            <label className="label">บันทึก (ไม่บังคับ)</label>
            <textarea className="input" rows={2} maxLength={500}
              value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="คำอธิบายเพิ่มเติม" />
          </div>

          {err && <div className="text-sm text-rose-600 text-center">✗ {err}</div>}

          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              ยกเลิก
            </button>
            {current?.actual_value != null && (
              <button type="button" onClick={() => save(true)} disabled={busy}
                className="btn-secondary text-rose-600">
                ล้างค่า
              </button>
            )}
            <button type="button" onClick={() => save(false)} disabled={busy}
              className="btn-primary flex-1">
              {busy ? "กำลังบันทึก…" : "บันทึก"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
