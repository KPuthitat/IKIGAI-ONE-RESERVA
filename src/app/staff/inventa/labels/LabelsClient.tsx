"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLang } from "@/lib/LangProvider";
import { apiUrl } from "@/lib/url";
import { PICK_FREQ_META, type PickFreq } from "@/lib/inventa";
import { code128B } from "@/lib/code128";

export type LabelItem = {
  id: number;
  item_code: string | null;
  barcode: string | null;
  name: string;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  unit?: string | null;
  cost?: number | null;        // effective ราคาทุน (cost_price ?? unit_cost)
  category?: string | null;
  storage_location?: string | null;
  supplier_name?: string | null;
};

// QR codes are generated server-side at /api/inventa/qr (owner R2). The
// old client-side CDN loader failed silently when the CDN was blocked.
function qrSrc(code: string, size = 320): string {
  return apiUrl(`/api/inventa/qr?data=${encodeURIComponent(code)}&size=${size}`);
}

// 1-D Code 128 barcode as an inline SVG (owner 2026-06-08). Vector =
// prints crisp at any label size; dependency-free (no CDN/runtime lib).
function Barcode({ value }: { value: string }) {
  const bc = useMemo(() => code128B(value), [value]);
  if (!bc) return null;
  return (
    <svg className="lbl-bc" viewBox={`0 0 ${bc.width} 100`} preserveAspectRatio="none"
      shapeRendering="crispEdges" role="img" aria-label={value}>
      <rect x="0" y="0" width={bc.width} height="100" fill="#ffffff" />
      {bc.bars.map((b, i) => (
        <rect key={i} x={b.x} y="0" width={b.w} height="100" fill="#000000" />
      ))}
    </svg>
  );
}

// Owner 2026-06-08: the QR page is now a proper printable LABEL — name +
// code + QR + 1-D barcode, sized to a configurable sticker (default
// 80×50 mm, set in INVENTA settings). "พิมพ์" sends each chosen label to
// its own page sized to the sticker, so a thermal label printer outputs
// one sticker per item.
export default function LabelsClient({
  items, widthMm = 80, heightMm = 50
}: { items: LabelItem[]; widthMm?: number; heightMm?: number }) {
  const { t } = useLang();
  const printable = useMemo(
    () => items.filter((i) => (i.item_code || i.barcode)),
    [items]
  );

  const [q, setQ] = useState("");
  const [freqFilter, setFreqFilter] = useState<PickFreq | "">("");
  const [catFilter, setCatFilter] = useState("");
  const [supFilter, setSupFilter] = useState("");
  const [locFilter, setLocFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const categoryOptions = useMemo(
    () => [...new Set(printable.map((i) => i.category).filter((s): s is string => !!s))].sort(),
    [printable]
  );
  const supplierOptions = useMemo(
    () => [...new Set(printable.map((i) => i.supplier_name).filter((s): s is string => !!s))].sort(),
    [printable]
  );
  const locationOptions = useMemo(
    () => [...new Set(printable.map((i) => i.storage_location).filter((s): s is string => !!s))].sort(),
    [printable]
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return printable.filter((i) => {
      if (freqFilter && i.pick_freq !== freqFilter) return false;
      if (catFilter && (i.category ?? "") !== catFilter) return false;
      if (supFilter && (i.supplier_name ?? "") !== supFilter) return false;
      if (locFilter && (i.storage_location ?? "") !== locFilter) return false;
      if (!term) return true;
      return [i.name, i.item_code, i.barcode].some((v) => (v ?? "").toLowerCase().includes(term));
    });
  }, [printable, q, freqFilter, catFilter, supFilter, locFilter]);

  const chosen = useMemo(
    () => printable.filter((i) => selected.has(i.id)),
    [printable, selected]
  );

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Print CSS injected with the configured mm size: each chosen label
  // prints on its own page sized exactly to the sticker. Overrides the
  // global .printable (single-page, absolute) + A4 @page from globals.css.
  const printCss = `
    .label-sheet { display: flex; flex-wrap: wrap; gap: 10px; }
    .lbl-wrap { display: flex; flex-direction: column; align-items: center; gap: 3px; }
    .po-label {
      width: ${widthMm}mm; height: ${heightMm}mm;
      box-sizing: border-box; padding: 1.5mm;
      display: flex; flex-direction: column; overflow: hidden;
      background: #fff; color: #000;
      border: 1px solid #cbd5e1; border-radius: 2px;
    }
    .po-label .lbl-name {
      font-weight: 700; font-size: 3mm; line-height: 1.15; text-align: center;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      padding-bottom: 1mm; border-bottom: 0.25mm solid #e5e7eb;
    }
    .po-label .lbl-mid { display: flex; align-items: center; gap: 2mm; margin-top: 1.2mm; }
    .po-label .lbl-qr { width: 17mm; height: 17mm; flex: none; }
    .po-label .lbl-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.5mm; }
    .po-label .lbl-code { font-family: monospace; font-weight: 700; font-size: 3.1mm; line-height: 1.1; word-break: break-all; }
    .po-label .lbl-price { font-weight: 700; font-size: 3.4mm; line-height: 1.05; color: #111; }
    .po-label .lbl-bin { font-size: 2.3mm; color: #555; }
    .po-label .lbl-bar { margin-top: auto; padding-top: 1mm; }
    .po-label .lbl-bc { display: block; width: 100%; height: 8mm; }
    .po-label .lbl-bc-text { font-family: monospace; font-size: 2.4mm; text-align: center; letter-spacing: 0.3mm; line-height: 1.2; }
    @media print {
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      .label-sheet { position: static !important; inset: auto !important; display: block !important; }
      .label-sheet .lbl-wrap { display: block !important; break-after: page; page-break-after: always; }
      .label-sheet .lbl-wrap:last-child { break-after: auto; page-break-after: auto; }
      .po-label { border: none !important; border-radius: 0 !important; }
    }
  `;

  return (
    <>
      {/* Picker — choose which items to print (no-print). */}
      <div className="card no-print space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm text-slate-600">
            เลือกสินค้าที่ต้องการพิมพ์ฉลาก
            {selected.size > 0 && <span className="text-brand font-bold"> · เลือกแล้ว {selected.size}</span>}
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <button type="button" onClick={() => setSelected(new Set())}
                className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">
                ล้างที่เลือก
              </button>
            )}
            <button type="button"
              onClick={() => window.print()}
              disabled={chosen.length === 0}
              className="text-sm px-5 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
              {t("inv.lbl.print")}
            </button>
          </div>
        </div>

        <div className="text-xs text-slate-500">
          {t("inv.lbl.sizeLabel")} <b>{widthMm}×{heightMm} mm</b> ·{" "}
          <Link href="/staff/inventa/settings" className="text-brand hover:underline">{t("inv.lbl.sizeChange")}</Link>
        </div>

        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหาชื่อ / รหัส / บาร์โค้ด" />

        {/* Filter bar — same controls as the catalogue page. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            <button type="button" onClick={() => setFreqFilter("")}
              className={`text-xs px-2.5 py-1 rounded-full border ${freqFilter === "" ? "bg-slate-800 text-white border-slate-800" : "border-slate-300 text-slate-600"}`}>
              ทั้งหมด
            </button>
            {(["R", "Y", "G"] as PickFreq[]).map((f) => {
              const active = freqFilter === f;
              return (
                <button key={f} type="button" onClick={() => setFreqFilter(active ? "" : f)}
                  className={`text-xs px-2.5 py-1 rounded-full border inline-flex items-center gap-1 ${active ? "bg-slate-800 text-white border-slate-800" : "border-slate-300 text-slate-600"}`}>
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${PICK_FREQ_META[f].dot}`} />
                  {PICK_FREQ_META[f].short}
                </button>
              );
            })}
          </div>
          {categoryOptions.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-[220px] text-sm" value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">ทุกหมวด</option>
              {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {supplierOptions.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-[220px] text-sm" value={supFilter}
              onChange={(e) => setSupFilter(e.target.value)}>
              <option value="">ทุกผู้จำหน่าย</option>
              {supplierOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {locationOptions.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-[220px] text-sm" value={locFilter}
              onChange={(e) => setLocFilter(e.target.value)}>
              <option value="">ทุกตำแหน่ง</option>
              {locationOptions.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
          {filtered.length > 0 && (
            <button type="button" onClick={() => setSelected(new Set(filtered.map((i) => i.id)))}
              className="text-xs text-brand hover:underline ml-auto">
              เลือกทั้งหมดที่กรอง ({filtered.length})
            </button>
          )}
        </div>

        <div className="divide-y divide-slate-100 max-h-[40vh] overflow-y-auto rounded-lg border border-slate-200">
          {filtered.map((i) => {
            const isSel = selected.has(i.id);
            return (
              <button key={i.id} type="button" onClick={() => toggle(i.id)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-50 ${isSel ? "bg-rose-50" : ""}`}>
                <span className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center text-[10px] ${
                  isSel ? "bg-brand border-brand text-white" : "border-slate-300"
                }`}>{isSel ? "✓" : ""}</span>
                <span className="font-mono text-xs text-slate-500 flex-shrink-0">
                  {i.item_code || i.barcode}
                </span>
                <span className="text-sm text-slate-800 truncate">{i.name}</span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-slate-400 text-sm">
              {printable.length === 0 ? t("inv.lbl.emptyTitle") : "ไม่พบรายการ"}
            </div>
          )}
        </div>
        {printable.length === 0 && (
          <p className="text-xs text-slate-500 leading-relaxed">
            {t("inv.lbl.emptyHelp")}{" "}
            <Link href="/staff/inventa" className="text-brand font-bold hover:underline">
              {t("inv.lbl.goStock")}
            </Link>
          </p>
        )}
      </div>

      {/* Print sheet — chosen labels. printable + label-sheet so the
          injected CSS overrides the global single-page .printable. */}
      <style dangerouslySetInnerHTML={{ __html: printCss }} />
      <div className="printable label-sheet">
        {chosen.map((i) => {
          const code = (i.item_code || i.barcode) as string;
          const bin = [i.storage_location, i.grid_row && `${i.grid_row}${i.grid_col ?? ""}`]
            .filter(Boolean).join(" · ");
          return (
            <div key={i.id} className="lbl-wrap">
              <div className="po-label">
                <div className="lbl-name">{i.name}</div>
                <div className="lbl-mid">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="lbl-qr" src={qrSrc(code)} alt={code} />
                  <div className="lbl-meta">
                    <div className="lbl-code">{code}</div>
                    {i.cost != null && i.cost > 0 && (
                      <div className="lbl-price">
                        ฿{i.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        {i.unit ? <span style={{ fontWeight: 400, fontSize: "2.3mm" }}> /{i.unit}</span> : null}
                      </div>
                    )}
                    {bin && <div className="lbl-bin">{bin}</div>}
                  </div>
                </div>
                <div className="lbl-bar">
                  <Barcode value={code} />
                  <div className="lbl-bc-text">{code}</div>
                </div>
              </div>
              <a href={qrSrc(code, 512)} download={`qr-${code}.png`}
                className="no-print text-[10px] text-brand hover:underline">
                ดาวน์โหลด QR PNG
              </a>
            </div>
          );
        })}
        {chosen.length === 0 && (
          <div className="text-center text-slate-400 text-sm py-10 no-print">
            ยังไม่ได้เลือกสินค้า — เลือกจากรายการด้านบนเพื่อสร้างฉลาก
          </div>
        )}
      </div>
    </>
  );
}
