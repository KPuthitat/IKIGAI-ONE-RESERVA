// /admin/ascenda/daily — daily sales + %COL dashboard (owner 2026-06-13).
// Read-only management view: per day, recorded sales vs actual labour cost
// (clocked hours × rate) → %COL. Gated by the ascenda layout
// (requirePermission "ascenda.view"). Branch is chosen via ?branch=.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getDailyColRows } from "@/lib/daily-col";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ASCENDA · ยอดขาย + %COL รายวัน" };

type BranchRow = { id: number; name: string };

const TH_MONTHS_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."
];

function fmtBaht(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtThaiDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return `${d} ${TH_MONTHS_ABBR[m - 1]} ${(y + 543) % 100}`;
}

export default function AscendaDailyPage({
  searchParams
}: {
  searchParams: { branch?: string };
}) {
  requireAdmin();
  const db = getDb();

  const branches = db
    .prepare("SELECT id, name FROM branches WHERE status != 'closed' ORDER BY display_order, name")
    .all() as BranchRow[];

  const branchId = searchParams.branch
    ? Number(searchParams.branch)
    : branches[0]?.id ?? null;

  const rows = branchId != null ? getDailyColRows(branchId, 30) : [];

  // Headline: average %COL over the days that have a revenue figure.
  const withCol = rows.filter((r) => r.colPct != null);
  const avgCol =
    withCol.length > 0
      ? Math.round((withCol.reduce((s, r) => s + (r.colPct ?? 0), 0) / withCol.length) * 10) / 10
      : null;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/ascenda" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ASCENDA
        </Link>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 mt-2">
          <h1 className="text-2xl font-bold text-slate-800">ยอดขาย + %COL รายวัน</h1>
          <p className="text-sm text-slate-500">
            ค่าแรงจริง (ลงเวลา) เทียบยอดขายแต่ละวัน · 30 วันล่าสุด
          </p>
          <Link href="/admin/ascenda/revenue" className="ml-auto text-xs text-brand hover:underline">
            กรอกยอดขาย →
          </Link>
        </div>
      </div>

      {/* Branch chips */}
      {branches.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {branches.map((b) => {
            const active = b.id === branchId;
            return (
              <Link
                key={b.id}
                href={`/admin/ascenda/daily?branch=${b.id}`}
                className={`text-xs px-3 py-1.5 rounded-full border ${
                  active
                    ? "bg-brand text-white border-brand"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {b.name}
              </Link>
            );
          })}
        </div>
      )}

      {/* Headline average */}
      <div className="card flex items-center gap-3">
        <span className="text-3xl font-bold tabular-nums text-slate-800">
          {avgCol != null ? `${avgCol}%` : "—"}
        </span>
        <div className="text-sm">
          <div className="font-bold text-slate-800">%COL เฉลี่ย (30 วัน)</div>
          <div className="text-xs text-slate-500">
            คิดจากวันที่มีบันทึกยอดขายแล้ว {withCol.length} วัน
          </div>
        </div>
      </div>

      {/* Daily table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
              <th className="py-2 pr-3 font-medium">วันที่</th>
              <th className="py-2 px-3 font-medium text-right">ยอดขาย (฿)</th>
              <th className="py-2 px-3 font-medium text-right">ค่าแรง (฿)</th>
              <th className="py-2 pl-3 font-medium text-right">%COL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date} className="border-b border-slate-50">
                <td className="py-2 pr-3 text-slate-700">{fmtThaiDate(r.date)}</td>
                <td className="py-2 px-3 text-right tabular-nums text-slate-700">
                  {r.revenue != null ? fmtBaht(r.revenue) : <span className="text-slate-300">—</span>}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-slate-500">
                  {r.laborCost > 0 ? fmtBaht(r.laborCost) : <span className="text-slate-300">—</span>}
                </td>
                <td className="py-2 pl-3 text-right tabular-nums font-semibold">
                  {r.colPct != null ? (
                    <span className={r.colPct > 25 ? "text-rose-600" : "text-slate-800"}>
                      {r.colPct}%
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.every((r) => r.revenue == null && r.laborCost === 0) && (
          <p className="text-sm text-slate-400 py-3">ยังไม่มีข้อมูลในช่วง 30 วันนี้</p>
        )}
      </div>

      <p className="text-[11px] text-slate-400">
        %COL = ค่าแรงจริง (ชั่วโมงลงเวลา × เรต) ÷ ยอดขายของวันนั้น × 100 ·
        FT คิดเรตจากเงินเดือน ÷ 22 วัน ÷ 8 ชม.
      </p>
    </div>
  );
}
