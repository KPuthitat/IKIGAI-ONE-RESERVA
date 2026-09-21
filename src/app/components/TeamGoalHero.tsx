"use client";

import { useEffect, useMemo, useState } from "react";

// Shared team-goal banner at the top of the landing (owner 2026-09-20): the
// branch's monthly sales target, how far along this month, a big % with a clear
// progress bar, and rotating encouragement / thank-you lines so the whole branch
// pulls toward the goal together.

const baht0 = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 0 });

// Executive (C-level) voice — leadership addressing the branch team. Measured,
// professional, no emojis (owner 2026-09-20).
const ENCOURAGE = [
  "ทุกยอดขายที่เพิ่มขึ้น คือการเติบโตที่เราสร้างไปด้วยกัน",
  "เป้าหมายอยู่ไม่ไกล ฝ่ายบริหารเชื่อมั่นในศักยภาพของทีมทุกคน",
  "ความตั้งใจของทุกท่านในวันนี้ คือรากฐานขององค์กรในวันหน้า",
  "มาตรฐานการบริการของทีม คือความได้เปรียบที่แท้จริงขององค์กร",
  "เดินหน้าอย่างมั่นคงไปทีละวัน แล้วเราจะไปถึงเป้าหมายพร้อมกัน"
];
const THANKS = [
  "ฝ่ายบริหารขอขอบคุณในความทุ่มเทของทีมงานทุกท่าน",
  "ความสำเร็จนี้เป็นของทุกคน ขอบคุณที่ตั้งใจอย่างเต็มที่เสมอมา",
  "ขอบคุณที่รักษามาตรฐานและดูแลลูกค้าอย่างดีตลอดมา",
  "แรงกายแรงใจของทุกท่าน คือพลังขับเคลื่อนขององค์กร"
];

export default function TeamGoalHero({
  branchName, target, mtd, pct, projected, projectedPct, onTrack, throughDay
}: {
  branchName: string; target: number; mtd: number; pct: number;
  projected: number; projectedPct: number; onTrack: boolean; throughDay: number;
}) {
  const reached = pct >= 100;

  // A mixed, always-rotating pool. When the goal is hit (or very close) a
  // celebratory / final-push line leads, then the usual encouragement + thanks.
  const pool = useMemo(() => {
    const base = [...ENCOURAGE, ...THANKS];
    if (reached) return ["ทีมทำได้เกินเป้าหมายแล้ว ฝ่ายบริหารขอขอบคุณในทุกความทุ่มเท", "ความสำเร็จนี้คือความภาคภูมิใจของเราทุกคน", ...base];
    if (pct >= 85) return ["ใกล้ถึงเป้าหมายแล้ว ฝ่ายบริหารขอเป็นกำลังใจให้ทีมในช่วงโค้งสุดท้าย", ...base];
    return base;
  }, [reached, pct]);

  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const msg = pool[i % pool.length];

  // Animate the bar filling on mount.
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(Math.min(100, pct)), 150);
    return () => clearTimeout(t);
  }, [pct]);

  const remaining = Math.max(0, target - mtd);
  const over = Math.max(0, mtd - target);

  // Match the ACCOUNTA daybook "ยอดขายเทียบเป้า" card style (owner 2026-09-21):
  // light gradient, target artwork, amber below target / emerald once reached.
  const c = reached
    ? {
        border: "border-emerald-200", grad: "from-emerald-50 to-white",
        badge: "bg-emerald-600/10 text-emerald-700", title: "text-emerald-900",
        hero: "text-emerald-700", strong: "text-emerald-700",
        track: "bg-emerald-100", fill: "bg-emerald-500", foot: "text-emerald-800",
        artwork: "text-emerald-100"
      }
    : {
        border: "border-amber-200", grad: "from-amber-50 to-white",
        badge: "bg-amber-600/10 text-amber-700", title: "text-amber-900",
        hero: "text-amber-700", strong: "text-amber-700",
        track: "bg-amber-100", fill: "bg-amber-500", foot: "text-amber-800",
        artwork: "text-amber-100"
      };

  return (
    <div className={`relative overflow-hidden rounded-2xl border ${c.border} bg-gradient-to-br ${c.grad} p-4 sm:p-5 shadow-sm`}>
      {/* decorative artwork — a soft oversized target in the corner */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        className={`pointer-events-none absolute -right-5 -top-5 h-28 w-28 ${c.artwork}`}>
        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
      </svg>

      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${c.badge}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" />
              </svg>
            </span>
            <h2 className={`font-bold ${c.title}`}>เป้ายอดขายสาขา · เดือนนี้</h2>
          </div>
          <span className={`shrink-0 rounded-full border ${c.border} bg-white/70 px-2.5 py-0.5 text-[11px] font-medium ${c.foot} max-w-[45%] truncate`}>{branchName}</span>
        </div>

        {/* Hero — the headline % */}
        <div className="mt-3 flex items-baseline gap-2 flex-wrap">
          <span className={`text-4xl font-extrabold tracking-tight tabular-nums ${c.hero}`}>{pct.toFixed(0)}%</span>
          <span className="text-xs text-slate-500">ของเป้าเดือนนี้</span>
        </div>

        {/* Progress — month-to-date sales vs monthly target */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-500">ทำได้ <span className={`font-semibold ${c.strong}`}>฿{baht0(mtd)}</span> <span className="text-slate-400">(ถึงวันที่ {throughDay})</span></span>
            <span className="text-slate-500">เป้าเดือนนี้ ฿{baht0(target)}</span>
          </div>
          <div className={`h-2.5 overflow-hidden rounded-full ${c.track}`}>
            <div className={`h-full rounded-full transition-[width] duration-1000 ease-out ${c.fill}`} style={{ width: `${Math.max(2, w)}%` }} />
          </div>
          <div className={`mt-1 text-right text-[11px] font-medium ${c.foot}`}>
            {reached ? `เกินเป้า ฿${baht0(over)}` : `เหลืออีก ฿${baht0(remaining)} ถึงเป้า`}
          </div>
        </div>

        {/* Month-end projection + status */}
        <div className="mt-3 flex items-center justify-between gap-2 flex-wrap text-[11px] text-slate-500">
          <span>คาดสิ้นเดือน ฿{baht0(projected)} ({projectedPct.toFixed(0)}% ของเป้า)</span>
          <span className={`rounded-full px-2 py-0.5 font-semibold ${onTrack || reached ? c.badge : "bg-amber-500/15 text-amber-800"}`}>
            {reached ? "เกินเป้าแล้ว" : onTrack ? "มีลุ้นถึงเป้า" : "ต่ำกว่าเป้า"}
          </span>
        </div>

        {/* Rotating leadership message to the branch team */}
        <div className={`mt-3 min-h-[1.25rem] text-sm font-semibold ${c.title}`}>{msg}</div>
      </div>
    </div>
  );
}
