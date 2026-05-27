// /admin/ascenda — KPI/OKR scorecard dashboard.
//
// Phase 1 deliverable: read-only view of the current month's KPI
// results per branch + the company-scope KPIs. Admin can click into
// each branch column to see the breakdown (Phase 4 — entry/edit).
// "จัดการเกณฑ์" link goes to the KPI management page (Phase 2).
//
// Layout: one table per branch column, KPIs as rows. Each cell shows
// actual value + pass/fail pill. Company-scope KPIs render in a
// separate small card above so the executive can see the cross-branch
// metric at a glance.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listKpis,
  listResultsForPeriod,
  computeScoreCard,
  currentPeriodKey,
  statusLabelTh,
  evaluateStatus,
  type AscendaKpi,
  type AscendaResult,
  type ResultStatus
} from "@/lib/ascenda";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ASCENDA · KPI" };

type BranchRow = { id: number; name: string };

export default function AdminAscendaPage({
  searchParams
}: {
  searchParams: { period?: string };
}) {
  requireAdmin();
  const db = getDb();
  const periodKey = searchParams.period || currentPeriodKey();

  const branches = db.prepare(
    "SELECT id, name FROM branches WHERE status != 'closed' ORDER BY display_order, name"
  ).all() as BranchRow[];

  const branchKpis = listKpis("branch", true);
  const companyKpis = listKpis("company", true);
  const results = listResultsForPeriod(periodKey);

  // Index results by (kpi_id, branch_id) for O(1) cell lookup.
  // Company-scope cells key by (kpi_id, null).
  const resultMap = new Map<string, AscendaResult>();
  for (const r of results) {
    resultMap.set(`${r.kpi_id}:${r.branch_id ?? "_"}`, r);
  }

  // Recent-month chips for quick navigation. Buddhist year for the
  // human label since that's how the rest of the system reads dates.
  const TH_MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                     "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const periodOptions: Array<{ key: string; label: string }> = [];
  for (let i = 0; i < 6; i++) {
    const [y, m] = currentPeriodKey().split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    periodOptions.push({
      key: k,
      label: `${TH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`
    });
  }

  // Per-branch scorecard for the header strip.
  const branchScores = branches.map((b) => {
    const branchResults = results.filter((r) => r.branch_id === b.id);
    return { branch: b, score: computeScoreCard(branchKpis, branchResults) };
  });

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ
        </Link>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 mt-2">
          <h1 className="text-2xl font-bold text-slate-800">ASCENDA</h1>
          <p className="text-sm text-slate-500">
            ประเมิน KPI / OKR รายเดือนของบริษัท
          </p>
          <div className="ml-auto">
            <Link href="/admin/ascenda/kpis"
              className="text-xs text-brand hover:underline">
              จัดการเกณฑ์ →
            </Link>
          </div>
        </div>
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap gap-1.5">
        {periodOptions.map((p) => (
          <Link
            key={p.key}
            href={`/admin/ascenda?period=${p.key}`}
            className={`text-xs px-3 py-1.5 rounded-full border ${
              p.key === periodKey
                ? "bg-brand text-white border-brand"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </div>

      {/* Per-branch score strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {branchScores.map((bs) => (
          <ScoreCardChip key={bs.branch.id}
            branchName={bs.branch.name}
            percent={bs.score.percentScore}
            pass={bs.score.passCount}
            fail={bs.score.failCount}
            pending={bs.score.pendingCount}
          />
        ))}
      </div>

      {/* Company-scope KPIs */}
      {companyKpis.length > 0 && (
        <div className="card space-y-3">
          <div className="font-bold text-slate-700 text-sm uppercase tracking-[0.5px]">
            ระดับบริษัท
          </div>
          {companyKpis.map((k) => (
            <KpiRow
              key={k.id}
              kpi={k}
              result={resultMap.get(`${k.id}:_`) ?? null}
            />
          ))}
        </div>
      )}

      {/* Per-branch KPI matrix */}
      <div className="card overflow-x-auto">
        <div className="font-bold text-slate-700 text-sm uppercase tracking-[0.5px] mb-3">
          ระดับสาขา
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="py-2 pr-3 font-semibold text-slate-600 min-w-[200px]">
                เกณฑ์
              </th>
              <th className="py-2 pr-3 font-semibold text-slate-600 text-center w-16">
                น้ำหนัก
              </th>
              {branches.map((b) => (
                <th key={b.id}
                  className="py-2 pr-3 font-semibold text-slate-600 text-center min-w-[120px]">
                  {b.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {branchKpis.map((k) => (
              <tr key={k.id} className="border-b border-slate-100 last:border-b-0">
                <td className="py-2 pr-3">
                  <div className="font-medium text-slate-800">{k.title}</div>
                  {k.target_value != null && k.target_op && (
                    <div className="text-[10px] text-slate-400">
                      เป้า {k.target_op === "lte" ? "≤" : k.target_op === "gte" ? "≥" : "="}
                      {" "}{k.target_value}{k.unit ?? ""}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 text-center text-slate-500">
                  ×{k.weight}
                </td>
                {branches.map((b) => {
                  const r = resultMap.get(`${k.id}:${b.id}`) ?? null;
                  return (
                    <td key={b.id} className="py-2 pr-3 text-center">
                      <Cell kpi={k} result={r} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {branchKpis.length === 0 && (
              <tr>
                <td colSpan={branches.length + 2}
                  className="py-6 text-center text-slate-400">
                  ยังไม่มีเกณฑ์ — เพิ่มที่หน้า{" "}
                  <Link href="/admin/ascenda/kpis"
                    className="text-brand hover:underline">
                    จัดการเกณฑ์
                  </Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card bg-slate-50 border-slate-200 text-[11px] text-slate-500 space-y-1">
        <div className="font-bold text-slate-600">หมายเหตุ Phase 1</div>
        <div>· หน้านี้เป็น read-only view ยังกรอกผลไม่ได้ — รอ Phase 4</div>
        <div>· เกณฑ์ทั้ง 7 ที่ระบบ seed ให้ ปรับ/ลบได้ที่ &quot;จัดการเกณฑ์&quot; (Phase 2)</div>
        <div>· COL % กับ Sales growth % จะคำนวณเองอัตโนมัติเมื่อมียอดขายในระบบ (Phase 3 ผูกกับ shift_close)</div>
      </div>
    </div>
  );
}

function ScoreCardChip({
  branchName, percent, pass, fail, pending
}: {
  branchName: string; percent: number; pass: number; fail: number; pending: number;
}) {
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

function Cell({ kpi, result }: { kpi: AscendaKpi; result: AscendaResult | null }) {
  if (!result || result.actual_value == null) {
    return <span className="text-slate-300">—</span>;
  }
  const status = result.status ?? evaluateStatus(
    result.actual_value, kpi.target_value, kpi.target_op
  );
  return (
    <div className="space-y-0.5">
      <div className="font-mono tabular-nums font-medium text-slate-800">
        {result.actual_value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        {kpi.unit ?? ""}
      </div>
      <StatusPill status={status} />
    </div>
  );
}

function KpiRow({ kpi, result }: { kpi: AscendaKpi; result: AscendaResult | null }) {
  const status = result?.status ?? evaluateStatus(
    result?.actual_value ?? null, kpi.target_value, kpi.target_op
  );
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="flex-1">
        <div className="font-medium text-slate-800">{kpi.title}</div>
        {kpi.target_value != null && kpi.target_op && (
          <div className="text-[10px] text-slate-400">
            เป้า {kpi.target_op === "lte" ? "≤" : kpi.target_op === "gte" ? "≥" : "="}
            {" "}{kpi.target_value}{kpi.unit ?? ""} · น้ำหนัก ×{kpi.weight}
          </div>
        )}
      </div>
      <div className="text-right">
        <div className="font-mono tabular-nums font-medium text-slate-800">
          {result?.actual_value != null
            ? `${result.actual_value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${kpi.unit ?? ""}`
            : "—"}
        </div>
        <StatusPill status={status} />
      </div>
    </div>
  );
}
