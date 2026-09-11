"use client";

import { useState } from "react";
import type { DfRoundPreview, DfRoundLine, DfRoundRow } from "@/lib/df-rounds";
import type { DfDoctor } from "@/lib/df-db";

// Weekly Doctor-Fee round screen (owner 2026-09-11): pick a week, review each
// doctor's fee (rate% of that week's HSC revenue split by roster) with per-doctor
// WHT, then cut+transfer+post-to-accounta behind a PIN. Weeks before the cutover
// are shown read-only (still paid via payroll). Mirrors the revshare rounds flow.

const TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function thDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MON[m - 1]} ${y + 543}`;
}
function weekLabel(startIso: string, endIso: string): string {
  const [, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const left = sm === em ? `${sd}` : `${sd} ${TH_MON[sm - 1]}`;
  return `${left}–${ed} ${TH_MON[em - 1]} ${ey + 543}`;
}
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type PinAction =
  | { kind: "save" | "pay" | "revert"; week: string }
  | { kind: "set_wht"; userId: number; rate: number; label: string };

export default function DoctorFeeRoundsClient({
  initialPreview, initialLines, initialRounds, initialDoctors
}: {
  initialPreview: DfRoundPreview; initialLines: DfRoundLine[];
  initialRounds: DfRoundRow[]; initialDoctors: DfDoctor[];
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [lines, setLines] = useState(initialLines);
  const [rounds, setRounds] = useState(initialRounds);
  const [doctors, setDoctors] = useState(initialDoctors);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState<PinAction | null>(null);
  const [showWht, setShowWht] = useState(false);

  const paid = preview.round?.status === "paid";

  async function loadWeek(week: string) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/admin/persona/doctor-fee/rounds?week=${week}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "error");
      setPreview(j.preview); setLines(j.lines); setRounds(j.rounds); setDoctors(j.doctors);
    } catch (e) { setMsg({ kind: "err", text: errText(e) }); }
    finally { setBusy(false); }
  }

  async function runPin() {
    if (!pending || pin.length < 4) return;
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { action: pending.kind, pin };
      if (pending.kind === "set_wht") { body.userId = pending.userId; body.rate = pending.rate; }
      else body.week = pending.week;
      const r = await fetch("/api/admin/persona/doctor-fee/rounds", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "error");
      if (pending.kind === "set_wht") {
        setDoctors(j.doctors);
        // refresh the current week so the new WHT flows into the preview
        await loadWeek(preview.weekStart);
        setMsg({ kind: "ok", text: "บันทึกอัตราภาษีหักแล้ว" });
      } else {
        setPreview(j.preview); setLines(j.lines); setRounds(j.rounds);
        setMsg({ kind: "ok", text: pending.kind === "pay" ? "ตัดรอบ + โอน + ลงบัญชีเรียบร้อย" : pending.kind === "revert" ? "ยกเลิกการจ่ายแล้ว (กลับเป็นร่าง)" : "บันทึกร่างแล้ว" });
      }
      setPending(null); setPin("");
    } catch (e) { setMsg({ kind: "err", text: errText(e) }); }
    finally { setBusy(false); }
  }

  const p = preview;
  // A paid round shows its FROZEN snapshot (what was actually transferred); a
  // draft / not-yet-cut week shows the live recompute.
  const rows = paid && lines.length > 0
    ? lines.map((l) => ({ user_id: l.user_id, name: l.display_name, workedDays: l.worked_days, grossFee: l.gross_fee, whtRate: l.wht_rate, whtAmount: l.wht_amount, netFee: l.net_fee }))
    : p.doctors.map((d) => ({ user_id: d.user_id, name: `${d.title_prefix ?? ""}${d.display_name}`, workedDays: d.workedDays, grossFee: d.grossFee, whtRate: d.whtRate, whtAmount: d.whtAmount, netFee: d.netFee }));
  const tot = paid && p.round
    ? { fee: p.round.total_fee, wht: p.round.total_wht, net: p.round.total_net, revenue: p.round.total_revenue }
    : { fee: p.totalFee, wht: p.totalWht, net: p.totalNet, revenue: p.totalRevenue };

  return (
    <div className="space-y-4">
      {/* Week navigator */}
      <div className="card flex flex-wrap items-center gap-2">
        <button className="btn-secondary text-sm" disabled={busy} onClick={() => loadWeek(addDays(p.weekStart, -7))}>← สัปดาห์ก่อน</button>
        <div className="text-center px-2">
          <div className="font-semibold text-slate-800">{weekLabel(p.weekStart, p.weekEnd)}</div>
          <div className="text-[11px] text-slate-400">จันทร์ {thDate(p.weekStart)} – อาทิตย์ {thDate(p.weekEnd)}</div>
        </div>
        <button className="btn-secondary text-sm" disabled={busy} onClick={() => loadWeek(addDays(p.weekStart, 7))}>สัปดาห์ถัดไป →</button>
        <input type="date" className="input ml-auto" value={p.weekStart} disabled={busy}
          onChange={(e) => e.target.value && loadWeek(e.target.value)} />
        <StatusPill round={p.round} />
      </div>

      {msg && (
        <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{msg.text}</div>
      )}

      {p.beforeCutover && (
        <div className="text-sm rounded-lg px-3 py-2 bg-amber-50 text-amber-800">
          สัปดาห์นี้อยู่ก่อนวันเริ่มจ่ายรายสัปดาห์ ({thDate(p.cutoverDate)}) — ยังจ่ายผ่านรอบเงินเดือนตามเดิม จึงดูได้อย่างเดียว ตัดรอบไม่ได้ (กันจ่ายซ้ำ)
        </div>
      )}
      {p.stale && !p.beforeCutover && (
        <div className="text-sm rounded-lg px-3 py-2 bg-amber-50 text-amber-800">
          ข้อมูล (ยอด/อัตราภาษี/สถานะหมอ) เปลี่ยนไปหลังจากตัดรอบนี้ — ตัวเลขที่จ่ายไปยังเป็นชุดเดิม หากต้องการอัปเดต ให้กด “ยกเลิกการจ่าย” แล้วตัดรอบใหม่
        </div>
      )}
      {!p.hasRoster && p.totalFee > 0 && (
        <div className="text-sm rounded-lg px-3 py-2 bg-amber-50 text-amber-800">
          สัปดาห์นี้มีรายได้แต่ยังไม่มีหมอในตารางเวร — ยอด {baht(p.unassignedFee)} บาท ยังไม่ถูกจัดสรรให้ใคร
        </div>
      )}

      {/* Doctor table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b">
              <th className="py-2 pr-3">แพทย์</th>
              <th className="py-2 px-2 text-center">วันอยู่เวร</th>
              <th className="py-2 px-2 text-right">ค่าตอบแทน (ก่อนหัก)</th>
              <th className="py-2 px-2 text-center">หัก ณ ที่จ่าย</th>
              <th className="py-2 px-2 text-right">ภาษีหัก</th>
              <th className="py-2 pl-2 text-right">โอนสุทธิ</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="py-6 text-center text-slate-400">ไม่มีค่าตอบแทนในสัปดาห์นี้</td></tr>
            )}
            {rows.map((d) => (
              <tr key={d.user_id} className="border-b last:border-0">
                <td className="py-2 pr-3 text-slate-800">{d.name}</td>
                <td className="py-2 px-2 text-center text-slate-600">{d.workedDays}</td>
                <td className="py-2 px-2 text-right tabular-nums">{baht(d.grossFee)}</td>
                <td className="py-2 px-2 text-center text-slate-500">{(d.whtRate * 100).toLocaleString("th-TH", { maximumFractionDigits: 2 })}%</td>
                <td className="py-2 px-2 text-right tabular-nums text-rose-700">{d.whtAmount > 0 ? `−${baht(d.whtAmount)}` : "—"}</td>
                <td className="py-2 pl-2 text-right tabular-nums font-semibold">{baht(d.netFee)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t font-semibold text-slate-800">
                <td className="py-2 pr-3">รวม</td>
                <td></td>
                <td className="py-2 px-2 text-right tabular-nums">{baht(tot.fee)}</td>
                <td></td>
                <td className="py-2 px-2 text-right tabular-nums text-rose-700">{tot.wht > 0 ? `−${baht(tot.wht)}` : "—"}</td>
                <td className="py-2 pl-2 text-right tabular-nums">{baht(tot.net)}</td>
              </tr>
            </tfoot>
          )}
        </table>
        <div className="text-[11px] text-slate-400 mt-2">ยอดค่าตรวจ (HSC) สัปดาห์นี้รวม {baht(tot.revenue)} บาท</div>
      </div>

      {/* Actions */}
      {!p.beforeCutover && (
        <div className="flex flex-wrap gap-2">
          {!paid && (
            <>
              <button className="btn-primary" disabled={busy || p.doctors.length === 0}
                onClick={() => setPending({ kind: "pay", week: p.weekStart })}>
                ตัดรอบ + โอน + ลงบัญชี
              </button>
              <button className="btn-secondary" disabled={busy || p.doctors.length === 0}
                onClick={() => setPending({ kind: "save", week: p.weekStart })}>
                บันทึกร่าง (ยังไม่โอน)
              </button>
            </>
          )}
          {paid && (
            <button className="btn-secondary text-rose-700" disabled={busy}
              onClick={() => setPending({ kind: "revert", week: p.weekStart })}>
              ยกเลิกการจ่าย (กลับเป็นร่าง)
            </button>
          )}
        </div>
      )}

      {/* WHT config */}
      <div className="card">
        <button className="text-sm font-medium text-brand" onClick={() => setShowWht((s) => !s)}>
          {showWht ? "▾" : "▸"} ตั้งอัตราภาษีหัก ณ ที่จ่ายต่อหมอ
        </button>
        {showWht && (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] text-slate-400">เปอร์เซ็นต์ที่หักจากค่าตอบแทนตอนโอน (เช่น 3 = ภ.ง.ด.53) · 0 = ไม่หัก · มีผลกับรอบที่ยังไม่ตัด</p>
            {doctors.map((d) => (
              <WhtRow key={d.user_id} doctor={d} disabled={busy}
                onSave={(rate) => setPending({ kind: "set_wht", userId: d.user_id, rate, label: `${d.title_prefix ?? ""}${d.display_name}` })} />
            ))}
          </div>
        )}
      </div>

      {/* Recent rounds */}
      <div className="card">
        <div className="text-sm font-medium text-slate-700 mb-2">รอบล่าสุด</div>
        <div className="divide-y">
          {rounds.length === 0 && <div className="text-sm text-slate-400 py-3">ยังไม่มีรอบที่บันทึก</div>}
          {rounds.map((r) => (
            <button key={r.id} className="w-full flex items-center justify-between py-2 text-sm hover:bg-slate-50 px-1 rounded"
              onClick={() => loadWeek(r.week_start)}>
              <span className="text-slate-700">{weekLabel(r.week_start, r.week_end)}</span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-slate-600">{baht(r.total_net)} บาท</span>
                <StatusPill round={r} />
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* PIN modal */}
      {pending && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setPending(null); setPin(""); } }}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full p-5 space-y-3">
            <h3 className="font-semibold text-slate-800">ยืนยันด้วย PIN</h3>
            <p className="text-sm text-slate-500">
              {pending.kind === "set_wht"
                ? `ตั้งอัตราภาษีหัก ${(pending.rate * 100).toLocaleString("th-TH", { maximumFractionDigits: 2 })}% สำหรับ ${pending.label}`
                : pending.kind === "pay" ? "ตัดรอบและโอนค่าตอบแทน + ลงบัญชีในสัปดาห์นี้"
                : pending.kind === "save" ? "บันทึกร่างรอบนี้"
                : "ยกเลิกการจ่ายรอบนี้ (ลบรายการในบัญชีด้วย)"}
            </p>
            <input type="password" inputMode="numeric" autoFocus maxLength={4} className="input w-full text-center tracking-[0.5em] text-lg"
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              onKeyDown={(e) => { if (e.key === "Enter") runPin(); }} placeholder="••••" />
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => { setPending(null); setPin(""); }}>ยกเลิก</button>
              <button className="btn-primary flex-1" disabled={busy || pin.length < 4} onClick={runPin}>ยืนยัน</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ round }: { round: DfRoundRow | null }) {
  if (!round) return <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">ยังไม่ตัดรอบ</span>;
  return round.status === "paid"
    ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">จ่ายแล้ว</span>
    : <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">ร่าง</span>;
}

function WhtRow({ doctor, disabled, onSave }: { doctor: DfDoctor; disabled: boolean; onSave: (rate: number) => void }) {
  const [pct, setPct] = useState(String(+(doctor.df_wht_rate * 100).toFixed(2)));
  const rate = Math.min(1, Math.max(0, (Number(pct) || 0) / 100));
  const changed = Math.abs(rate - doctor.df_wht_rate) > 1e-9;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-slate-700 flex-1">{doctor.title_prefix ?? ""}{doctor.display_name}</span>
      <input type="number" min={0} max={100} step={0.5} className="input w-20 text-right" value={pct}
        onChange={(e) => setPct(e.target.value)} />
      <span className="text-slate-400">%</span>
      <button className="btn-secondary text-xs" disabled={disabled || !changed} onClick={() => onSave(rate)}>บันทึก</button>
    </div>
  );
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    df_before_cutover: "สัปดาห์นี้อยู่ก่อนวันเริ่มจ่ายรายสัปดาห์ — ตัดรอบไม่ได้",
    df_round_paid: "รอบนี้จ่ายไปแล้ว — ต้องยกเลิกการจ่ายก่อนจึงจะแก้ได้",
    no_pin: "คุณยังไม่ได้ตั้ง PIN",
    wrong_pin: "PIN ไม่ถูกต้อง",
    not_df_branch: "สาขานี้ไม่ได้เปิดใช้ค่าตอบแทนแพทย์",
    not_a_doctor: "ผู้ใช้นี้ไม่ใช่แพทย์ที่รับค่าตอบแทน",
    bad_week: "สัปดาห์ไม่ถูกต้อง"
  };
  return map[m] ?? `เกิดข้อผิดพลาด: ${m}`;
}
