"use client";

import { useEffect, useMemo, useState } from "react";

// Shared team-goal banner at the top of the landing (owner 2026-09-20): the
// branch's monthly sales target, how far along this month, a big % with a clear
// progress bar, and rotating encouragement / thank-you lines so the whole branch
// pulls toward the goal together.

const baht0 = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 0 });

const ENCOURAGE = [
  "สู้ๆ นะทีมงาน ทุกออเดอร์คือก้าวสำคัญ 💪",
  "ไปด้วยกัน เดี๋ยวก็ถึงเป้า!",
  "วันนี้ทำได้ดีมาก พรุ่งนี้ทำได้อีก 🔥",
  "ทีมเราแข็งแรง ช่วยกันคนละไม้คนละมือ",
  "รอยยิ้มของลูกค้าวันนี้ = ยอดของเราพรุ่งนี้ 😊"
];
const THANKS = [
  "ขอบคุณทีมงานทุกคนที่ทุ่มเทนะครับ 🙏",
  "ขอบคุณที่ดูแลลูกค้าอย่างดีเสมอ ❤️",
  "แรงของทุกคนคือหัวใจของร้าน ขอบคุณครับ",
  "ขอบคุณที่มาเต็มที่ทุกกะ 🙌"
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
    if (reached) return ["🎉 ทะลุเป้าแล้ว! สุดยอดมากทีมงาน", "เกินเป้าไปด้วยกัน ขอบคุณทุกแรงครับ 🙌", ...base];
    if (pct >= 85) return ["ใกล้ถึงเป้าแล้ว ฮึบอีกนิดเดียว! 💪", ...base];
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

  return (
    <div className="rounded-2xl p-5 text-white shadow-md bg-coffee-gradient">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-[1.5px] text-white/70">เป้ายอดขายสาขา · เดือนนี้</div>
        <div className="text-sm font-bold text-white/90">{branchName}</div>
      </div>

      <div className="mt-2 flex items-end gap-3 flex-wrap">
        <div className="text-5xl font-black leading-none tabular-nums text-white">{pct.toFixed(0)}%</div>
        <div className="pb-1 text-sm text-white/90">
          <div>฿{baht0(mtd)} <span className="text-white/60">/ ฿{baht0(target)}</span></div>
          <div className="text-[11px] text-white/60">ทำได้แล้ว (ถึงวันที่ {throughDay})</div>
        </div>
      </div>

      <div className="mt-3 h-3 rounded-full bg-black/25 overflow-hidden">
        <div className={`h-full rounded-full transition-[width] duration-1000 ease-out ${reached ? "bg-brand-light" : "bg-white"}`} style={{ width: `${Math.max(2, w)}%` }} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 flex-wrap text-[11px] text-white/75">
        <span>คาดสิ้นเดือน ฿{baht0(projected)} ({projectedPct.toFixed(0)}% ของเป้า)</span>
        <span className={`rounded-full px-2 py-0.5 font-semibold ${onTrack || reached ? "bg-white/20 text-white" : "bg-amber-400/90 text-amber-950"}`}>
          {reached ? "เกินเป้าแล้ว 🎉" : onTrack ? "มีลุ้นถึงเป้า ✓" : "ช่วยกันอีกแรง"}
        </span>
      </div>

      <div className="mt-3 min-h-[1.25rem] text-sm font-semibold text-white">
        {msg}
      </div>
    </div>
  );
}
