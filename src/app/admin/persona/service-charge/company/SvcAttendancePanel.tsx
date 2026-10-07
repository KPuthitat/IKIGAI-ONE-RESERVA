"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { formatLongDate } from "@/lib/time";
import SvcForfeitExemptButton from "../SvcForfeitExemptButton";

// ตรวจเกณฑ์รับเซอร์วิสชาร์จ · ขาด ลา มาสาย (owner 2026-10-07). One row per person for
// the whole company: how many times they were absent / on a counted leave / late,
// the share of their scheduled days that is, and the resulting tier. Every event can
// be waived one by one ("ยกเว้น"); a whole-month waiver sits next to the tier. All
// figures come from the server (computeSvcAttendance) — nothing is calculated here.

type Kind = "absent" | "late" | "leave";
type PanelEvent = { date: string; kind: Kind; detail: string; minutes?: number; exempted: boolean; exemptReason?: string | null };
export type PanelRow = {
  userId: number;
  name: string;
  scheduledDays: number;
  computable: boolean;
  tracksAttendance: boolean;
  absent: number; late: number; leave: number; counted: number; waived: number; pct: number;
  tier: "full" | "half" | "none";
  events: PanelEvent[];
  forfeited: boolean;          // tier none (or resignation) and not waived
  halved: boolean;             // tier half and not waived
  monthExempted: boolean;      // whole-month waiver on
  monthExemptReason: "late_20pct" | "resignation" | "attendance" | null;
  netNote: string | null;      // e.g. "ได้ครึ่ง · หัก ฿123.45"
};

const KIND_LABEL: Record<Kind, string> = { absent: "ขาด", late: "สาย", leave: "ลา" };
const KIND_STYLE: Record<Kind, string> = {
  absent: "bg-rose-100 text-rose-700",
  late: "bg-amber-100 text-amber-700",
  leave: "bg-sky-100 text-sky-700"
};

function TierBadge({ r }: { r: PanelRow }) {
  if (r.monthExempted) return <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold whitespace-nowrap">✓ ยกเว้นทั้งเดือน</span>;
  if (r.tier === "none") return <span className="text-[11px] px-2 py-0.5 rounded bg-rose-100 text-rose-700 font-bold whitespace-nowrap">✗ ไม่ได้รับ</span>;
  if (r.tier === "half") return <span className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-bold whitespace-nowrap">½ ได้ครึ่ง</span>;
  return <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold whitespace-nowrap">✓ ได้เต็ม</span>;
}

export default function SvcAttendancePanel({
  rows, yearMonth, canEdit, locked
}: {
  rows: PanelRow[];
  yearMonth: string;
  canEdit: boolean;
  locked: boolean;     // payout already finalized / paid / posted → read-only
}) {
  const router = useRouter();
  const [open, setOpen] = useState<number | null>(null);
  const [showClean, setShowClean] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);   // `${userId}:${date}:${kind}` while the reason box is open
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const withEvents = rows.filter((r) => r.events.length > 0);
  const clean = rows.filter((r) => r.events.length === 0);
  const shown = showClean ? rows : withEvents;
  const nFull = rows.filter((r) => r.tier === "full" || r.monthExempted).length;
  const nHalf = rows.filter((r) => r.tier === "half" && !r.monthExempted).length;
  const nNone = rows.filter((r) => r.tier === "none" && !r.monthExempted).length;
  const nWaived = rows.reduce((s, r) => s + r.waived, 0);

  async function setExemption(userId: number, e: PanelEvent, exempted: boolean) {
    const key = `${userId}:${e.date}:${e.kind}`;
    setBusyKey(key); setErr(null);
    try {
      const res = await fetch("/api/admin/persona/service-charge/attendance-exemption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, date: e.date, kind: e.kind, exempted, reason: exempted && reason.trim() ? reason.trim() : undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.message ?? "บันทึกไม่สำเร็จ");
      setAsking(null); setReason("");
      router.refresh();
    } catch (x) {
      setErr((x as Error).message || "บันทึกไม่สำเร็จ");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="card space-y-3" aria-label="ตรวจเกณฑ์รับเซอร์วิสชาร์จ">
      <div>
        <h2 className="font-bold text-slate-800 text-sm">ตรวจเกณฑ์รับเซอร์วิสชาร์จ · ขาด ลา มาสาย</h2>
        <p className="text-[11px] text-slate-500 mt-0.5">
          รวมทุกสาขาของบริษัท เดือน {yearMonth} · จำนวนครั้งที่ ขาด + ลา + สาย ÷ จำนวนวันที่ลงตารางงานทั้งเดือน ·
          ไม่เกิน 20% ได้เต็ม · 21–50% ได้ครึ่ง · เกิน 50% ไม่ได้รับ
        </p>
        <p className="text-[11px] text-slate-400 mt-0.5">
          การลาที่นับ: ไม่รวมลาป่วย · เฉพาะวันเสาร์-อาทิตย์/วันหยุดนักขัตฤกษ์ และการลาที่ยื่นวันเดียวกับวันลาหรือหลังวันลา (ถือตามวันที่ยื่นใบลา)
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">ได้เต็ม {nFull} คน</span>
        <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">ได้ครึ่ง {nHalf} คน</span>
        <span className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200">ไม่ได้รับ {nNone} คน</span>
        {nWaived > 0 && <span className="px-2.5 py-1 rounded-full bg-slate-50 text-slate-600 border border-slate-200">ยกเว้นแล้ว {nWaived} ครั้ง</span>}
      </div>

      {locked && (
        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
          ปิดยอดเดือนนี้แล้ว จึงแก้ไขการยกเว้นไม่ได้ (ต้องปลดล็อคการปิดยอดก่อน)
        </p>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-3">ชื่อ</th>
              <th className="py-2 pr-3 text-right">วันตามตาราง</th>
              <th className="py-2 pr-3 text-right">ขาด</th>
              <th className="py-2 pr-3 text-right">ลา</th>
              <th className="py-2 pr-3 text-right">สาย</th>
              <th className="py-2 pr-3 text-right">รวม (ครั้ง)</th>
              <th className="py-2 pr-3 text-right">% ของวันตาราง</th>
              <th className="py-2 pr-3">ผล</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <Fragment key={r.userId}>
                <tr className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{r.name}</div>
                    {!r.tracksAttendance && <div className="text-[10px] text-slate-400">ไม่ลงเวลา · นับเฉพาะการลา</div>}
                    {!r.computable && <div className="text-[10px] text-slate-400">ไม่มีตารางงานเดือนนี้</div>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{r.scheduledDays || "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.absent || "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.leave || "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.late || "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-semibold">
                    {r.counted}
                    {r.waived > 0 && <span className="block text-[10px] font-normal text-slate-400">ยกเว้น {r.waived}</span>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-semibold">{r.computable ? `${r.pct.toFixed(1)}%` : "—"}</td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-col items-start gap-1">
                      <TierBadge r={r} />
                      {r.netNote && <span className="text-[10px] text-slate-500">{r.netNote}</span>}
                      {!locked && canEdit && (r.monthExempted || r.halved || r.forfeited) && (
                        <SvcForfeitExemptButton userId={r.userId} yearMonth={yearMonth}
                          forfeited={r.forfeited || r.halved} exempted={r.monthExempted}
                          reason={r.monthExemptReason} canEdit />
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {r.events.length > 0 && (
                      <button type="button" onClick={() => setOpen(open === r.userId ? null : r.userId)}
                        className="text-xs text-brand hover:underline whitespace-nowrap">
                        {open === r.userId ? "ซ่อนรายการ ▲" : `ดูรายการ (${r.events.length}) ▼`}
                      </button>
                    )}
                  </td>
                </tr>
                {open === r.userId && (
                  <tr className="bg-slate-50/70">
                    <td colSpan={9} className="px-3 py-2">
                      <ul className="divide-y divide-slate-200">
                        {r.events.map((e) => {
                          const key = `${r.userId}:${e.date}:${e.kind}`;
                          return (
                            <li key={key} className="py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="w-32 text-xs text-slate-600">{formatLongDate(e.date, "th")}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${KIND_STYLE[e.kind]}`}>{KIND_LABEL[e.kind]}</span>
                              <span className={`flex-1 min-w-[12rem] text-xs ${e.exempted ? "text-slate-400 line-through" : "text-slate-700"}`}>{e.detail}</span>
                              {e.exempted ? (
                                <span className="flex items-center gap-2 text-[11px]">
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">✓ ยกเว้นแล้ว{e.exemptReason ? ` · ${e.exemptReason}` : ""}</span>
                                  {!locked && canEdit && (
                                    <button type="button" disabled={busyKey === key} onClick={() => setExemption(r.userId, e, false)}
                                      className="text-slate-400 hover:text-rose-600 underline disabled:opacity-50">
                                      {busyKey === key ? "…" : "ยกเลิกการยกเว้น"}
                                    </button>
                                  )}
                                </span>
                              ) : !locked && canEdit ? (
                                asking === key ? (
                                  <span className="flex flex-wrap items-center gap-1.5">
                                    <input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={200}
                                      placeholder="เหตุผล (ไม่บังคับ)" autoFocus
                                      className="input !py-1 !text-xs w-48" />
                                    <button type="button" disabled={busyKey === key} onClick={() => setExemption(r.userId, e, true)}
                                      className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                                      {busyKey === key ? "…" : "ยืนยันยกเว้น"}
                                    </button>
                                    <button type="button" onClick={() => { setAsking(null); setReason(""); }} className="text-[11px] text-slate-500 hover:underline">ยกเลิก</button>
                                  </span>
                                ) : (
                                  <button type="button" onClick={() => { setAsking(key); setReason(""); }}
                                    className="text-[11px] px-2 py-0.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-medium">
                                    ยกเว้น
                                  </button>
                                )
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={9} className="py-6 text-center text-sm text-slate-400">เดือนนี้ไม่มีพนักงานที่ขาด ลา หรือมาสาย</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {clean.length > 0 && (
        <button type="button" onClick={() => setShowClean((v) => !v)} className="text-xs text-slate-500 hover:text-brand hover:underline">
          {showClean ? "ซ่อน" : "แสดง"}พนักงานที่ไม่มีรายการ ({clean.length} คน)
        </button>
      )}
    </section>
  );
}
