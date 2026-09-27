"use client";

import { useEffect, useState } from "react";
import type { BranchForecast } from "@/lib/forecast";

// Forward plan (owner 2026-09-27): next few days' predicted sales + holidays +
// weather + a น้องฮูก suggestion each. Fetched on its own (the weather lookup is a
// best-effort network call, so it must not block the main dashboard load).

const baht = (n: number) => `฿${Math.round(n).toLocaleString("th-TH")}`;

export default function ForecastCard({ hasLineGroup, onSend }: { hasLineGroup: boolean; onSend: (days: number) => void }) {
  const [days, setDays] = useState(7);
  const [fc, setFc] = useState<BranchForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [weatherAvail, setWeatherAvail] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/admin/reporta/forecast?days=${days}`, { cache: "no-store" })
      .then((x) => x.json())
      .then((r) => { if (alive && r.ok) { setFc(r.forecast); setWeatherAvail(!!r.weatherAvailable); } })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800">แผนล่วงหน้า · น้องฮูกแนะนำ</h2>
          <p className="text-xs text-slate-500 mt-0.5">คาดยอดจากค่าเฉลี่ยรายวัน + โมเมนตัม · วันหยุด/อากาศ{weatherAvail ? "" : " (ยังไม่ได้เชื่อมพยากรณ์อากาศ)"}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm">
            {[3, 7].map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)}
                className={`px-3 py-1 rounded-md transition ${days === d ? "bg-white shadow-sm font-semibold text-slate-800" : "text-slate-500 hover:text-slate-700"}`}>
                {d} วัน
              </button>
            ))}
          </div>
          <button type="button" onClick={() => onSend(days)} disabled={!hasLineGroup || !fc?.hasBaseline}
            className="btn-success text-sm px-4 py-2 disabled:opacity-50" title={!hasLineGroup ? "ยังไม่ได้ตั้งกลุ่ม LINE" : undefined}>
            ส่งเข้ากลุ่ม
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">กำลังคำนวณ…</p>
      ) : !fc || !fc.hasBaseline ? (
        <p className="text-sm text-slate-400">ยังมีข้อมูลย้อนหลังไม่พอจะคาดการณ์ — นำเข้าไฟล์ให้ครบก่อน</p>
      ) : (
        <>
          {fc.momentumPct != null && (
            <div className="text-[11px] text-slate-500">โมเมนตัมล่าสุด (2 สัปดาห์ล่าสุด เทียบ 6 สัปดาห์ก่อน) <span className={fc.momentumPct >= 0 ? "text-emerald-600" : "text-rose-600"}>{fc.momentumPct >= 0 ? "▲" : "▼"} {Math.abs(fc.momentumPct).toFixed(1)}%</span></div>
          )}
          <div className="divide-y divide-slate-100">
            {fc.rows.map((r) => (
              <div key={r.date} className="py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800">{r.dowLabel} {Number(r.date.slice(8, 10))}</span>
                  <span className={`text-sm font-bold tabular-nums ${r.closed ? "text-rose-500" : "text-slate-900"}`}>{r.closed ? "ปิดทำการ" : (r.predictedNett != null ? `~${baht(r.predictedNett)}` : "—")}</span>
                </div>
                {(r.holiday || (r.weather && r.weather.summary !== "อากาศปกติ")) && (
                  <div className="text-[11px] text-amber-700 mt-0.5">
                    {[r.holiday, r.weather && r.weather.summary !== "อากาศปกติ" ? `${r.weather.summary}${r.weather.tempMax != null ? ` ${Math.round(r.weather.tempMax)}°` : ""}` : null].filter(Boolean).join(" · ")}
                  </div>
                )}
                {r.suggestions.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5">
                    {r.suggestions.map((s, i) => (
                      <li key={i} className="flex gap-1.5 text-[11px] text-slate-600"><span className="text-brand">•</span><span>{s}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
