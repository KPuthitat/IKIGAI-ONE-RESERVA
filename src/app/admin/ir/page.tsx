import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { formatDate } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import {
  trendFor, IR_SEVERITIES, severityMeta, categoryLabel, statusMeta
} from "@/lib/ir-db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IR · ความเสี่ยง/อุบัติการณ์" };

// IR dashboard — the RM overview for a branch: open workload, severity mix,
// a 6-month trend and the high-severity items that still need action. Filing +
// the full list live under /admin/ir/reports; case review under /admin/ir/[id].
export default function IrDashboard() {
  const user = requirePermission("ir.manage");
  const branchId = user.activeBranchId ?? null;
  const lang = getLang();

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?")
    .get(branchId) as { name: string } | undefined;
  const tr = trendFor(branchId);
  const maxMonth = Math.max(1, ...tr.byMonth.map((m) => m.total));
  const maxSev = Math.max(1, ...IR_SEVERITIES.map((s) => tr.bySeverity[s.value] ?? 0));

  const tiles: Array<{ label: string; value: number; tone: string; sub?: string }> = [
    { label: "ทั้งหมด", value: tr.total, tone: "text-slate-800" },
    { label: "ค้างดำเนินการ", value: tr.open, tone: "text-amber-700", sub: "ใหม่ + ทบทวน + แก้ไข" },
    { label: "เลยกำหนดแก้", value: tr.overdue, tone: tr.overdue > 0 ? "text-rose-700" : "text-slate-400" },
    { label: "ปิดเคสแล้ว", value: tr.closed, tone: "text-emerald-700" }
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ความเสี่ยง / อุบัติการณ์ (IR)</h1>
          <p className="text-sm text-slate-500 mt-1">
            สาขา <b>{branch?.name ?? `#${branchId}`}</b> · รับแจ้งเหตุการณ์ไม่พึงประสงค์และเกือบพลาด ทบทวนหาสาเหตุ ติดตามการแก้ไข
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            แจ้งได้โดยไม่ต้องระบุตัวตน — เน้นการเรียนรู้และป้องกัน ไม่ใช่การจับผิด (non-punitive)
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/ir/reports" className="btn-secondary text-sm">รายการทั้งหมด</Link>
          <Link href="/admin/ir/reports?new=1" className="btn btn-primary text-sm">+ แจ้งเหตุการณ์</Link>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="card !p-4">
            <div className="text-xs text-slate-500">{tile.label}</div>
            <div className={`text-3xl font-bold tabular-nums mt-1 ${tile.tone}`}>{tile.value}</div>
            {tile.sub && <div className="text-[11px] text-slate-400 mt-0.5">{tile.sub}</div>}
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* 6-month trend */}
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-1">แนวโน้ม 6 เดือน</h2>
          <p className="text-[11px] text-slate-400 mb-4">จำนวนเหตุการณ์ต่อเดือน · แถบเข้ม = รุนแรง (ระดับ 4–5)</p>
          <div className="flex items-end justify-between gap-2 h-40">
            {tr.byMonth.map((m) => {
              const h = Math.round((m.total / maxMonth) * 100);
              const hh = m.total ? Math.round((m.high / m.total) * h) : 0;
              const [, mm] = m.month.split("-");
              return (
                <div key={m.month} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end">
                  <span className="text-[11px] text-slate-500 tabular-nums">{m.total || ""}</span>
                  <div className="w-full max-w-[34px] rounded-t-md bg-brand/20 relative overflow-hidden flex items-end"
                    style={{ height: `${Math.max(h, m.total ? 6 : 2)}%` }}>
                    <div className="w-full bg-rose-500/70" style={{ height: `${hh}%` }} aria-hidden />
                  </div>
                  <span className="text-[10px] text-slate-400 tabular-nums">{Number(mm)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Severity mix */}
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-1">ระดับความรุนแรง</h2>
          <p className="text-[11px] text-slate-400 mb-4">กระจายตามระดับ (ทุกสถานะ)</p>
          <div className="space-y-2">
            {[...IR_SEVERITIES].reverse().map((s) => {
              const n = tr.bySeverity[s.value] ?? 0;
              const w = Math.round((n / maxSev) * 100);
              return (
                <div key={s.value} className="flex items-center gap-2.5">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${s.dot}`} aria-hidden />
                  <span className="text-xs text-slate-600 w-16 shrink-0">{s.labelTh}</span>
                  <div className="flex-1 bg-slate-100 rounded-full h-2.5 overflow-hidden">
                    <div className={`h-full rounded-full ${s.dot}`} style={{ width: `${n ? Math.max(w, 4) : 0}%` }} />
                  </div>
                  <span className="text-xs text-slate-500 tabular-nums w-6 text-right">{n}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Category groups */}
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-3">ตามกลุ่มงาน</h2>
          {tr.byCategoryGroup.length === 0
            ? <p className="text-sm text-slate-400">ยังไม่มีข้อมูล</p>
            : (
              <div className="space-y-2">
                {tr.byCategoryGroup.map((g) => (
                  <div key={g.group} className="flex items-center justify-between text-sm">
                    <span className="text-slate-600">{g.group}</span>
                    <span className="font-semibold text-slate-800 tabular-nums">{g.count}</span>
                  </div>
                ))}
              </div>
            )}
        </div>

        {/* Recent high-severity, still open */}
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-3">รุนแรงและยังไม่ปิด</h2>
          {tr.recentHigh.length === 0
            ? <p className="text-sm text-slate-400">ไม่มีเคสรุนแรงค้างอยู่</p>
            : (
              <ul className="space-y-2">
                {tr.recentHigh.map((r) => {
                  const sm = severityMeta(r.severity);
                  const st = statusMeta(r.status);
                  return (
                    <li key={r.id}>
                      <Link href={`/admin/ir/${r.id}`} className="flex items-start gap-2 group">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${sm.tone}`}>{sm.labelTh}</span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-slate-700 group-hover:text-brand truncate">{r.description}</span>
                          <span className="block text-[11px] text-slate-400">
                            {categoryLabel(r.category)} · {formatDate(r.occurred_at, lang)} · <span className={`px-1 rounded ${st.tone}`}>{st.labelTh}</span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
      </div>
    </div>
  );
}
