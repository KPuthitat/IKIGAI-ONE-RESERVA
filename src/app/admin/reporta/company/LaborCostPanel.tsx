"use client";

import { useRouter } from "next/navigation";
import type { CompanyMonthLabor } from "@/lib/daily-col";

// ANALYTICA labour-cost panel (owner 2026-09-24). Company-wide daily labour
// cost (from PERSONA: actual clocked hours × each staff's rate) + the monthly
// per-day average, COL% vs POS sales. Cookie-toggled: when collapsed the server
// skips the (heavier) compute entirely, so it costs the droplet nothing unless
// the viewer opens it. `data` is null while collapsed. Payroll-gated upstream.

const baht = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 0 });
const TH_MONTHS_SHORT = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const thDay = (iso: string) => { const [, m, d] = iso.split("-").map(Number); return `${d} ${TH_MONTHS_SHORT[m]}`; };

function Pct({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  // COL climbs = margin pressure; tint high values so the eye catches them.
  const cls = pct >= 35 ? "text-rose-600" : pct >= 28 ? "text-amber-600" : "text-slate-600";
  return <span className={`font-medium tabular-nums ${cls}`}>{pct.toFixed(1)}%</span>;
}

export default function LaborCostPanel({ data, monthLabel }: { data: CompanyMonthLabor | null; monthLabel: string }) {
  const router = useRouter();

  function setShown(on: boolean) {
    // A per-device UI preference — the server reads it to decide whether to
    // compute. The DATA itself stays payroll-gated server-side.
    try { document.cookie = `analytica_labor=${on ? "1" : "0"}; path=/; max-age=${60 * 60 * 24 * 365}`; } catch { /* ignore */ }
    router.refresh();
  }

  if (!data) {
    return (
      <button type="button" onClick={() => setShown(true)}
        className="w-full card flex items-center justify-between gap-2 hover:border-brand transition text-left">
        <div>
          <div className="font-bold text-slate-800 text-sm">ต้นทุนแรงงาน · COL (รายวัน + เฉลี่ยทั้งเดือน)</div>
          <div className="text-[11px] text-slate-500">ดึงจาก PERSONA — ชั่วโมงเข้างานจริง × ค่าจ้างของแต่ละคน · แตะเพื่อแสดง</div>
        </div>
        <span className="shrink-0 text-sm font-semibold text-brand">แสดง</span>
      </button>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-bold text-slate-800">ต้นทุนแรงงาน · COL — {monthLabel}</div>
        <button type="button" onClick={() => setShown(false)} className="text-xs font-semibold text-slate-500 hover:text-brand">ซ่อน</button>
      </div>

      {/* Monthly summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">เฉลี่ยต่อวัน</div>
          <div className="text-lg font-bold text-slate-800 tabular-nums">฿{baht(data.avgLaborPerDay)}</div>
          <div className="text-[11px] text-slate-400">เฉลี่ยทั้งเดือน ({data.dayCount} วัน)</div>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">% ของยอดขาย</div>
          <div className="text-lg font-bold text-slate-800"><Pct pct={data.avgColPct} /></div>
          <div className="text-[11px] text-slate-400">ต้นทุนแรงงาน ÷ ยอดขาย</div>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5 col-span-2 md:col-span-1">
          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">รวมทั้งเดือน</div>
          <div className="text-lg font-bold text-slate-800 tabular-nums">฿{baht(data.totalLabor)}</div>
          <div className="text-[11px] text-slate-400">ยอดขายรวม ฿{baht(data.totalSales)}</div>
        </div>
      </div>

      {/* Per-day breakdown */}
      {data.days.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-[11px] text-slate-400 border-b border-slate-200">
                <th className="text-left py-1.5 pr-2">วันที่</th>
                <th className="text-right py-1.5 px-2">ต้นทุนแรงงาน</th>
                <th className="text-right py-1.5 px-2">ยอดขาย</th>
                <th className="text-right py-1.5 pl-2">COL%</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.date} className="border-b border-slate-50">
                  <td className="py-1.5 pr-2 text-slate-600">{thDay(d.date)}</td>
                  <td className="py-1.5 px-2 text-right text-slate-700">฿{baht(d.laborCost)}</td>
                  <td className="py-1.5 px-2 text-right text-slate-500">{d.salesNett != null ? `฿${baht(d.salesNett)}` : "—"}</td>
                  <td className="py-1.5 pl-2 text-right"><Pct pct={d.colPct} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-slate-400">
        ต้นทุนแรงงาน = ชั่วโมงที่ลงเวลาจริง × ค่าจ้าง (PT รายชั่วโมง · FT เงินเดือน÷30÷8) รวมทุกสาขา ·
        นับเฉพาะพนักงานที่ลงเวลาเข้างาน · COL% เทียบยอดขายสุทธิ POS ของวันนั้น ·
        เฉลี่ยทั้งเดือน = รวมต้นทุน ÷ {data.dayCount} วัน
      </p>
    </div>
  );
}
