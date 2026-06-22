"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { fmtMoney } from "@/lib/format";
import {
  computeRoundBreakdown, roundLabel, TH_MONTHS_FULL, type Tier, type SalesBase
} from "@/lib/revshare";

type Partner = { id: number; name: string; sales_base: SalesBase; pos_categories: string[] };
type Round = {
  id: number; period_start: string; period_end: string; label: string | null;
  sales_amount: number; source: "manual" | "pos_import"; source_filename: string | null;
};
type PosCat = { category: string; gross: number; afterDiscount: number; nett: number };
type PosPreview = {
  filename: string; periodStart: string | null; periodEnd: string | null; label: string | null;
  categories: PosCat[];
};
const BASE_LABEL: Record<SalesBase, string> = { gross: "Gross (ก่อนส่วนลด)", after_discount: "หลังหักส่วนลด", nett: "Nett (รวม VAT)" };

export default function RoundsClient({
  partner, tiers, rounds: initialRounds, year, month
}: { partner: Partner; tiers: Tier[]; rounds: Round[]; year: number; month: number }) {
  const router = useRouter();
  const [rounds, setRounds] = useState<Round[]>(initialRounds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // manual add
  const [mStart, setMStart] = useState("");
  const [mEnd, setMEnd] = useState("");
  const [mSales, setMSales] = useState("");

  // POS import
  const [preview, setPreview] = useState<PosPreview | null>(null);
  const [selCats, setSelCats] = useState<Set<string>>(new Set());
  const [base, setBase] = useState<SalesBase>(partner.sales_base);

  const breakdown = computeRoundBreakdown(rounds.map((r) => r.sales_amount), tiers);
  const totalSales = rounds.reduce((s, r) => s + r.sales_amount, 0);
  const totalGP = breakdown.reduce((s, r) => s + r.roundGP, 0);

  function go(y: number, m: number) {
    router.push(`/admin/accounta/revshare/rounds?partner=${partner.id}&year=${y}&month=${m}`);
  }
  function shift(delta: number) {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    go(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }

  async function roundsApi(method: "POST" | "PATCH" | "DELETE", body?: unknown, qs?: string) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/revshare/rounds${qs ?? ""}`), {
        method, headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "ทำรายการไม่สำเร็จ")); return null; }
      if (j.rounds) setRounds(j.rounds);
      router.refresh();
      return j;
    } finally { setBusy(false); }
  }

  async function autoGen() { await roundsApi("POST", { partner: partner.id, action: "auto", year, month }); }
  async function addManual() {
    if (!mStart || !mEnd) return;
    const ok = await roundsApi("POST", { partner: partner.id, period_start: mStart, period_end: mEnd, sales_amount: Number(mSales) || 0 });
    if (ok) { setMStart(""); setMEnd(""); setMSales(""); }
  }
  async function saveSales(r: Round, value: string) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === r.sales_amount) return;
    await roundsApi("PATCH", { id: r.id, partner: partner.id, sales_amount: v });
  }
  async function del(r: Round) {
    if (!window.confirm(`ลบรอบ ${r.label ?? r.period_start} ?`)) return;
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
      // pre-select the partner's configured POS categories (case-insensitive)
      const want = new Set(partner.pos_categories.map((s) => s.toLowerCase()));
      setSelCats(new Set(j.categories.filter((c: PosCat) => want.has(c.category.toLowerCase())).map((c: PosCat) => c.category)));
      setBase(partner.sales_base);
    } finally { setBusy(false); }
  }
  function baseVal(c: PosCat): number { return base === "gross" ? c.gross : base === "after_discount" ? c.afterDiscount : c.nett; }
  const posTotal = preview ? preview.categories.filter((c) => selCats.has(c.category)).reduce((s, c) => s + baseVal(c), 0) : 0;

  async function confirmImport() {
    if (!preview || !preview.periodStart || !preview.periodEnd) { setErr("ไฟล์ไม่มีช่วงวันที่ที่อ่านได้"); return; }
    const ok = await roundsApi("POST", {
      partner: partner.id, period_start: preview.periodStart, period_end: preview.periodEnd,
      sales_amount: posTotal, source: "pos_import", source_filename: preview.filename, label: preview.label ?? undefined
    });
    if (ok) setPreview(null);
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-rose-600">{err}</p>}

      {/* Month nav */}
      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={() => shift(-1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">←</button>
        <span className="text-sm font-bold text-slate-700">{TH_MONTHS_FULL[month]} {year + 543}</span>
        <button type="button" onClick={() => shift(1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">→</button>
      </div>

      {/* Actions */}
      <div className="card flex flex-wrap items-center gap-2">
        <button type="button" onClick={autoGen} disabled={busy} className="btn-secondary text-sm">สร้างรอบสัปดาห์อัตโนมัติ (จ–อา + ปิดเดือน)</button>
        <label className="btn-secondary text-sm cursor-pointer">
          นำเข้าไฟล์ POS (.xlsx)
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} disabled={busy} />
        </label>
      </div>

      {/* POS import preview */}
      {preview && (
        <div className="card space-y-3 ring-1 ring-brand/30">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-bold text-slate-800">นำเข้า POS · {preview.label ?? "(ไม่พบช่วงวันที่)"} <span className="text-[11px] font-normal text-slate-400">{preview.filename}</span></div>
            <button type="button" onClick={() => setPreview(null)} className="text-xs text-slate-400 hover:text-slate-700">✕ ยกเลิก</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500">ฐานยอดขาย:</span>
            <select className="input w-48 text-sm" value={base} onChange={(e) => setBase(e.target.value as SalesBase)}>
              {(Object.keys(BASE_LABEL) as SalesBase[]).map((b) => <option key={b} value={b}>{BASE_LABEL[b]}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-slate-400 border-b border-slate-100">
                  <th className="text-left py-1.5 px-2">เลือก</th><th className="text-left py-1.5 px-2">หมวด</th>
                  <th className="text-right py-1.5 px-2">Gross</th><th className="text-right py-1.5 px-2">หลังส่วนลด</th><th className="text-right py-1.5 px-2">Nett</th>
                </tr>
              </thead>
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
            <div className="text-sm">ยอดที่จะบันทึกเป็นรอบนี้: <b className="text-brand">฿{fmtMoney(posTotal)}</b> <span className="text-[11px] text-slate-400">({BASE_LABEL[base]})</span></div>
            <button type="button" onClick={confirmImport} disabled={busy || posTotal <= 0} className="btn-primary text-sm disabled:opacity-50">ยืนยันสร้างรอบ</button>
          </div>
        </div>
      )}

      {/* Rounds table */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">รอบยอดขายของเดือนนี้</div>
        {rounds.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีรอบ — กด “สร้างรอบสัปดาห์อัตโนมัติ” หรือเพิ่มเอง/นำเข้า POS</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-[11px] text-slate-400 border-b border-slate-200">
                  <th className="text-left py-1.5 px-2">รอบ</th>
                  <th className="text-right py-1.5 px-2">ยอดขาย</th>
                  <th className="text-right py-1.5 px-2">GP รอบนี้</th>
                  <th className="text-right py-1.5 px-2">GP%</th>
                  <th className="text-left py-1.5 px-2">ที่มา</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r, i) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-1.5 px-2 text-slate-600 whitespace-nowrap">{r.label ?? `${r.period_start}–${r.period_end}`}</td>
                    <td className="py-1.5 px-2 text-right">
                      <input type="number" defaultValue={r.sales_amount} step="0.01"
                        className="input w-32 text-right text-sm py-1"
                        onBlur={(e) => saveSales(r, e.target.value)} />
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-emerald-700">{fmtMoney(breakdown[i]?.roundGP ?? 0)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-500">{((breakdown[i]?.gpPct ?? 0) * 100).toFixed(1)}%</td>
                    <td className="py-1.5 px-2 text-[11px] text-slate-400">{r.source === "pos_import" ? `POS · ${r.source_filename ?? ""}` : "กรอกเอง"}</td>
                    <td className="py-1.5 px-2 text-right"><button type="button" onClick={() => del(r)} disabled={busy} className="text-[11px] text-rose-500 hover:underline">ลบ</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 font-bold">
                  <td className="py-1.5 px-2 text-slate-700">รวมทั้งเดือน</td>
                  <td className="py-1.5 px-2 text-right font-mono">฿{fmtMoney(totalSales)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-emerald-700">฿{fmtMoney(totalGP)}</td>
                  <td colSpan={3} className="py-1.5 px-2 text-[11px] text-slate-400">GP สะสมต่อรอบ — รวมแล้วเท่ากับ GP ขั้นบันไดทั้งเดือน</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="text-[11px] text-slate-400">แก้ยอดขายได้โดยพิมพ์ในช่องแล้วคลิกออก (กด tab/คลิกที่อื่น) · GP จะคำนวณใหม่อัตโนมัติ</p>
      </div>

      {/* Manual add */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">เพิ่มรอบเอง</div>
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="label">ตั้งแต่</label><input type="date" className="input" value={mStart} onChange={(e) => setMStart(e.target.value)} /></div>
          <div><label className="label">ถึง</label><input type="date" className="input" value={mEnd} onChange={(e) => setMEnd(e.target.value)} /></div>
          <div><label className="label">ยอดขาย (฿)</label><input type="number" step="0.01" className="input w-36" value={mSales} placeholder="0.00" onChange={(e) => setMSales(e.target.value)} /></div>
          <button type="button" onClick={addManual} disabled={busy || !mStart || !mEnd} className="btn-secondary text-sm disabled:opacity-50">+ เพิ่มรอบ</button>
          {mStart && mEnd && <span className="text-[11px] text-slate-400">{roundLabel(mStart, mEnd)}</span>}
        </div>
      </div>
    </div>
  );
}
