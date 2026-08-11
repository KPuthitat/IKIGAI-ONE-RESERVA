"use client";

import { useState, type ChangeEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import BarcodeScanner from "@/app/components/BarcodeScanner";

const NAVY = "#0B1F3A";
const GOLD = "#C9A227";

export type PendingOrder = {
  code: string; staffName: string; menuName: string | null;
  mealClass: string; credits: number; baht: number;
};
export type MealpassCfg = {
  enabled: number; redeem_cutoff: string; monthly_cap: number;
  full_day_credits: number; half_day_credits: number; standard_credit_cost: number;
  special_rate: number; cash_discount: number; cross_company_cap_baht: number;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="text-xs text-slate-500">{label}</span>{children}</label>;
}

const ERR_TH: Record<string, string> = {
  not_found: "ไม่พบรหัสนี้",
  already_confirmed: "รหัสนี้ยืนยันไปแล้ว",
  not_pending: "รหัสนี้ใช้ไม่ได้แล้ว",
  insufficient: "เครดิตพนักงานไม่พอ (อาจถูกใช้ไปแล้ว)",
  override_reason_required: "กรุณากรอกเหตุผล",
  no_drink_chosen: "พนักงานยังไม่ได้เลือกเครื่องดื่ม",
};

export default function MealpassConfirmClient({ pending, config }: { pending: PendingOrder[]; config: MealpassCfg }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<MealpassCfg>(config);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgSaved, setCfgSaved] = useState(false);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ code: string; text: string; ok: boolean } | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [scanning, setScanning] = useState(false);

  // Pull an MP-/DR- code out of a scanned QR string (the QR encodes the code
  // verbatim, but tolerate stray whitespace / a wrapping URL just in case).
  function extractCode(raw: string): string {
    const s = raw.trim().toUpperCase();   // match manual entry, which always uppercases
    const m = s.match(/\b(?:MP|DR)-[A-Z0-9]+/);
    return m ? m[0] : s;
  }

  async function confirm(code: string, override = false) {
    if (!code.trim()) return;
    setBusy(code); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/mealpass/confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), action: "confirm", override, overrideReason: override ? reason : undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ code, text: "ยืนยันแล้ว ✓", ok: true });
        setOverrideFor(null); setReason(""); setManual("");
        router.refresh();
      } else if (j.error === "override_required") {
        setOverrideFor(code);   // ask for a reason (past cutoff)
      } else {
        setMsg({ code, text: ERR_TH[j.error] ?? "ยืนยันไม่สำเร็จ", ok: false });
      }
    } catch { setMsg({ code, text: "เชื่อมต่อไม่ได้", ok: false }); }
    setBusy(null);
  }

  async function saveConfig() {
    setCfgBusy(true); setCfgSaved(false);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/mealpass/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: cfg.enabled === 1,
          redeem_cutoff: cfg.redeem_cutoff,
          monthly_cap: cfg.monthly_cap,
          full_day_credits: cfg.full_day_credits,
          half_day_credits: cfg.half_day_credits,
          standard_credit_cost: cfg.standard_credit_cost,
          special_rate: cfg.special_rate,
          cash_discount: cfg.cash_discount,
          cross_company_cap_baht: cfg.cross_company_cap_baht,
        }),
      });
      if (res.ok) { setCfgSaved(true); router.refresh(); }
    } finally { setCfgBusy(false); }
  }
  const num = (k: keyof MealpassCfg) => (e: ChangeEvent<HTMLInputElement>) =>
    setCfg({ ...cfg, [k]: Number(e.target.value) });

  return (
    <div className="space-y-4">
      {scanning && (
        <BarcodeScanner
          title="สแกน QR ของพนักงาน (อาหาร MP / เครื่องดื่ม DR)"
          onResult={(text) => { setScanning(false); confirm(extractCode(text)); }}
          onClose={() => setScanning(false)}
        />
      )}

      {/* Scan / manual code entry — the primary action, kept at the very top */}
      <div className="card space-y-2">
        <button className="w-full py-4 rounded-xl text-lg font-bold text-white active:scale-95 transition"
          style={{ background: NAVY }} onClick={() => { setMsg(null); setScanning(true); }}>
          สแกน QR ของพนักงาน
        </button>
        <div className="text-center text-xs text-slate-400">— หรือพิมพ์รหัสเอง (กล้องมีปัญหา) —</div>
        <label className="label !text-xs">กรอกรหัส MP-xxxx (อาหาร) หรือ DR-xxxx (เครื่องดื่ม)</label>
        <div className="flex gap-2">
          <input className="input flex-1 font-mono uppercase" value={manual}
            onChange={(e) => setManual(e.target.value.toUpperCase())} placeholder="MP-XXXXXX / DR-XXXXXX" />
          <button className="btn-primary" disabled={!manual.trim() || busy === manual} onClick={() => confirm(manual)}>ยืนยัน</button>
        </div>
        {msg && !pending.some((p) => p.code === msg.code) && (
          <div className={`mt-2 text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</div>
        )}
      </div>

      {/* Pending list */}
      <div>
        <div className="text-sm font-semibold mb-2" style={{ color: NAVY }}>รอยืนยันวันนี้ ({pending.length})</div>
        {pending.length === 0 ? (
          <div className="card text-sm text-slate-400">ไม่มีรายการรอยืนยัน</div>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.code} className="card">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono font-bold tracking-widest" style={{ color: GOLD }}>{p.code}</div>
                    <div className="text-sm text-slate-700 truncate">{p.staffName} · {p.menuName}</div>
                    <div className="text-xs text-slate-500">
                      {p.mealClass === "cash" ? `เงินสด ${p.baht.toLocaleString()} บาท` : `หัก ${p.credits} เครดิต`}
                    </div>
                  </div>
                  <button className="btn-primary shrink-0" disabled={busy === p.code} onClick={() => confirm(p.code)}>
                    {busy === p.code ? "…" : "ยืนยัน"}
                  </button>
                </div>
                {overrideFor === p.code && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <div className="text-xs text-amber-700 mb-1">เลยเวลาใช้สิทธิ์แล้ว — ต้องระบุเหตุผลเพื่ออนุมัติ (override)</div>
                    <div className="flex gap-2">
                      <input className="input flex-1 !text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เหตุผล เช่น ลูกค้าแน่นช่วงเที่ยง" />
                      <button className="rounded-md px-3 py-2 text-sm font-medium text-white" style={{ background: GOLD }}
                        disabled={!reason.trim() || busy === p.code} onClick={() => confirm(p.code, true)}>อนุมัติ</button>
                    </div>
                  </div>
                )}
                {msg?.code === p.code && (
                  <div className={`mt-2 text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Branch config — collapsed by default so the scanner stays the focus.
          Admins rarely change settings mid-shift; scanning is the daily job. */}
      <details className="card [&::-webkit-details-marker]:hidden">
        <summary className="flex items-center justify-between cursor-pointer list-none gap-3">
          <div className="min-w-0">
            <div className="font-bold" style={{ color: NAVY }}>ตั้งค่าระบบ MEALPASS · ประจำสาขา</div>
            <div className="text-xs text-slate-400 mt-0.5">แตะเพื่อขยายและจัดการการตั้งค่า</div>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${cfg.enabled === 1 ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
            {cfg.enabled === 1 ? "เปิดใช้งาน" : "ปิดใช้งาน"}
          </span>
        </summary>
        <div className="space-y-3 mt-3 border-t border-slate-100 pt-3">
          {/* Primary control: an explicit on/off switch for the branch. */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: NAVY }}>สถานะการให้บริการ MEALPASS</div>
              <div className={`text-xs mt-0.5 ${cfg.enabled === 1 ? "text-emerald-600" : "text-slate-500"}`}>
                {cfg.enabled === 1
                  ? "เปิดใช้งานอยู่ — พนักงานของสาขานี้สามารถใช้สิทธิ์ได้"
                  : "ปิดใช้งานอยู่ — พนักงานจะยังไม่เห็นเมนู MEALPASS"}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={cfg.enabled === 1}
              aria-label="เปิดหรือปิดการให้บริการ MEALPASS ประจำสาขา"
              onClick={() => setCfg({ ...cfg, enabled: cfg.enabled === 1 ? 0 : 1 })}
              className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors"
              style={{ background: cfg.enabled === 1 ? "#059669" : "#cbd5e1" }}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${cfg.enabled === 1 ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="เวลาปิดใช้สิทธิ์ (HH:MM)"><input className="input" value={cfg.redeem_cutoff} onChange={(e) => setCfg({ ...cfg, redeem_cutoff: e.target.value })} placeholder="15:00" /></Field>
            <Field label="เพดานเครดิต/เดือน"><input type="number" className="input text-right font-mono" value={cfg.monthly_cap} onChange={num("monthly_cap")} /></Field>
            <Field label="เต็มวันได้ (เครดิต)"><input type="number" className="input text-right font-mono" value={cfg.full_day_credits} onChange={num("full_day_credits")} /></Field>
            <Field label="ครึ่งวันได้ (เครดิต)"><input type="number" className="input text-right font-mono" value={cfg.half_day_credits} onChange={num("half_day_credits")} /></Field>
            <Field label="เมนูมาตรฐาน หัก (เครดิต)"><input type="number" className="input text-right font-mono" value={cfg.standard_credit_cost} onChange={num("standard_credit_cost")} /></Field>
            <Field label="เมนูพิเศษ (% ของราคา)"><input type="number" step="1" className="input text-right font-mono" value={Math.round(cfg.special_rate * 100)} onChange={(e) => setCfg({ ...cfg, special_rate: Number(e.target.value) / 100 })} /></Field>
            <Field label="จ่ายเงินสด ส่วนลด (%)"><input type="number" step="1" className="input text-right font-mono" value={Math.round(cfg.cash_discount * 100)} onChange={(e) => setCfg({ ...cfg, cash_discount: Number(e.target.value) / 100 })} /></Field>
            <Field label="เพดานแขวนข้ามบริษัท/เดือน (บาท)"><input type="number" className="input text-right font-mono" value={cfg.cross_company_cap_baht} onChange={num("cross_company_cap_baht")} /></Field>
          </div>
          <div className="flex items-center gap-3">
            <button className="btn-primary" disabled={cfgBusy} onClick={saveConfig}>{cfgBusy ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}</button>
            {cfgSaved
              ? <span className="text-sm text-emerald-600">บันทึกแล้ว ✓</span>
              : <span className="text-xs text-slate-400">การเปลี่ยนสถานะจะมีผลเมื่อกดบันทึก</span>}
          </div>
        </div>
      </details>
    </div>
  );
}
