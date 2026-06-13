// /admin/ascenda — KPI/OKR scorecard dashboard (Phase 4).
//
// Runs the auto-calculator engine on every page load so the
// attendance / COL / sales-growth cells are always fresh. Manual
// kinds (incidents / complaints / orders / COG) get inline-edit
// modals via DashboardClient — click an empty/existing cell, type
// the value, the API stores + the dashboard refreshes.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listKpis,
  listResultsForPeriod,
  computeScoreCard,
  currentPeriodKey,
  isAutoKind
} from "@/lib/ascenda";
import { runAutoCalculators } from "@/lib/ascenda-engine";
import DashboardClient from "./DashboardClient";

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

  // Fresh auto-computed values for this period on every render.
  // Cost is small (a few aggregate queries per branch) and idempotent
  // so it's fine to run on every navigation.
  runAutoCalculators(periodKey);

  const branches = db.prepare(
    "SELECT id, name FROM branches WHERE status != 'closed' ORDER BY display_order, name"
  ).all() as BranchRow[];
  // 2026-05-27 — owner direction "ASCENDA มีผลกับทุกบริษัท ทุกสาขา
  // แต่ให้พิจารณาแยกกัน": company-scope KPIs are evaluated per
  // company, not aggregated. Pull the company list so the client can
  // render a per-company column block parallel to the per-branch
  // matrix.
  const companies = db.prepare(
    "SELECT id, name_th AS name FROM companies WHERE active = 1 ORDER BY id"
  ).all() as Array<{ id: number; name: string }>;

  const branchKpis = listKpis("branch", true);
  const companyKpis = listKpis("company", true);
  const results = listResultsForPeriod(periodKey);

  // Pre-compute per-branch scorecards on the server so the client
  // doesn't reimplement the weighted-pass math.
  const branchScores = branches.map((b) => {
    const branchResults = results.filter((r) => r.branch_id === b.id);
    return { branch: b, score: computeScoreCard(branchKpis, branchResults) };
  });

  // Period chips — last 6 months.
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
          <div className="ml-auto flex items-center gap-3">
            <Link href="/admin/ascenda/daily"
              className="text-xs text-brand hover:underline">
              ยอดขาย + %COL รายวัน →
            </Link>
            <Link href="/admin/ascenda/revenue"
              className="text-xs text-brand hover:underline">
              กรอกยอดขาย →
            </Link>
            <Link href="/admin/ascenda/kpis"
              className="text-xs text-brand hover:underline">
              จัดการเกณฑ์ →
            </Link>
          </div>
        </div>
      </div>

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

      <DashboardClient
        periodKey={periodKey}
        branches={branches}
        companies={companies}
        branchKpis={branchKpis}
        companyKpis={companyKpis}
        results={results}
        branchScores={branchScores.map((bs) => ({
          branchId: bs.branch.id,
          branchName: bs.branch.name,
          percent: bs.score.percentScore,
          pass: bs.score.passCount,
          fail: bs.score.failCount,
          pending: bs.score.pendingCount
        }))}
        // The auto-kind set is computed here so the client can show
        // a "🔒 อัตโนมัติ" indicator + skip the edit modal for those.
        autoKindIds={branchKpis.concat(companyKpis)
          .filter((k) => isAutoKind(k.kind))
          .map((k) => k.id)}
      />

      <div className="card bg-slate-50 border-slate-200 text-[11px] text-slate-500 space-y-1">
        <div className="font-bold text-slate-600">เกร็ดการใช้งาน</div>
        <div>· คลิกที่ค่าในเซลล์เพื่อกรอก/แก้ผลรายเดือน (เฉพาะเกณฑ์ที่ต้องกรอกเอง)</div>
        <div>· เกณฑ์อัตโนมัติ (อัตราการขาดลามาสาย / COL % / ยอดขายโต) อัพเดทเองทุกครั้งที่เปิดหน้า</div>
        <div>· COL % กับ ยอดขายโต ต้องการให้พนักงานกรอกยอดขายในตอนปิดร้านถึงจะคำนวณได้</div>
      </div>
    </div>
  );
}
