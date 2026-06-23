"use client";

import { useState, Fragment } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { fmtMoney } from "@/lib/format";
import { roundLabel, mondayOf, TH_MONTHS_FULL, type Tier, type SalesBase } from "@/lib/revshare";

type Partner = { id: number; name: string; sales_base: SalesBase; pos_categories: string[] };
type Round = {
  id: number; period_start: string; period_end: string; label: string | null;
  sales_amount: number; source: "manual" | "pos_import"; source_filename: string | null;
};
type PosCat = { category: string; gross: number; afterDiscount: number; nett: number };
type PosPreview = { filename: string; periodStart: string | null; periodEnd: string | null; label: string | null; categories: PosCat[] };
const BASE_LABEL: Record<SalesBase, string> = { gross: "Gross (ก่อนส่วนลด)", after_discount: "หลังหักส่วนลด", nett: "Nett (รวม VAT)" };

export default function RoundsClient({
  partner, rounds: initialRounds, year, month
}: { partner: Partner; tiers: Tier[]; rounds: Round[]; year: number; month: number }) {
  const router = useRouter();
  const [rounds, setRounds] = useState<Round[]>(initialRounds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // manual daily add
  const [mDate, setMDate] = useState("");
  const [mSales, setMSales] = useState("");

  // POS import
  const [preview, setPreview] = useState<PosPreview | null>(null);
  const [selCats, setSelCats] = useState<Set<string>>(new Set());
  const [base, setBase] = useState<SalesBase>(partner.sales_base);

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

  async function roundsApi(method: "POST" | "PATCH" | "DELETE", body?: unknown, qs?: string) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/revshare/rounds${qs ?? ""}`), {
        method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ทำรายการไม่สำเร็จ")); return null; }
      if (j.rounds) setRounds(j.rounds);
      router.refresh();
      return j;
    } finally { setBusy(false); }
  }

  async function addManual() {
    if (!mDate) return;
    const ok = await roundsApi("POST", { partner: partner.id, period_start: mDate, period_end: mDate, sales_amount: Number(mSales) || 0 });
    if (ok) { setMDate(""); setMSales(""); }
  }
  async function saveSales(r: Round, value: string) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === r.sales_amount) return;
    await roundsApi("PATCH", { id: r.id, partner: partner.id, sales_amount: v });
  }
  async function del(r: Round) {
    if (!window.confirm(`ลบยอดวันที่ ${roundLabel(r.period_start, r.period_start)} ?`)) return;
    await roundsApi("DELETE", undefined, `?id=${r.id}&partner=${partner.id}`);
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
    } finally { setBusy(false); }
  }
  function baseVal(c: PosCat): number { return base === "gross" ? c.gross : base === "after_discount" ? c.afterDiscount : c.nett; }
  const posTotal = preview ? preview.categories.filter((c) => selCats.has(c.category)).reduce((s, c) => s + baseVal(c), 0) : 0;
  const posMultiDay = !!preview && preview.periodStart !== preview.periodEnd;

  async function confirmImport() {
    if (!preview || !preview.periodStart || !preview.periodEnd) { setErr("ไฟล์ไม่มีวันที่ที่อ่านได้"); return; }
    const ok = await roundsApi("POST", {
      partner: partner.id, period_start: preview.periodStart, period_end: preview.periodEnd,
      sales_amount: posTotal, source: "pos_import", source_filename: preview.filename, label: preview.label ?? undefined
    });
    if (ok) setPreview(null);
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
        จังหวะการทำงาน: <b className="text-slate-700">นำเข้า POS รายวัน</b> → ระบบรวม <b className="text-slate-700">ยอดโอนรายสัปดาห์</b> (จ–อา) ให้อัตโนมัติ → <b className="text-slate-700">คำนวณ GP รายเดือน</b> ที่หน้าสรุป
      </div>

      <div className="card flex flex-wrap items-center gap-2">
        <label className="btn-secondary text-sm cursor-pointer">
          นำเข้าไฟล์ POS (1 วัน/ไฟล์)
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} disabled={busy} />
        </label>
        <span className="text-[11px] text-slate-400">หรือเพิ่มยอดรายวันเองด้านล่าง</span>
      </div>

      {/* POS import preview */}
      {preview && (
        <div className="card space-y-3 ring-1 ring-brand/30">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-bold text-slate-800">นำเข้า POS · {preview.label ?? "(ไม่พบวันที่)"} <span className="text-[11px] font-normal text-slate-400">{preview.filename}</span></div>
            <button type="button" onClick={() => setPreview(null)} className="text-xs text-slate-400 hover:text-slate-700">✕ ยกเลิก</button>
          </div>
          {posMultiDay && <p className="text-[11px] text-amber-700">⚠ ไฟล์นี้ครอบหลายวัน ({preview.label}) — จะบันทึกเป็นรายการเดียว ถ้าต้องการรายวันให้ส่งออกจาก POS แบบ 1 วัน/ไฟล์</p>}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500">ฐานยอดขาย:</span>
            <select className="input w-48 text-sm" value={base} onChange={(e) => setBase(e.target.value as SalesBase)}>
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
                    <td className="py-1.5 px-2"><input type="checkbox" checked={selCats.has(c.category)} onChange={(e) => {
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
          <p className="text-xs text-slate-400">ยังไม่มีข้อมูล — นำเข้า POS รายวัน หรือเพิ่มยอดเองด้านล่าง</p>
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
                        <td className="py-1 px-2 text-[11px] text-slate-400">{r.source === "pos_import" ? "POS" : "กรอกเอง"}</td>
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
        <p className="text-[11px] text-slate-400">แก้ยอดได้โดยพิมพ์แล้วคลิกออก · ยอดโอนรายสัปดาห์รวมจันทร์–อาทิตย์ให้อัตโนมัติ</p>
      </div>

      {/* Manual daily add */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">เพิ่มยอดรายวันเอง</div>
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="label">วันที่</label><input type="date" className="input" value={mDate} onChange={(e) => setMDate(e.target.value)} /></div>
          <div><label className="label">ยอดขาย (฿)</label><input type="number" step="0.01" className="input w-36" value={mSales} placeholder="0.00" onChange={(e) => setMSales(e.target.value)} /></div>
          <button type="button" onClick={addManual} disabled={busy || !mDate} className="btn-secondary text-sm disabled:opacity-50">+ เพิ่มยอดวันนี้</button>
          {mDate && <span className="text-[11px] text-slate-400">{roundLabel(mDate, mDate)}</span>}
        </div>
      </div>
    </div>
  );
}
