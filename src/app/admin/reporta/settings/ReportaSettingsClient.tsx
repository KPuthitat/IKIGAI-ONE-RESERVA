"use client";

import { useMemo, useState } from "react";

// ANALYTICA settings (owner 2026-09-16 → 2026-10-02): the HOD LINE group, the
// sales target (a default + per-month overrides so the goal can grow), the POS
// merchant guard, the card colour and the opening date. Operating hours are
// read-only here — they come from RESERVA, per day.

const DEFAULT_COLOR = "#0e2724";
const PRESETS = ["#0e2724", "#1e3a5f", "#5b21b6", "#9d174d", "#b45309", "#334155", "#166534", "#7c2d12"];
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

type DayHours = { dow: number; label: string; closed: boolean; open: string | null; close: string | null; breakStart: string | null; breakEnd: string | null };
type MonthTarget = { ym: string; target: number };

const fmt = (n: number) => n.toLocaleString("th-TH");
const parseNum = (s: string): number | null | "bad" => {
  const t = s.replace(/[, ]/g, "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : "bad";
};
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
  const [target, setTarget] = useState(initialTarget != null ? String(initialTarget) : "");
  const months = useMemo(upcomingMonths, []);
  // Per-month inputs: pre-filled with the stored override (blank = use the default).
  const initialByYm = useMemo(() => Object.fromEntries(initialMonthTargets.map((t) => [t.ym, String(t.target)])), [initialMonthTargets]);
  const [monthInputs, setMonthInputs] = useState<Record<string, string>>(() => Object.fromEntries(months.map((ym) => [ym, initialByYm[ym] ?? ""])));
  const [merchant, setMerchant] = useState(initialMerchant ?? "");
  const [color, setColor] = useState(initialColor ?? DEFAULT_COLOR);
  const [opensOn, setOpensOn] = useState(initialOpensOn ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const defaultNum = parseNum(target);
  // Fill the 12 months with a growth step from the default (owner: "เราจะต้องเติบโต").
  const applyGrowth = (pct: number) => {
    const base = typeof defaultNum === "number" ? defaultNum : null;
    if (!base) { setMsg({ kind: "err", text: "ใส่เป้าเริ่มต้นก่อน แล้วค่อยกดเพิ่มรายเดือน" }); return; }
    const next: Record<string, string> = {};
    months.forEach((ym, i) => { next[ym] = String(Math.round(base * Math.pow(1 + pct / 100, i) / 1000) * 1000); });
    setMonthInputs(next);
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    if (defaultNum === "bad") { setMsg({ kind: "err", text: "เป้ายอดต้องเป็นตัวเลข" }); setSaving(false); return; }
    // Only months whose input changed are sent (blank = remove the override).
    const monthTargets: Record<string, number | null> = {};
    for (const ym of months) {
      const cur = monthInputs[ym] ?? "", was = initialByYm[ym] ?? "";
      if (cur === was) continue;
      const n = parseNum(cur);
      if (n === "bad") { setMsg({ kind: "err", text: `เป้าเดือน ${ymLabel(ym)} ต้องเป็นตัวเลข` }); setSaving(false); return; }
      monthTargets[ym] = n;
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

  return (
    <div className="card space-y-5">
      {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}
      <div>
        <label className="label">LINE Group ID ของกลุ่มหัวหน้างาน (HOD)</label>
        <input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="เช่น Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="input" />
        <p className="text-xs text-slate-500 mt-1.5">
          เพิ่มบัญชี NOKHOOK OS (platform OA) เข้ากลุ่มก่อน แล้วนำ Group ID มาใส่ · เว้นว่างเพื่อปิดการส่ง
        </p>
      </div>

      {/* Targets: default + per-month overrides (owner 2026-10-02) */}
      <div>
        <label className="label">เป้ายอดขายต่อเดือน (บาท)</label>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" placeholder="เช่น 500000" className="input !w-48" />
          <span className="text-xs text-slate-500">เป้าเริ่มต้น — ใช้กับทุกเดือนที่ไม่ได้ตั้งเป้าเฉพาะ</span>
        </div>
        <div className="mt-3 rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between gap-2 flex-wrap bg-slate-50 px-3 py-2">
            <div className="text-xs font-semibold text-slate-600">เป้ารายเดือน 12 เดือนข้างหน้า <span className="font-normal text-slate-400">· เว้นว่าง = ใช้เป้าเริ่มต้น</span></div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-slate-400">เติมแบบเติบโต:</span>
              {[3, 5, 10].map((p) => (
                <button key={p} type="button" onClick={() => applyGrowth(p)} className="px-2 py-0.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:border-brand/40">+{p}%/เดือน</button>
              ))}
              <button type="button" onClick={() => setMonthInputs(Object.fromEntries(months.map((ym) => [ym, ""])))} className="px-2 py-0.5 rounded-full border border-slate-200 bg-white text-slate-500 hover:border-brand/40">ล้าง</button>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 divide-slate-100">
            {months.map((ym, i) => {
              const v = monthInputs[ym] ?? "";
              const eff = v.trim() ? parseNum(v) : defaultNum;
              return (
                <div key={ym} className={`flex items-center gap-2 px-3 py-1.5 text-sm ${i % 2 === 0 ? "sm:border-r sm:border-slate-100" : ""} ${i >= 2 ? "sm:border-t sm:border-slate-100" : ""}`}>
                  <span className="w-20 text-slate-600 shrink-0">{ymLabel(ym)}</span>
                  <input value={v} onChange={(e) => setMonthInputs((m) => ({ ...m, [ym]: e.target.value }))} inputMode="numeric"
                    placeholder={typeof defaultNum === "number" && defaultNum > 0 ? fmt(defaultNum) : "—"} className="input !py-1 !w-32 text-sm" />
                  <span className="text-[11px] text-slate-400 truncate">{typeof eff === "number" && eff > 0 ? `= ${fmt(eff)}` : "ไม่ตั้งเป้า"}</span>
                </div>
              );
            })}
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-1.5">
          ใช้แสดงแถบความคืบหน้าและคาดการณ์สิ้นเดือนของเดือนนั้น · เป้าทั้งปี = ผลรวมเป้า 12 เดือน (เดือนที่ไม่ได้ตั้งใช้เป้าเริ่มต้น)
        </p>
      </div>

      <div>
        <label className="label">วันเปิดสาขา (วันแรกที่เปิดร้าน)</label>
        <input type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} className="input !w-48" />
        <p className="text-xs text-slate-500 mt-1.5">
          สาขาที่เปิดกลางปีจะถูก<b>เฉลี่ยเป้าทั้งปี</b>และ<b>คาดการณ์รายได้</b>จากวันนี้ ไม่ใช่ทั้งปีเต็ม · ใช้ค่าเดียวกับ RESERVA · เว้นว่าง = ถือว่าเปิดมาทั้งปี
        </p>
      </div>
      <div>
        <label className="label">ชื่อร้านใน POS (Merchant) — กันไฟล์ผิดสาขา</label>
        <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="ปกติเว้นว่าง (ใช้ชื่อสาขา)" className="input" />
        <p className="text-xs text-slate-500 mt-1.5">
          กรอก<b>เฉพาะเมื่อ</b>ชื่อร้านใน POS ต่างจากชื่อสาขา — ไฟล์ที่ชื่อร้านไม่ตรงจะถูกปฏิเสธทั้งชุด · เว้นว่าง = ใช้ชื่อสาขา
        </p>
      </div>
      <div>
        <label className="label">สีการ์ดของสาขานี้ (หัวการ์ด LINE)</label>
        <div className="flex items-center gap-2 flex-wrap">
          {PRESETS.map((c) => (
            <button key={c} type="button" onClick={() => setColor(c)}
              className={`h-8 w-8 rounded-full border-2 ${color.toLowerCase() === c ? "border-slate-800 ring-2 ring-offset-1 ring-slate-300" : "border-white shadow"}`}
              style={{ backgroundColor: c }} aria-label={c} />
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-10 rounded border border-slate-200 bg-white p-0.5" />
        </div>
        {/* Live preview of the LINE card header */}
        <div className="mt-2 rounded-xl overflow-hidden max-w-xs shadow-sm">
          <div style={{ backgroundColor: color }} className="px-4 py-3">
            <div className="text-[10px]" style={{ color: "#ffffff99" }}>NOKHOOK OS · ยอดขายรายวัน</div>
            <div className="text-white font-bold">สรุปยอดขายประจำวัน</div>
            <div className="text-xs" style={{ color: "#ffffffcc" }}>ตัวอย่างหัวการ์ดของสาขานี้</div>
          </div>
        </div>
      </div>

      {/* Operating hours — RESERVA's, per day, read-only (owner 2026-10-02) */}
      <div>
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <label className="label">เวลาทำการ</label>
          <span className="text-xs text-slate-500">ดึงจาก RESERVA · <a href="/admin/reserva/settings" className="underline text-brand">แก้ที่ RESERVA</a></span>
        </div>
        <div className="rounded-xl border border-slate-200 overflow-hidden text-sm">
          {weekHours.map((d) => (
            <div key={d.dow} className="flex items-center gap-3 px-3 py-1.5 border-b border-slate-100 last:border-0">
              <span className="w-20 text-slate-600 shrink-0">{d.label}</span>
              {d.closed
                ? <span className="text-slate-400">ปิด</span>
                : d.open && d.close
                  ? <span className="tabular-nums text-slate-800">{d.open}–{d.close}{d.breakStart && d.breakEnd ? <span className="text-slate-400"> · พัก {d.breakStart}–{d.breakEnd}</span> : null}</span>
                  : <span className="text-amber-600">ยังไม่ได้ตั้งเวลาใน RESERVA</span>}
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-1.5">กราฟช่วงเวลาขายดีตรึงแกนตามเวลานี้</p>
      </div>

      <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
    </div>
  );
}
