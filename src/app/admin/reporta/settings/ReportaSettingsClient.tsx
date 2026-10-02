"use client";

import { useMemo, useState } from "react";
import MoneyInput, { withCommas } from "@/app/components/MoneyInput";

// ANALYTICA settings (owner 2026-09-16 → 2026-10-02): the HOD LINE group, the
// sales target (a default + per-month overrides so the goal can grow), the POS
// merchant guard, the card colour and the opening date. Operating hours are
// read-only here — they come from RESERVA, per day. Laid out in three cards
// across the full width (owner 2026-10-02: "หน้าจอกว้างใหญ่ ทำไมต้องมากระจุก").

const DEFAULT_COLOR = "#0e2724";
const PRESETS = ["#0e2724", "#1e3a5f", "#5b21b6", "#9d174d", "#b45309", "#334155", "#166534", "#7c2d12"];
const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

type DayHours = { dow: number; label: string; closed: boolean; open: string | null; close: string | null; breakStart: string | null; breakEnd: string | null };
type MonthTarget = { ym: string; target: number };

const toNum = (digits: string): number | null => (digits ? Number(digits) : null);
/** The next 12 months starting this month (Bangkok), as "YYYY-MM". */
function upcomingMonths(): string[] {
  const now = new Date(Date.now() + 7 * 3600_000);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  return Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(y, m + i, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; });
}
const ymLabel = (ym: string) => `${TH_MONTHS[Number(ym.slice(5, 7)) - 1]} ${Number(ym.slice(0, 4)) + 543}`;

export default function ReportaSettingsClient({
  initialGroupId, initialTarget, initialMonthTargets, initialMerchant, initialColor, initialOpensOn, weekHours
}: {
  initialGroupId: string | null; initialTarget: number | null; initialMonthTargets: MonthTarget[];
  initialMerchant: string | null; initialColor: string | null; initialOpensOn: string | null; weekHours: DayHours[];
}) {
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [target, setTarget] = useState(initialTarget != null ? String(Math.round(initialTarget)) : "");
  const months = useMemo(upcomingMonths, []);
  // Per-month inputs (digit strings): pre-filled with the stored override; blank = use the default.
  const initialByYm = useMemo(() => Object.fromEntries(initialMonthTargets.map((t) => [t.ym, String(Math.round(t.target))])), [initialMonthTargets]);
  const [monthInputs, setMonthInputs] = useState<Record<string, string>>(() => Object.fromEntries(months.map((ym) => [ym, initialByYm[ym] ?? ""])));
  const [merchant, setMerchant] = useState(initialMerchant ?? "");
  const [color, setColor] = useState(initialColor ?? DEFAULT_COLOR);
  const [opensOn, setOpensOn] = useState(initialOpensOn ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const defaultNum = toNum(target);
  const effective = (ym: string): number | null => toNum(monthInputs[ym] ?? "") ?? defaultNum;
  const yearSum = months.reduce((s, ym) => s + (effective(ym) ?? 0), 0);

  // Fill the 12 months with a growth step from the default (owner: "เราจะต้องเติบโต").
  const applyGrowth = (pct: number) => {
    if (!defaultNum) { setMsg({ kind: "err", text: "ใส่เป้าเริ่มต้นก่อน แล้วค่อยกดเติมแบบเติบโต" }); return; }
    const next: Record<string, string> = {};
    months.forEach((ym, i) => { next[ym] = String(Math.round(defaultNum * Math.pow(1 + pct / 100, i) / 1000) * 1000); });
    setMonthInputs(next);
    setMsg(null);
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    // Only months whose input changed are sent (blank = remove the override).
    const monthTargets: Record<string, number | null> = {};
    for (const ym of months) {
      const cur = monthInputs[ym] ?? "", was = initialByYm[ym] ?? "";
      if (cur !== was) monthTargets[ym] = toNum(cur);
    }
    try {
      const r = await fetch("/api/admin/reporta/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // Only send opensOn when it actually changed — it's the shared
        // branches.opens_on column (also editable in RESERVA), so re-sending an
        // untouched value could revert a concurrent edit there.
        body: JSON.stringify({
          lineGroupId: groupId.trim() || null, monthlyTarget: defaultNum, merchantName: merchant.trim() || null, cardColor: color,
          ...(Object.keys(monthTargets).length ? { monthTargets } : {}),
          ...(opensOn !== (initialOpensOn ?? "") ? { opensOn: opensOn || null } : {})
        })
      }).then((x) => x.json());
      if (r.ok) setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      else setMsg({ kind: "err", text: r.error ?? "บันทึกไม่สำเร็จ" });
    } catch { setMsg({ kind: "err", text: "บันทึกผิดพลาด" }); }
    setSaving(false);
  };

  const SaveBar = () => (
    <div className="flex items-center gap-3 flex-wrap">
      <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}</button>
      {msg && <span className={`text-sm rounded-lg px-3 py-1.5 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</span>}
    </div>
  );

  return (
    <div className="space-y-4">
      <SaveBar />

      {/* ── Card 1: sales targets (full width) ── */}
      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-bold text-slate-800">เป้ายอดขาย</h2>
            <p className="text-xs text-slate-500 mt-0.5">ใช้แสดงแถบความคืบหน้าและคาดการณ์สิ้นเดือนของเดือนนั้น · เป้าทั้งปี = ผลรวมเป้า 12 เดือน</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm text-slate-600">เป้าเริ่มต้น/เดือน</label>
            <MoneyInput value={target} onChange={setTarget} placeholder="600,000" className="!w-40" ariaLabel="เป้าเริ่มต้นต่อเดือน" />
            <span className="text-xs text-slate-400">บาท · ใช้กับทุกเดือนที่ไม่ได้ตั้งเป้าเฉพาะ</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between gap-3 flex-wrap bg-slate-50 px-4 py-2.5">
            <div className="text-sm font-semibold text-slate-700">เป้ารายเดือน 12 เดือนข้างหน้า <span className="font-normal text-slate-400 text-xs">· เว้นว่าง = ใช้เป้าเริ่มต้น</span></div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-400">เติมแบบเติบโต:</span>
              {[3, 5, 10].map((p) => (
                <button key={p} type="button" onClick={() => applyGrowth(p)} className="px-2.5 py-1 rounded-full border border-slate-200 bg-white text-slate-600 hover:border-brand/40">+{p}% ต่อเดือน</button>
              ))}
              <button type="button" onClick={() => setMonthInputs(Object.fromEntries(months.map((ym) => [ym, ""])))} className="px-2.5 py-1 rounded-full border border-slate-200 bg-white text-slate-500 hover:border-brand/40">ล้างทั้งหมด</button>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-px bg-slate-100">
            {months.map((ym) => {
              const v = monthInputs[ym] ?? "";
              const eff = effective(ym);
              const overridden = v.trim() !== "";
              return (
                <div key={ym} className="bg-white px-4 py-3 flex items-center gap-3">
                  <div className="w-28 shrink-0">
                    <div className="text-sm text-slate-700">{ymLabel(ym)}</div>
                    <div className="text-[11px] text-slate-400">{overridden ? "เป้าเฉพาะเดือน" : "ใช้เป้าเริ่มต้น"}</div>
                  </div>
                  <MoneyInput value={v} onChange={(d) => setMonthInputs((m) => ({ ...m, [ym]: d }))}
                    placeholder={defaultNum ? withCommas(String(defaultNum)) : "—"} className="!py-1.5 flex-1 min-w-0" ariaLabel={`เป้าเดือน ${ymLabel(ym)}`} />
                  <div className={`w-24 text-right text-xs tabular-nums shrink-0 ${eff ? "text-slate-600" : "text-slate-300"}`}>{eff ? withCommas(String(eff)) : "ไม่ตั้งเป้า"}</div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-2 bg-slate-50 px-4 py-2.5 text-sm">
            <span className="text-slate-500">รวม 12 เดือน</span>
            <b className="tabular-nums text-slate-800">{yearSum > 0 ? `${withCommas(String(Math.round(yearSum)))} บาท` : "—"}</b>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* ── Card 2: LINE + branch identity ── */}
        <div className="card space-y-4">
          <h2 className="font-bold text-slate-800">กลุ่ม LINE และข้อมูลสาขา</h2>
          <div>
            <label className="label">LINE Group ID ของกลุ่มหัวหน้างาน (HOD)</label>
            <input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="เช่น Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="input font-mono text-sm" />
            <p className="text-xs text-slate-500 mt-1.5">เพิ่มบัญชี NOKHOOK OS (platform OA) เข้ากลุ่มก่อน แล้วนำ Group ID มาใส่ · เว้นว่างเพื่อปิดการส่ง</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">วันเปิดสาขา (วันแรกที่เปิดร้าน)</label>
              <input type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} className="input" />
              <p className="text-xs text-slate-500 mt-1.5">สาขาที่เปิดกลางปีจะคิดเป้าทั้งปีและคาดการณ์รายได้จากวันนี้ · ใช้ค่าเดียวกับ RESERVA · เว้นว่าง = เปิดมาทั้งปี</p>
            </div>
            <div>
              <label className="label">ชื่อร้านใน POS (Merchant)</label>
              <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="ปกติเว้นว่าง (ใช้ชื่อสาขา)" className="input" />
              <p className="text-xs text-slate-500 mt-1.5">กันไฟล์ผิดสาขา — กรอกเฉพาะเมื่อชื่อร้านใน POS ต่างจากชื่อสาขา</p>
            </div>
          </div>
          <div>
            <label className="label">สีการ์ดของสาขานี้ (หัวการ์ด LINE)</label>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                {PRESETS.map((c) => (
                  <button key={c} type="button" onClick={() => setColor(c)}
                    className={`h-8 w-8 rounded-full border-2 ${color.toLowerCase() === c ? "border-slate-800 ring-2 ring-offset-1 ring-slate-300" : "border-white shadow"}`}
                    style={{ backgroundColor: c }} aria-label={c} />
                ))}
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-10 rounded border border-slate-200 bg-white p-0.5" />
              </div>
              <div className="rounded-xl overflow-hidden shadow-sm w-64">
                <div style={{ backgroundColor: color }} className="px-4 py-2.5">
                  <div className="text-[10px]" style={{ color: "#ffffff99" }}>NOKHOOK OS · ยอดขายรายวัน</div>
                  <div className="text-white font-bold text-sm">สรุปยอดขายประจำวัน</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Card 3: operating hours from RESERVA (read-only) ── */}
        <div className="card space-y-3">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <h2 className="font-bold text-slate-800">เวลาทำการ</h2>
            <span className="text-xs text-slate-500">ดึงจาก RESERVA · <a href="/admin/reserva/settings" className="underline text-brand">แก้ที่ RESERVA</a></span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {weekHours.map((d) => (
                <tr key={d.dow} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 text-slate-600 w-28">{d.label}</td>
                  <td className="py-2 tabular-nums">
                    {d.closed
                      ? <span className="text-slate-400">ปิด</span>
                      : d.open && d.close
                        ? <span className="text-slate-800">{d.open}–{d.close}</span>
                        : <span className="text-amber-600">ยังไม่ได้ตั้งเวลาใน RESERVA</span>}
                  </td>
                  <td className="py-2 text-right text-xs text-slate-400 tabular-nums">
                    {!d.closed && d.breakStart && d.breakEnd ? `พัก ${d.breakStart}–${d.breakEnd}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-slate-500">กราฟช่วงเวลาขายดีตรึงแกนตามเวลานี้</p>
        </div>
      </div>

      <SaveBar />
    </div>
  );
}
