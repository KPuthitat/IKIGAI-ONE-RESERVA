"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

export default function TimeClockClient({
  userName,
  isCurrentlyIn,
  entries
}: {
  userName: string;
  isCurrentlyIn: boolean;
  entries: TimeEntry[];
}) {
  const router = useRouter();
  const [now, setNow] = useState(new Date());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  async function clock() {
    if (busy) return;
    setBusy(true);
    const res = await fetch(apiUrl("/api/persona/clock"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: isCurrentlyIn ? "out" : "in" })
    });
    setBusy(false);
    if (!res.ok) alert("เกิดข้อผิดพลาด");
    router.refresh();
  }

  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const timeStr = bkk.toISOString().slice(11, 19);
  const dateStr = bkk.toLocaleDateString("th-TH-u-ca-buddhist", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  // group entries by Bangkok local date
  const byDay: Record<string, TimeEntry[]> = {};
  for (const e of entries) {
    const d = new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    (byDay[d] ||= []).push(e);
  }
  const days = Object.keys(byDay).sort().reverse();

  return (
    <div className="space-y-4">
      <div className="card text-center">
        <div className="text-sm text-slate-500">{dateStr}</div>
        <div className="text-5xl font-bold tracking-wider text-slate-800 mt-2 tabular-nums">
          {timeStr}
        </div>
        <div className="mt-4">
          <span className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${
            isCurrentlyIn ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
          }`}>
            {isCurrentlyIn ? "● กำลังทำงาน" : "○ ยังไม่เข้างาน / ออกแล้ว"}
          </span>
        </div>
        <p className="text-xs text-slate-400 mt-2">{userName}</p>

        <button
          onClick={clock}
          disabled={busy}
          className={`w-full mt-5 py-4 rounded-2xl text-lg font-bold transition-all active:scale-95 ${
            isCurrentlyIn
              ? "bg-amber-500 hover:bg-amber-600 text-white shadow-[0_4px_16px_rgba(245,158,11,.4)]"
              : "bg-emerald-500 hover:bg-emerald-600 text-white shadow-[0_4px_16px_rgba(16,185,129,.4)]"
          }`}
        >
          {busy ? "..." : isCurrentlyIn ? "ลงเวลาออกงาน" : "ลงเวลาเข้างาน"}
        </button>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-3">ประวัติ 7 วันล่าสุด</h2>
        {days.length === 0 ? (
          <div className="text-slate-500 text-sm text-center py-4">ยังไม่มีประวัติ</div>
        ) : (
          <div className="space-y-3">
            {days.map((d) => {
              const dayEntries = byDay[d];
              const totalMins = computeTotalMinutes(dayEntries);
              return (
                <div key={d} className="border-b border-slate-100 pb-2 last:border-b-0">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-medium">{formatThaiDate(d)}</span>
                    <span className="text-slate-500 text-xs">
                      {totalMins > 0 ? `รวม ${Math.floor(totalMins / 60)}ชม. ${totalMins % 60}น.` : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {dayEntries.slice().reverse().map((e) => (
                      <span
                        key={e.id}
                        className={`text-[11px] px-2 py-0.5 rounded ${
                          e.type === "in" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {e.type === "in" ? "เข้า" : "ออก"} {new Date(new Date(e.ts).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function computeTotalMinutes(entries: TimeEntry[]): number {
  // entries เรียงจากใหม่ → เก่า, reverse ให้เก่า → ใหม่ แล้ว pair in-out
  const sorted = entries.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  let total = 0;
  let lastIn: number | null = null;
  for (const e of sorted) {
    if (e.type === "in") lastIn = new Date(e.ts).getTime();
    else if (e.type === "out" && lastIn !== null) {
      total += Math.floor((new Date(e.ts).getTime() - lastIn) / 60000);
      lastIn = null;
    }
  }
  return Math.max(0, total);
}

function formatThaiDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  return `${d} ${months[m - 1]} ${y + 543}`;
}
