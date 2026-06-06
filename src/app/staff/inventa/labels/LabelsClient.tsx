"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLang } from "@/lib/LangProvider";
import { PICK_FREQ_META, type PickFreq } from "@/lib/inventa";

export type LabelItem = {
  id: number;
  item_code: string | null;
  barcode: string | null;
  name: string;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  category?: string | null;
  storage_location?: string | null;
  supplier_name?: string | null;
};

// QR generator loaded from CDN (same no-dependency pattern as the
// camera scanner) so deploy stays a plain build.
const CDN = "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js";
type QRCodeLib = {
  toDataURL: (text: string, opts?: Record<string, unknown>) => Promise<string>;
};
function getQR(): QRCodeLib | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { QRCode?: QRCodeLib }).QRCode;
}

// Owner 2026-06-03: generating a QR for every item at once hung the page
// on a large catalogue. Now the staff PICK the items they need (search +
// tick) and only those QRs are generated.
export default function LabelsClient({ items }: { items: LabelItem[] }) {
  const { t } = useLang();
  const printable = useMemo(
    () => items.filter((i) => (i.item_code || i.barcode)),
    [items]
  );

  const [q, setQ] = useState("");
  // Filters — match the catalogue page (owner 2026-06-06): pick frequency
  // chips + category / supplier / location selects.
  const [freqFilter, setFreqFilter] = useState<PickFreq | "">("");
  const [catFilter, setCatFilter] = useState("");
  const [supFilter, setSupFilter] = useState("");
  const [locFilter, setLocFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

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

  // Generate QR data URLs only for the chosen items, whenever the
  // selection changes. Loads the CDN lib lazily on first need.
  useEffect(() => {
    if (chosen.length === 0) { setStatus("idle"); return; }
    if (typeof document !== "undefined" && !document.querySelector("script[data-qr]")) {
      const s = document.createElement("script");
      s.src = CDN; s.async = true; s.setAttribute("data-qr", "1");
      document.head.appendChild(s);
    }
    let cancelled = false;
    let tries = 0;
    setStatus("loading");
    const poll = setInterval(async () => {
      if (cancelled) return;
      tries += 1;
      const QR = getQR();
      if (!QR) {
        if (tries > 40) { clearInterval(poll); setStatus("error"); }
        return;
      }
      clearInterval(poll);
      try {
        const map: Record<number, string> = {};
        for (const it of chosen) {
          const code = (it.item_code || it.barcode) as string;
          map[it.id] = await QR.toDataURL(code, { margin: 1, width: 200 });
          if (cancelled) return;
        }
        if (!cancelled) { setUrls(map); setStatus("ready"); }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }, 250);
    return () => { cancelled = true; clearInterval(poll); };
  }, [chosen]);

  return (
    <>
      {/* Picker — choose which items to print (no-print). */}
      <div className="card no-print space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm text-slate-600">
            เลือกสินค้าที่ต้องการพิมพ์คิวอาร์โค้ด
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
              disabled={status !== "ready"}
              className="text-sm px-5 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
              {t("inv.lbl.print")}
              {status === "loading" && " …"}
            </button>
          </div>
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
            <select className="input !w-auto max-w-[42vw] sm:max-w-none text-sm" value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">ทุกหมวด</option>
              {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {supplierOptions.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-none text-sm" value={supFilter}
              onChange={(e) => setSupFilter(e.target.value)}>
              <option value="">ทุกผู้จำหน่าย</option>
              {supplierOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {locationOptions.length > 0 && (
            <select className="input !w-auto max-w-[42vw] sm:max-w-none text-sm" value={locFilter}
              onChange={(e) => setLocFilter(e.target.value)}>
              <option value="">ทุกตำแหน่ง</option>
              {locationOptions.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
          {/* Select-all-filtered shortcut — handy after narrowing by a
              supplier/location to label a whole shelf at once. */}
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
        {status === "error" && (
          <p className="text-xs text-rose-600">{t("inv.lbl.genFail")}</p>
        )}
      </div>

      {/* Print sheet — only the chosen items. */}
      <div className="printable">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {chosen.map((i) => {
            const fm = i.pick_freq ? PICK_FREQ_META[i.pick_freq] : null;
            return (
              <div key={i.id}
                className="border border-slate-300 rounded-lg p-2 flex flex-col items-center text-center break-inside-avoid">
                {urls[i.id]
                  ? <img src={urls[i.id]} alt={i.item_code ?? ""} className="w-28 h-28" />
                  : <div className="w-28 h-28 bg-slate-100 rounded" />}
                <div className="mt-1 text-[11px] font-mono text-slate-700 break-all">
                  {i.item_code || i.barcode}
                </div>
                <div className="text-xs font-medium text-slate-800 leading-tight line-clamp-2">
                  {i.name}
                </div>
                {fm && (
                  <span title={fm.label}
                    className={`mt-1 w-3 h-3 rounded-full ${fm.dot}`} />
                )}
              </div>
            );
          })}
        </div>
        {chosen.length === 0 && (
          <div className="text-center text-slate-400 text-sm py-10 no-print">
            ยังไม่ได้เลือกสินค้า — เลือกจากรายการด้านบนเพื่อสร้างคิวอาร์โค้ด
          </div>
        )}
      </div>
    </>
  );
}
