"use client";

import { useState, useRef, Fragment } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { fmtMoney } from "@/lib/format";
import { roundLabel, mondayOf, TH_MONTHS_FULL, type Tier, type SalesBase } from "@/lib/revshare";
import PinPromptModal from "@/app/components/PinPromptModal";

type Partner = { id: number; name: string; sales_base: SalesBase; pos_categories: string[] };
type Round = {
  id: number; period_start: string; period_end: string; label: string | null;
  sales_amount: number; source: "manual" | "pos_import"; source_filename: string | null;
};
type PosCat = { category: string; gross: number; afterDiscount: number; nett: number };
type PosPreview = { filename: string; periodStart: string | null; periodEnd: string | null; label: string | null; categories: PosCat[] };
const BASE_LABEL: Record<SalesBase, string> = { gross: "Gross (ก่อนส่วนลด)", after_discount: "หลังหักส่วนลด", nett: "Nett (รวม VAT)" };
const PIN_ERRORS = new Set(["wrong_pin", "pin_invalid", "no_pin", "user_not_found"]);

export default function RoundsClient({
  partner, rounds: initialRounds, year, month, operatorName
}: { partner: Partner; tiers: Tier[]; rounds: Round[]; year: number; month: number; operatorName: string }) {
  const router = useRouter();
  const [rounds, setRounds] = useState<Round[]>(initialRounds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // PIN gate — verify once, reuse for the session; re-prompt if the server
  // rejects it. Records the operator on every import/edit/delete.
  const pinRef = useRef<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [pinRun, setPinRun] = useState<{ run: (pin: string) => Promise<{ ok: boolean; pinError?: boolean }> } | null>(null);

  // POS import
  const [preview, setPreview] = useState<PosPreview | null>(null);
  const [selCats, setSelCats] = useState<Set<string>>(new Set());
  const [base, setBase] = useState<SalesBase>(partner.sales_base);
  // Category selection is pre-filled from the partner's settings and LOCKED;
  // changing it requires a PIN (owner 2026-06-23).
  const [catsLocked, setCatsLocked] = useState(true);

  const totalSales = rounds.reduce((s, r) => s + r.sales_amount, 0);
  // Group daily entries into ISO weeks (the weekly TRANSFER amount).
  const weekMap = new Map<string, Round[]>();
  for (const r of [...rounds].sort((a, b) => a.period_start.localeCompare(b.period_start))) {
    const wk = mondayOf(r.period_start);
    (weekMap.get(wk) ?? weekMap.set(wk, []).get(wk)!).push(r);
  }
  const weeks = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([wk, rs]) => ({
    wk, rounds: rs, total: rs.reduce((s, r) => s + r.sales_amount, 0),
    label: roundLabel(rs[0].period_start, rs[rs.length - 1].period_start)
  }));

  function go(y: number, m: number) { router.push(`/admin/accounta/revshare/rounds?partner=${partner.id}&year=${y}&month=${m}`); }
  function shift(delta: number) { const d = new Date(Date.UTC(year, month - 1 + delta, 1)); go(d.getUTCFullYear(), d.getUTCMonth() + 1); }

  // Low-level mutate: returns {ok, pinError}. Non-PIN errors are surfaced on the
  // page; PIN errors bubble up so the modal can ask again.
  async function mutate(method: "POST" | "PATCH" | "DELETE", body?: unknown, qs?: string): Promise<{ ok: boolean; pinError?: boolean }> {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/revshare/rounds${qs ?? ""}`), {
        method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { if (j.rounds) setRounds(j.rounds); router.refresh(); return { ok: true }; }
      const pinError = PIN_ERRORS.has(j.error);
      if (!pinError) setErr(humanizeApiError(j, "ทำรายการไม่สำเร็จ"));
      return { ok: false, pinError };
    } finally { setBusy(false); }
  }

  // Run a PIN-stamped action. Reuse the verified PIN silently; re-prompt only if
  // the server rejects it (or none is cached yet).
  async function guarded(run: (pin: string) => Promise<{ ok: boolean; pinError?: boolean }>) {
    if (pinRef.current) {
      const r = await run(pinRef.current);
      if (r.ok || !r.pinError) return;
      pinRef.current = null; setVerified(false);
    }
    setPinRun({ run });
  }
  async function onPinSubmit(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const r = await pinRun!.run(pin);
    if (r.ok) { pinRef.current = pin; setVerified(true); setPinRun(null); return { ok: true }; }
    if (r.pinError) return { ok: false, message: "pin_invalid" };
    setPinRun(null);                      // non-PIN error already shown on page
    return { ok: true };
  }

  // Verify the caller's own PIN without a DB write (used to unlock category edit).
  async function verifyPin(pin: string): Promise<{ ok: boolean; pinError?: boolean }> {
    const res = await fetch(apiUrl("/api/auth/verify-pin"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin })
    });
    return { ok: res.ok, pinError: !res.ok };
  }
  function unlockCats() {
    void guarded(async (pin) => { const r = await verifyPin(pin); if (r.ok) setCatsLocked(false); return r; });
  }

  async function saveSales(r: Round, value: string) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === r.sales_amount) return;
    await guarded((pin) => mutate("PATCH", { id: r.id, partner: partner.id, sales_amount: v, pin }));
  }
  async function del(r: Round) {
    if (!window.confirm(`ลบยอดวันที่ ${roundLabel(r.period_start, r.period_start)} ?`)) return;
    await guarded(async (pin) => {
      const res = await mutate("DELETE", undefined, `?id=${r.id}&partner=${partner.id}&pin=${encodeURIComponent(pin)}`);
      // DELETE doesn't echo the list back — drop the row locally so it disappears
      // immediately (no manual refresh, owner 2026-06-23).
      if (res.ok) setRounds((rs) => rs.filter((x) => x.id !== r.id));
      return res;
    });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch(apiUrl("/api/accounta/revshare/pos-import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "อ่านไฟล์ POS ไม่สำเร็จ")); return; }
      setPreview({ filename: j.filename, periodStart: j.periodStart, periodEnd: j.periodEnd, label: j.label, categories: j.categories });
      const want = new Set(partner.pos_categories.map((s) => s.toLowerCase()));
      setSelCats(new Set(j.categories.filter((c: PosCat) => want.has(c.category.toLowerCase())).map((c: PosCat) => c.category)));
      setBase(partner.sales_base);
      setCatsLocked(true);   // re-lock for every new file
    } finally { setBusy(false); }
  }
  function baseVal(c: PosCat): number { return base === "gross" ? c.gross : base === "after_discount" ? c.afterDiscount : c.nett; }
  const posTotal = preview ? preview.categories.filter((c) => selCats.has(c.category)).reduce((s, c) => s + baseVal(c), 0) : 0;
  const posMultiDay = !!preview && preview.periodStart !== preview.periodEnd;

  async function confirmImport() {
    if (!preview || !preview.periodStart || !preview.periodEnd) { setErr("ไฟล์ไม่มีวันที่ที่อ่านได้"); return; }
    const ps = preview.periodStart, pe = preview.periodEnd;
    await guarded(async (pin) => {
      const r = await mutate("POST", {
        partner: partner.id, period_start: ps, period_end: pe,
        sales_amount: posTotal, source: "pos_import", source_filename: preview.filename, label: preview.label ?? undefined, pin
      });
      if (r.ok) setPreview(null);
      return r;
    });
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}

      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={() => shift(-1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">←</button>
        <span className="text-sm font-bold text-slate-700">{TH_MONTHS_FULL[month]} {year + 543}</span>
        <button type="button" onClick={() => shift(1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">→</button>
      </div>

      <div className="card text-[11px] text-slate-500">
        จังหวะการทำงาน: <b className="text-slate-700">นำเข้าไฟล์ยอดขายประจำวัน</b> → ระบบรวม <b className="text-slate-700">ยอดโอนรายสัปดาห์</b> (จ–อา) ให้อัตโนมัติ → <b className="text-slate-700">คำนวณ GP รายเดือน</b> ที่หน้าสรุป
      </div>

      <div className="card flex flex-wrap items-center gap-2">
        <label className="btn-secondary text-sm cursor-pointer">
          นำเข้าไฟล์ยอดขายประจำวัน
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} disabled={busy} />
        </label>
        <span className="text-[11px] text-slate-400">
          1 วัน/ไฟล์ · นำเข้าจากไฟล์เท่านั้น (เพิ่มยอดเองไม่ได้) · แก้ไขได้หลังนำเข้า
          {verified && <span className="ml-1 text-emerald-600">· ✓ ยืนยันตัวตนแล้ว ({operatorName})</span>}
        </span>
      </div>

      {/* Sales-file import preview */}
      {preview && (
        <div className="card space-y-3 ring-1 ring-brand/30">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-bold text-slate-800">นำเข้ายอดขาย · {preview.label ?? "(ไม่พบวันที่)"} <span className="text-[11px] font-normal text-slate-400">{preview.filename}</span></div>
            <button type="button" onClick={() => setPreview(null)} className="text-xs text-slate-400 hover:text-slate-700">✕ ยกเลิก</button>
          </div>
          {posMultiDay && <p className="text-[11px] text-amber-700">⚠ ไฟล์นี้ครอบหลายวัน ({preview.label}) — จะบันทึกเป็นรายการเดียว ถ้าต้องการรายวันให้ส่งออกจาก POS แบบ 1 วัน/ไฟล์</p>}
          <div className="flex items-center justify-between gap-2 flex-wrap rounded-md bg-slate-50 px-3 py-2">
            <span className="text-[11px] text-slate-500">
              {catsLocked
                ? "ระบบเลือกหมวดตามที่ตั้งค่าไว้ให้แล้ว — กดปลดล็อกด้วย PIN ถ้าต้องการแก้ไขการเลือก"
                : <span className="text-emerald-600">✓ ปลดล็อกแล้ว — แก้ไขหมวด/ฐานยอดได้</span>}
            </span>
            {catsLocked
              ? <button type="button" onClick={unlockCats} disabled={busy} className="text-[11px] text-brand hover:underline">✎ แก้ไขการเลือกหมวด (PIN)</button>
              : <button type="button" onClick={() => setCatsLocked(true)} className="text-[11px] text-slate-400 hover:underline">ล็อกอีกครั้ง</button>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500">ฐานยอดขาย:</span>
            <select className="input w-48 text-sm disabled:bg-slate-100 disabled:text-slate-400" value={base} disabled={catsLocked} onChange={(e) => setBase(e.target.value as SalesBase)}>
              {(Object.keys(BASE_LABEL) as SalesBase[]).map((b) => <option key={b} value={b}>{BASE_LABEL[b]}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-100">
                <th className="text-left py-1.5 px-2">เลือก</th><th className="text-left py-1.5 px-2">หมวด</th>
                <th className="text-right py-1.5 px-2">Gross</th><th className="text-right py-1.5 px-2">หลังส่วนลด</th><th className="text-right py-1.5 px-2">Nett</th>
              </tr></thead>
              <tbody>
                {preview.categories.map((c) => (
                  <tr key={c.category} className="border-b border-slate-50">
                    <td className="py-1.5 px-2"><input type="checkbox" checked={selCats.has(c.category)} disabled={catsLocked} onChange={(e) => {
                      setSelCats((s) => { const n = new Set(s); if (e.target.checked) n.add(c.category); else n.delete(c.category); return n; });
                    }} /></td>
                    <td className="py-1.5 px-2 text-slate-700">{c.category}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtMoney(c.gross)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtMoney(c.afterDiscount)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtMoney(c.nett)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-sm">ยอดที่จะบันทึก: <b className="text-brand">฿{fmtMoney(posTotal)}</b> <span className="text-[11px] text-slate-400">({BASE_LABEL[base]})</span></div>
            <button type="button" onClick={confirmImport} disabled={busy || posTotal <= 0} className="btn-primary text-sm disabled:opacity-50">ยืนยันบันทึกยอดวันนี้</button>
          </div>
        </div>
      )}

      {/* Daily entries grouped by week (weekly transfer subtotal) */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ยอดขายรายวัน + ยอดโอนรายสัปดาห์</div>
        {rounds.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีข้อมูล — กดปุ่ม “นำเข้าไฟล์ยอดขายประจำวัน” ด้านบน</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-200">
                <th className="text-left py-1.5 px-2">วันที่</th>
                <th className="text-right py-1.5 px-2">ยอดขาย</th>
                <th className="text-left py-1.5 px-2">ที่มา</th>
                <th></th>
              </tr></thead>
              <tbody>
                {weeks.map((w) => (
                  <Fragment key={w.wk}>
                    {w.rounds.map((r) => (
                      <tr key={r.id} className="border-b border-slate-50">
                        <td className="py-1 px-2 text-slate-600 whitespace-nowrap">{roundLabel(r.period_start, r.period_start)}</td>
                        <td className="py-1 px-2 text-right">
                          <input type="number" defaultValue={r.sales_amount} step="0.01" className="input w-32 text-right text-sm py-1" onBlur={(e) => saveSales(r, e.target.value)} />
                        </td>
                        <td className="py-1 px-2 text-[11px] text-slate-400">{r.source === "pos_import" ? "นำเข้าไฟล์" : "กรอกเอง"}</td>
                        <td className="py-1 px-2 text-right"><button type="button" onClick={() => del(r)} disabled={busy} className="text-[11px] text-rose-500 hover:underline">ลบ</button></td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <td className="py-1 px-2 text-[11px] font-bold text-slate-600">ยอดโอนสัปดาห์ {w.label}</td>
                      <td className="py-1 px-2 text-right font-mono font-bold text-brand">฿{fmtMoney(w.total)}</td>
                      <td colSpan={2} className="py-1 px-2 text-[10px] text-slate-400">โอนเต็มจำนวนให้คู่ค้า</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-slate-300 font-bold">
                <td className="py-1.5 px-2 text-slate-700">รวมทั้งเดือน</td>
                <td className="py-1.5 px-2 text-right font-mono">฿{fmtMoney(totalSales)}</td>
                <td colSpan={2} className="py-1.5 px-2 text-[11px] text-slate-400">GP คำนวณรายเดือนที่หน้าสรุป</td>
              </tr></tfoot>
            </table>
          </div>
        )}
        <p className="text-[11px] text-slate-400">แก้ยอดได้โดยพิมพ์แล้วคลิกออก (ต้องยืนยัน PIN) · ยอดโอนรายสัปดาห์รวมจันทร์–อาทิตย์ให้อัตโนมัติ</p>
      </div>

      {pinRun && (
        <PinPromptModal
          title="ยืนยันตัวตนด้วย PIN"
          description={<>กรอก PIN 4 หลักของคุณเพื่อบันทึกผู้ทำรายการ (นำเข้า/แก้ไข/ลบยอดขาย)</>}
          submitLabel="ยืนยัน"
          onSubmit={onPinSubmit}
          onClose={() => setPinRun(null)}
        />
      )}
    </div>
  );
}
