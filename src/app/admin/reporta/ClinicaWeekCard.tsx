"use client";

import type { ClinicaWeek } from "@/lib/clinica-analytics";
import { Pct } from "./ClinicaSection";

// The body of the clinic สรุปรายสัปดาห์ card (owner 2026-09-27: "การ์ดสัปดาห์เต็ม +
// เทียบสัปดาห์ก่อน"). Mirrors the restaurant weekly card — KPIs, เทียบสัปดาห์ก่อน with
// the SAME ▲▼ arrows (the shared <Pct> from ClinicaSection), a Mon–Sun daily list
// and the week's top revenue items. The card shell (title, week stepper,
// วิเคราะห์อีกครั้ง) lives in ReportaClient, exactly like the restaurant weekly card.

const baht = (n: number) => `฿${Math.round(n).toLocaleString("th-TH")}`;
const intTh = (n: number) => n.toLocaleString("th-TH");

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`font-bold tabular-nums ${accent ? "text-lg text-emerald-700" : "text-slate-800"}`}>{value}</div>
    </div>
  );
}

export default function ClinicaWeekCard({ w }: { w: ClinicaWeek }) {
  return (
    <>
      <div className="text-sm text-slate-600">{w.label} · รวม {w.dayCount} วัน</div>
      {w.dayCount === 0 ? (
        <p className="text-sm text-slate-400">ยังไม่มีข้อมูลบิลในสัปดาห์นี้</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi label="ยอดบิลรวมสัปดาห์" value={baht(w.totalNet)} accent />
            <Kpi label="จำนวนบิลรวม" value={`${intTh(w.totalBills)} บิล`} />
            <Kpi label="คนไข้รวม" value={`${intTh(w.totalPatients)} คน`} />
            <Kpi label="เฉลี่ยต่อวัน" value={w.avgPerDay != null ? baht(w.avgPerDay) : "—"} />
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 flex flex-wrap gap-x-6 gap-y-1">
            <span className="font-semibold text-slate-700">เทียบสัปดาห์ก่อน:</span>
            {w.prevWeekNet == null ? (
              // No prior-week bills at all. (A prior week that had bills but zero
              // net still shows the row — its bill/patient WoW is meaningful.)
              <span className="text-slate-400">ยังไม่มีข้อมูลสัปดาห์ก่อน</span>
            ) : (
              <>
                <span>ยอดบิล <Pct pct={w.wowNetPct} /> <span className="text-slate-400">({baht(w.prevWeekNet)})</span></span>
                <span>บิล <Pct pct={w.wowBillsPct} /></span>
                <span>คนไข้ <Pct pct={w.wowPatientsPct} /></span>
              </>
            )}
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-bold text-slate-600 mb-1">ยอดบิลรายวัน</div>
              {w.days.map((d) => (
                <div key={d.date} className={`flex justify-between text-sm ${d.date === w.bestDate ? "font-bold text-emerald-700" : ""}`}>
                  <span className="text-slate-600">{d.dateLabel}</span><span>{baht(d.net)}</span>
                </div>
              ))}
            </div>
            {w.topItems.length > 0 && (
              <div>
                <div className="text-xs font-bold text-slate-600 mb-1">รายการทำรายได้สูงสุดประจำสัปดาห์</div>
                {w.topItems.map((it, i) => (
                  <div key={it.name} className="flex justify-between gap-2 text-sm">
                    <span className="text-slate-600 truncate">{i + 1}. {it.name}</span>
                    <span className="text-slate-700 tabular-nums whitespace-nowrap">{baht(it.net)} ({intTh(it.qty)} ครั้ง)</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
