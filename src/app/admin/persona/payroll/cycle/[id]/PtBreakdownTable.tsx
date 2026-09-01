"use client";

// Part-time table on the company-cycle page with a per-employee, per-DAY pay
// breakdown the admin can open to re-check before paying (owner 2026-08:
// "แต่ละวันทำกันได้ค่าตอบแทนเท่าไหร่"). The daily numbers are recomputed on demand
// from the existing /breakdown endpoint (same source the per-period detail
// modal uses), so they always tie out to the stored line — nothing new to keep
// in sync. Rows are lazy: a person's days are fetched only when their row opens.

import { Fragment, useState } from "react";
import { useLang } from "@/lib/LangProvider";
import { fmtMoney } from "@/lib/format";
import { nameWithPrefix } from "@/lib/name";
import { apiUrl } from "@/lib/url";

type PtRow = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  salary_tax_mode_snapshot: string | null;
  total_regular_minutes: number | null;
  total_ot_minutes: number | null;
  total_base_pay: number | null;
  total_ot_pay: number | null;
  total_gross: number | null;
  total_sso: number | null;
  total_tax: number | null;
  total_net: number | null;
};
type BreakDay = {
  date: string;
  pairs: Array<{ workIn: string | null; workOut: string | null }>;
  effectiveMinutes: number;
  otMinutes: number;
  otPay: number;
  pay: number;
  holiday: boolean;
  double: boolean;
  statusLabel: string | null;
  shift: { code: string; name: string | null } | null;
};
type DayState = "loading" | "error" | BreakDay[];

function fmtMin(min: number): string {
  if (!min) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h && m ? `${h} ชม ${m} น` : h ? `${h} ชม` : `${m} น`;
}
function fmtDay(date: string): string {
  const d = new Date(`${date}T00:00:00+07:00`);
  return d.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Bangkok" });
}

export default function PtBreakdownTable({
  rows, periodIdsByUser, branchCols, grossByUserBranch, multiBranch
}: {
  rows: PtRow[];
  periodIdsByUser: Record<number, number[]>;
  branchCols: Array<{ id: number; name: string }>;
  grossByUserBranch: Record<number, Record<number, number>>;
  multiBranch: boolean;
}) {
  const { t } = useLang();
  const [openUser, setOpenUser] = useState<Set<number>>(new Set());
  const [days, setDays] = useState<Record<number, DayState>>({});

  const colSpan = (multiBranch ? branchCols.length : 0) + 9;

  async function toggle(userId: number) {
    setOpenUser((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
    if (days[userId] !== undefined) return;   // already fetched/loading
    setDays((d) => ({ ...d, [userId]: "loading" }));
    try {
      const pids = periodIdsByUser[userId] ?? [];
      const all: BreakDay[] = [];
      for (const pid of pids) {
        const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${pid}/lines/${userId}/breakdown`));
        const j = await res.json().catch(() => ({}));
        if (j?.ok && Array.isArray(j.days)) all.push(...(j.days as BreakDay[]));
      }
      // Merge by date (a person may have days across two branch-periods).
      const byDate = new Map<string, BreakDay>();
      for (const d of all) {
        const e = byDate.get(d.date);
        if (!e) byDate.set(d.date, { ...d, pairs: [...d.pairs] });
        else {
          e.pay += d.pay; e.otPay += d.otPay;
          e.effectiveMinutes += d.effectiveMinutes; e.otMinutes += d.otMinutes;
          e.pairs = [...e.pairs, ...d.pairs];
          e.holiday = e.holiday || d.holiday; e.double = e.double || d.double;
        }
      }
      const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      setDays((d) => ({ ...d, [userId]: merged }));
    } catch {
      setDays((d) => ({ ...d, [userId]: "error" }));
    }
  }

  const sub = rows.reduce(
    (a, r) => ({
      base: a.base + (r.total_base_pay ?? 0), otPay: a.otPay + (r.total_ot_pay ?? 0),
      gross: a.gross + (r.total_gross ?? 0), sso: a.sso + (r.total_sso ?? 0),
      tax: a.tax + (r.total_tax ?? 0), net: a.net + (r.total_net ?? 0)
    }),
    { base: 0, otPay: 0, gross: 0, sso: 0, tax: 0, net: 0 }
  );

  return (
    <div className="card overflow-x-auto">
      <h2 className="font-semibold text-slate-700 mb-1">
        <span className="text-violet-700">{t("admin.persona.employees.employment.pt")}</span> · {rows.length} {t("admin.persona.payroll.col.staff")}
      </h2>
      <p className="text-[11px] text-slate-400 mb-3">กดชื่อเพื่อดูวิธีคิดค่าตอบแทนรายวัน (ไว้รีเช็กก่อนจ่าย)</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-3">{t("admin.persona.payroll.col.staff")}</th>
            {multiBranch && branchCols.map((b) => (
              <th key={b.id} className="py-2 pr-3 text-right whitespace-nowrap">{b.name}</th>
            ))}
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.regularHrs")}</th>
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.otHrs")}</th>
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.basePay")}</th>
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.otPay")}</th>
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.gross")}</th>
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.sso")}</th>
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.tax")}</th>
            <th className="py-2 pr-3 text-right">{t("admin.persona.payroll.col.net")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const perB = grossByUserBranch[r.user_id] ?? {};
            const isOpen = openUser.has(r.user_id);
            const st = days[r.user_id];
            return (
              <Fragment key={r.user_id}>
                <tr className="border-b border-slate-100 hover:bg-slate-50/60">
                  <td className="py-2 pr-3">
                    <button type="button" onClick={() => toggle(r.user_id)} className="flex items-center gap-1.5 text-left group">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        className={`text-slate-400 group-hover:text-violet-600 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden>
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                      <span className="font-medium text-slate-800 group-hover:text-violet-700">{nameWithPrefix(r.title_prefix, r.display_name)}</span>
                      {r.salary_tax_mode_snapshot === "wht" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{t("admin.persona.employees.taxMode.whtTag")}</span>
                      )}
                    </button>
                  </td>
                  {multiBranch && branchCols.map((b) => {
                    const v = perB[b.id] ?? 0;
                    return <td key={b.id} className="py-2 pr-3 text-right tabular-nums">{v ? fmtMoney(v) : <span className="text-slate-300">—</span>}</td>;
                  })}
                  <td className="py-2 pr-3 text-right text-slate-600 tabular-nums">{fmtMin(r.total_regular_minutes ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700 tabular-nums">{(r.total_ot_minutes ?? 0) > 0 ? fmtMin(r.total_ot_minutes ?? 0) : "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtMoney(r.total_base_pay ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700 tabular-nums">{(r.total_ot_pay ?? 0) > 0 ? fmtMoney(r.total_ot_pay ?? 0) : "—"}</td>
                  <td className="py-2 pr-3 text-right">{fmtMoney(r.total_gross ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(r.total_sso ?? 0)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(r.total_tax ?? 0)}</td>
                  <td className="py-2 pr-3 text-right font-bold text-emerald-700">{fmtMoney(r.total_net ?? 0)}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-violet-50/40">
                    <td colSpan={colSpan} className="px-3 py-2">
                      {st === "loading" && <div className="text-xs text-slate-400 py-2">กำลังคำนวณ…</div>}
                      {st === "error" && <div className="text-xs text-rose-600 py-2">โหลดรายละเอียดไม่สำเร็จ</div>}
                      {Array.isArray(st) && <DayTable days={st} baseTotal={r.total_base_pay ?? 0} otTotal={r.total_ot_pay ?? 0} multiBranch={multiBranch} />}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 font-medium">
            <td className="py-2 pr-3" colSpan={multiBranch ? 1 + branchCols.length : 1}>{t("admin.persona.payroll.detail.total")}</td>
            <td colSpan={2}></td>
            <td className="py-2 pr-3 text-right">{fmtMoney(sub.base)}</td>
            <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(sub.otPay)}</td>
            <td className="py-2 pr-3 text-right">{fmtMoney(sub.gross)}</td>
            <td className="py-2 pr-3 text-right text-sky-700">{fmtMoney(sub.sso)}</td>
            <td className="py-2 pr-3 text-right text-amber-700">{fmtMoney(sub.tax)}</td>
            <td className="py-2 pr-3 text-right text-emerald-700">{fmtMoney(sub.net)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// Per-day calculation detail — a financial-table layout: descriptive columns
// (date / shift / clock) hug the left, all money + hours hug the right in tidy
// right-aligned columns that line up down the page. A flexible spacer column
// absorbs the slack so nothing sprawls. Each day breaks down as ค่าตอบแทน
// (regular) + ล่วงเวลา (OT) = รวมวันนี้, so no figure is shown twice.
//
// Reconciliation: the paid line total (baseTotal+otTotal, stored) can sit a few
// baht above the sum of the live per-day rows when someone works two branches
// the same day — they clock OUT of the first and IN to the second, and the gap
// in between (travel) falls outside every single day's window. Owner policy
// 2026-08: that gap is credited to the employee ("ยกให้"), so the higher paid
// total is correct — we just explain the difference plainly rather than flag it.
// The one case worth an alert is the opposite: live days summing to MORE than
// what's booked, which would mean the stored line is stale and underpays.
function DayTable({ days, baseTotal, otTotal, multiBranch }: { days: BreakDay[]; baseTotal: number; otTotal: number; multiBranch: boolean }) {
  const worked = days.filter((d) => !d.statusLabel);
  const regMinTotal = days.reduce((s, d) => s + d.effectiveMinutes, 0);
  const daySum = Math.round(days.reduce((s, d) => s + d.pay, 0) * 100) / 100;
  const lineTotal = Math.round((baseTotal + otTotal) * 100) / 100;
  const diff = Math.round((lineTotal - daySum) * 100) / 100;   // + = paid above day-sum
  const numTh = "py-1.5 px-3 text-right font-medium";
  const numTd = "py-1.5 px-3 text-right tabular-nums whitespace-nowrap";
  return (
    <div className="rounded-lg border border-violet-100 bg-white overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-[11px] text-slate-400 border-b border-slate-100">
            <th className="py-1.5 px-3 text-left">วันที่</th>
            <th className="py-1.5 px-3 text-left">กะ / สถานะ</th>
            <th className="py-1.5 px-3 text-left">เวลาเข้า–ออก</th>
            <th className="w-full" aria-hidden></th>
            <th className={numTh}>ชม.ทำงาน</th>
            <th className={numTh}>ค่าตอบแทน</th>
            <th className={numTh}>ล่วงเวลา</th>
            <th className={`${numTh} text-slate-500`}>รวมวันนี้</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const dayBase = Math.round((d.pay - d.otPay) * 100) / 100;
            const times = d.pairs.filter((p) => p.workIn || p.workOut)
              .map((p) => `${p.workIn ?? "—"}–${p.workOut ?? "—"}`).join(", ");
            return (
              <tr key={d.date} className={`border-b border-slate-50 last:border-0 ${d.statusLabel ? "text-slate-400" : ""}`}>
                <td className="py-1.5 px-3 whitespace-nowrap text-slate-700">{fmtDay(d.date)}</td>
                <td className="py-1.5 px-3">
                  {d.statusLabel
                    ? <span className="text-slate-400">{d.statusLabel}</span>
                    : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-slate-600">{d.shift?.code ?? "—"}</span>
                        {d.double && <span className="text-[10px] px-1 rounded bg-rose-100 text-rose-700">×2</span>}
                        {d.holiday && !d.double && <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-700">×1.5</span>}
                      </span>
                    )}
                </td>
                <td className="py-1.5 px-3 whitespace-nowrap tabular-nums text-slate-500">{times || "—"}</td>
                <td className="w-full" aria-hidden></td>
                <td className={`${numTd} text-slate-600`}>{d.effectiveMinutes ? fmtMin(d.effectiveMinutes) : "—"}</td>
                <td className={numTd}>{dayBase ? `฿${fmtMoney(dayBase)}` : "—"}</td>
                <td className={`${numTd} text-amber-700`}>
                  {d.otMinutes
                    ? <>฿{fmtMoney(d.otPay)}<span className="text-[10px] text-amber-600/70 ml-1">{fmtMin(d.otMinutes)}</span></>
                    : "—"}
                </td>
                <td className={`${numTd} font-semibold text-slate-800`}>{d.pay ? `฿${fmtMoney(d.pay)}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 font-medium bg-slate-50/60">
            <td className="py-1.5 px-3 whitespace-nowrap" colSpan={3}>รวม {worked.length} วันทำงาน</td>
            <td className="w-full" aria-hidden></td>
            <td className={`${numTd} text-slate-600`}>{regMinTotal ? fmtMin(regMinTotal) : "—"}</td>
            <td className={numTd}>฿{fmtMoney(baseTotal)}</td>
            <td className={`${numTd} text-amber-700`}>{otTotal ? `฿${fmtMoney(otTotal)}` : "—"}</td>
            <td className={`${numTd} font-bold text-slate-800`}>฿{fmtMoney(lineTotal)}</td>
          </tr>
          {Math.abs(diff) >= 0.5 && (
            diff > 0 ? (
              // Paid above the live day-sum — cross-branch travel gap, credited
              // to the employee per owner policy. Benign, explained in plain text.
              <tr className="border-t border-slate-100">
                <td colSpan={8} className="py-1.5 px-3 text-[11px] text-slate-500 leading-relaxed">
                  รวมรายวัน ฿{fmtMoney(daySum)} · จ่ายจริง <span className="font-medium text-slate-700">฿{fmtMoney(lineTotal)}</span>
                  {" "}— ส่วนต่าง ฿{fmtMoney(diff)}{multiBranch ? " จากช่วงเดินทางข้ามสาขา (กดออกที่แรก–กดเข้าที่สอง)" : ""} ยกให้พนักงาน
                </td>
              </tr>
            ) : (
              // Live days sum to MORE than what's booked — stored line looks
              // stale and would underpay. This one is worth an alert.
              <tr className="border-t border-amber-200 bg-amber-50/60">
                <td colSpan={8} className="py-1.5 px-3 text-[11px] text-amber-800 leading-relaxed">
                  รวมรายวันคำนวณสดได้ ฿{fmtMoney(daySum)} มากกว่ายอดที่บันทึก ฿{fmtMoney(lineTotal)} อยู่ ฿{fmtMoney(-diff)} — ยอดที่บันทึกอาจล้าสมัย ควรกดคำนวณรอบนี้ใหม่ก่อนจ่าย
                </td>
              </tr>
            )
          )}
        </tfoot>
      </table>
    </div>
  );
}
