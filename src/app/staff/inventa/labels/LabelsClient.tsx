"use client";

import {
  type CSSProperties, type Dispatch, type SetStateAction,
  type PointerEvent as ReactPointerEvent,
  useMemo, useRef, useState
} from "react";
import Link from "next/link";
import { useLang } from "@/lib/LangProvider";
import { apiUrl } from "@/lib/url";
import { PICK_FREQ_META, type PickFreq } from "@/lib/inventa";
import { code128B } from "@/lib/code128";
import {
  parseLabelLayout, DEFAULT_LABEL_LAYOUT, LABEL_ELEMENT_KEYS, LABEL_ELEMENT_LABEL,
  type LabelLayout, type LabelElement, type LabelElementKey
} from "@/lib/label-layout";

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
  sale?: number | null;        // ราคาขาย (price_opd) — for power-outage reference
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
function Barcode({ value, fill }: { value: string; fill?: boolean }) {
  const bc = useMemo(() => code128B(value), [value]);
  if (!bc) return null;
  return (
    <svg className={fill ? undefined : "lbl-bc"}
      style={fill ? { display: "block", width: "100%", height: "100%" } : undefined}
      viewBox={`0 0 ${bc.width} 100`} preserveAspectRatio="none"
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
  items, widthMm = 80, heightMm = 50, layoutJson = null
}: { items: LabelItem[]; widthMm?: number; heightMm?: number; layoutJson?: string | null }) {
  const { t } = useLang();

  // Drag-designed layout (owner 2026-06-09). `layout` (null = built-in flex
  // look) drives the printed label; `draft` is the editor's working copy.
  const savedLayout = useMemo(() => parseLabelLayout(layoutJson), [layoutJson]);
  const [layout, setLayout] = useState<LabelLayout | null>(savedLayout);
  const [designing, setDesigning] = useState(false);
  const [draft, setDraft] = useState<LabelLayout>(savedLayout ?? DEFAULT_LABEL_LAYOUT);
  const [layoutSaving, setLayoutSaving] = useState(false);
  // Surface save outcome — a silent failure here was why a saved layout
  // seemed to "disappear" on re-entry (owner 2026-06-10): the client only
  // acted on res.ok and showed nothing when the PATCH errored.
  const [layoutMsg, setLayoutMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function layoutErrText(error: string | undefined): string {
    if (error === "no_active_branch") return "ยังไม่ได้เลือกสาขา — เลือกสาขาก่อนบันทึกรูปแบบฉลาก";
    if (error === "invalid_layout") return "รูปแบบฉลากไม่ถูกต้อง";
    return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
  }

  async function saveLayout() {
    setLayoutSaving(true);
    setLayoutMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/label-layout"), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: draft })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setLayout(draft);
        setDesigning(false);
        setLayoutMsg({ kind: "ok", text: "บันทึกรูปแบบฉลากแล้ว" });
      } else {
        setLayoutMsg({ kind: "err", text: layoutErrText(j?.error) });
      }
    } catch {
      setLayoutMsg({ kind: "err", text: "เครือข่ายมีปัญหา ลองใหม่อีกครั้ง" });
    } finally { setLayoutSaving(false); }
  }
  async function resetLayout() {
    setLayoutSaving(true);
    setLayoutMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/label-layout"), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setLayout(null); setDraft(DEFAULT_LABEL_LAYOUT); setDesigning(false);
        setLayoutMsg({ kind: "ok", text: "กลับเป็นรูปแบบมาตรฐานแล้ว" });
      } else {
        setLayoutMsg({ kind: "err", text: layoutErrText(j?.error) });
      }
    } finally { setLayoutSaving(false); }
  }
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
      /* All label text in LINE Seed Sans TH (owner 2026-06-10) — literal
         'monospace' below was rendering in the browser's mono font. */
      font-family: var(--font-lineseed), ui-sans-serif, system-ui, sans-serif;
    }
    .po-label .lbl-name {
      font-weight: 700; font-size: 3mm; line-height: 1.15; text-align: center;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      padding-bottom: 1mm; border-bottom: 0.25mm solid #e5e7eb;
    }
    .po-label .lbl-mid { display: flex; align-items: center; gap: 2mm; margin-top: 1.2mm; }
    .po-label .lbl-qr { width: 17mm; height: 17mm; flex: none; }
    .po-label .lbl-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.5mm; }
    .po-label .lbl-code { font-weight: 700; font-size: 3.1mm; line-height: 1.1; word-break: break-all; }
    .po-label .lbl-price { font-weight: 700; font-size: 3.4mm; line-height: 1.05; color: #111; }
    .po-label .lbl-bin { font-size: 2.3mm; color: #555; }
    .po-label .lbl-bar { margin-top: auto; padding-top: 1mm; }
    .po-label .lbl-bc { display: block; width: 100%; height: 8mm; }
    .po-label .lbl-bc-text { font-size: 2.4mm; text-align: center; letter-spacing: 0.3mm; line-height: 1.2; }
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

        {/* Drag-and-drop label designer (owner 2026-06-09) */}
        <div className="border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm text-slate-600">
              หน้าตาฉลาก{" "}
              {layout
                ? <span className="text-emerald-700 text-xs font-medium">· ออกแบบเอง</span>
                : <span className="text-slate-400 text-xs">· รูปแบบมาตรฐาน</span>}
            </div>
            <button
              type="button"
              onClick={() => { setDraft(layout ?? DEFAULT_LABEL_LAYOUT); setDesigning((d) => !d); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-brand text-brand font-bold hover:bg-amber-50"
            >
              {designing ? "ปิดตัวออกแบบ" : "ออกแบบฉลาก (ลากวาง)"}
            </button>
          </div>
          {layoutMsg && (
            <p className={`text-xs mt-1.5 ${layoutMsg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
              {layoutMsg.kind === "ok" ? "✓ " : "✗ "}{layoutMsg.text}
            </p>
          )}
          {designing && (
            <LabelDesigner
              draft={draft}
              setDraft={setDraft}
              widthMm={widthMm}
              heightMm={heightMm}
              sample={chosen[0] ?? printable[0] ?? null}
              saving={layoutSaving}
              hasSaved={!!layout}
              onSave={saveLayout}
              onReset={resetLayout}
            />
          )}
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
              {layout ? (
                <div className="po-label" style={{ position: "relative", padding: 0 }}>
                  <AbsBody i={i} L={layout} />
                </div>
              ) : (
              <div className="po-label">
                <div className="lbl-name">{i.name}</div>
                <div className="lbl-mid">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="lbl-qr" src={qrSrc(code)} alt={code} />
                  <div className="lbl-meta">
                    <div className="lbl-code">{code}</div>
                    {/* Both prices on the sticker so it's usable when the
                        system is unreachable (owner "เผื่อไฟดับ"). */}
                    {((i.cost != null && i.cost > 0) || (i.sale != null && i.sale > 0)) && (
                      <div className="lbl-price">
                        {i.cost != null && i.cost > 0 && (
                          <div style={{ fontWeight: 400, fontSize: "2.6mm" }}>
                            ราคาทุน ฿{i.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            {i.unit ? `/${i.unit}` : ""}
                          </div>
                        )}
                        {i.sale != null && i.sale > 0 && (
                          <div>
                            ราคาขาย ฿{i.sale.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            {i.unit ? `/${i.unit}` : ""}
                          </div>
                        )}
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
              )}
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

// ── Shared price/code helpers (flex + absolute renders) ──────────────
function costLine(i: LabelItem): string | null {
  return i.cost != null && i.cost > 0
    ? `ราคาทุน ฿${i.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}${i.unit ? `/${i.unit}` : ""}`
    : null;
}
function saleLine(i: LabelItem): string | null {
  return i.sale != null && i.sale > 0
    ? `ราคาขาย ฿${i.sale.toLocaleString(undefined, { maximumFractionDigits: 2 })}${i.unit ? `/${i.unit}` : ""}`
    : null;
}
function labelCodeOf(i: LabelItem): string { return (i.item_code || i.barcode || "") as string; }
function binOf(i: LabelItem): string {
  return [i.storage_location, i.grid_row && `${i.grid_row}${i.grid_col ?? ""}`]
    .filter(Boolean).join(" · ");
}

// Absolute-positioned label body, driven by the drag-designed layout.
// Used both in the print sheet and the designer preview.
function AbsBody({ i, L }: { i: LabelItem; L: LabelLayout }) {
  const code = labelCodeOf(i);
  const bin = binOf(i);
  const cost = costLine(i);
  const sale = saleLine(i);
  const at = (e: LabelLayout[LabelElementKey]): CSSProperties => ({
    position: "absolute", left: `${e.x}%`, top: `${e.y}%`
  });
  const txt = (e: LabelLayout[LabelElementKey], extra?: CSSProperties): CSSProperties => ({
    ...at(e), width: `${e.w}%`, fontSize: `${e.size}mm`, lineHeight: 1.12,
    textAlign: e.align ?? "left", overflow: "hidden", ...extra
  });
  return (
    <>
      {L.name.show && <div style={txt(L.name, { fontWeight: 700 })}>{i.name}</div>}
      {L.qr.show && code && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qrSrc(code)} alt={code}
          style={{ ...at(L.qr), width: `${L.qr.size}mm`, height: `${L.qr.size}mm` }} />
      )}
      {L.code.show && code && (
        <div style={txt(L.code, { fontWeight: 700, wordBreak: "break-all" })}>{code}</div>
      )}
      {L.cost.show && cost && <div style={txt(L.cost)}>{cost}</div>}
      {L.sale.show && sale && <div style={txt(L.sale, { fontWeight: 700 })}>{sale}</div>}
      {L.bin.show && bin && <div style={txt(L.bin, { color: "#555" })}>{bin}</div>}
      {L.barcode.show && code && (
        <div style={{ ...at(L.barcode), width: `${L.barcode.w}%`, height: `${L.barcode.size}mm` }}>
          <Barcode value={code} fill />
        </div>
      )}
    </>
  );
}

// ── Drag-and-drop label designer (owner 2026-06-09) ──────────────────
function Stepper({ label, value, step, min, max, onChange }: {
  label: string; value: number; step: number; min: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onChange(Math.max(min, value - step))}
          className="w-6 h-6 rounded border border-slate-300 text-slate-600">−</button>
        <span className="w-12 text-center font-mono">{value}</span>
        <button type="button" onClick={() => onChange(Math.min(max, value + step))}
          className="w-6 h-6 rounded border border-slate-300 text-slate-600">+</button>
      </div>
    </div>
  );
}

function LabelDesigner({
  draft, setDraft, widthMm, heightMm, sample, saving, hasSaved, onSave, onReset
}: {
  draft: LabelLayout;
  setDraft: Dispatch<SetStateAction<LabelLayout>>;
  widthMm: number; heightMm: number;
  sample: LabelItem | null;
  saving: boolean; hasSaved: boolean;
  onSave: () => void; onReset: () => void;
}) {
  const PXMM = 4.4;
  const W = Math.round(widthMm * PXMM), H = Math.round(heightMm * PXMM);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<LabelElementKey>("name");

  const i: LabelItem = sample ?? ({
    id: 0, item_code: "ABC123", barcode: "ABC123", name: "ตัวอย่างสินค้า",
    grid_row: "A", grid_col: 1, pick_freq: null, unit: "ชิ้น",
    cost: 100, sale: 150, storage_location: "ชั้น A"
  } as LabelItem);
  const code = labelCodeOf(i) || "ABC123";
  const cost = costLine(i) ?? "ราคาทุน ฿100/ชิ้น";
  const sale = saleLine(i) ?? "ราคาขาย ฿150/ชิ้น";
  const bin = binOf(i) || "ชั้น A";

  function startDrag(k: LabelElementKey, ev: ReactPointerEvent) {
    ev.preventDefault();
    setSel(k);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const startX = ev.clientX, startY = ev.clientY;
    const ox = draft[k].x, oy = draft[k].y;
    function move(e: PointerEvent) {
      const nx = ox + ((e.clientX - startX) / rect.width) * 100;
      const ny = oy + ((e.clientY - startY) / rect.height) * 100;
      setDraft((p) => ({ ...p, [k]: { ...p[k], x: Math.min(98, Math.max(0, nx)), y: Math.min(98, Math.max(0, ny)) } }));
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function patch(k: LabelElementKey, p: Partial<LabelElement>) {
    setDraft((prev) => ({ ...prev, [k]: { ...prev[k], ...p } }));
  }

  function content(k: LabelElementKey) {
    const el = draft[k];
    if (k === "qr") {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={qrSrc(code)} alt="" style={{ width: el.size * PXMM, height: el.size * PXMM, display: "block" }} />;
    }
    if (k === "barcode") {
      return <div style={{ width: "100%", height: el.size * PXMM }}><Barcode value={code} fill /></div>;
    }
    const map: Record<string, string> = { name: i.name, code, cost, sale, bin };
    return (
      <div style={{
        fontSize: el.size * PXMM, lineHeight: 1.1, textAlign: el.align ?? "left",
        fontWeight: k === "name" || k === "code" || k === "sale" ? 700 : 400,
        whiteSpace: "nowrap", overflow: "hidden"
      }}>{map[k]}</div>
    );
  }

  const e = draft[sel];
  return (
    <div className="mt-3 space-y-3">
      <p className="text-[11px] text-slate-500">
        ลากองค์ประกอบบนป้ายเพื่อจัดตำแหน่ง · แตะเลือกองค์ประกอบแล้วปรับขนาด/ความกว้าง/การจัดวางด้านขวา
      </p>
      <div className="flex flex-wrap gap-4">
        <div
          ref={canvasRef}
          style={{
            width: W, height: H, position: "relative", background: "#fff",
            border: "1px dashed #94a3b8", borderRadius: 4, flex: "none", touchAction: "none"
          }}
        >
          {LABEL_ELEMENT_KEYS.filter((k) => draft[k].show).map((k) => {
            const el = draft[k];
            return (
              <div key={k} onPointerDown={(ev) => startDrag(k, ev)}
                style={{
                  position: "absolute", left: `${el.x}%`, top: `${el.y}%`,
                  width: k === "qr" ? el.size * PXMM : `${el.w}%`,
                  cursor: "move",
                  outline: sel === k ? "2px solid #a06820" : "1px dotted #cbd5e1",
                  background: sel === k ? "rgba(160,104,32,0.08)" : "transparent"
                }}
              >
                {content(k)}
              </div>
            );
          })}
        </div>

        <div className="flex-1 min-w-[210px] space-y-2">
          <div className="flex flex-wrap gap-1">
            {LABEL_ELEMENT_KEYS.map((k) => (
              <button key={k} type="button" onClick={() => setSel(k)}
                className={`text-[11px] px-2 py-1 rounded border ${
                  sel === k ? "bg-brand text-white border-brand"
                    : draft[k].show ? "border-slate-300 text-slate-700" : "border-slate-200 text-slate-300"
                }`}>
                {LABEL_ELEMENT_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="border border-slate-200 rounded-lg p-2.5 space-y-2 text-xs">
            <div className="font-bold text-slate-700">{LABEL_ELEMENT_LABEL[sel]}</div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={e.show} onChange={(ev) => patch(sel, { show: ev.target.checked })} />
              แสดงบนฉลาก
            </label>
            <Stepper
              label={sel === "qr" || sel === "barcode" ? "ขนาด (มม.)" : "ขนาดตัวอักษร (มม.)"}
              value={e.size} step={sel === "qr" || sel === "barcode" ? 1 : 0.2} min={0.5} max={60}
              onChange={(v) => patch(sel, { size: Math.round(v * 10) / 10 })}
            />
            {sel !== "qr" && (
              <Stepper label="ความกว้าง (%)" value={e.w} step={2} min={5} max={100}
                onChange={(v) => patch(sel, { w: Math.round(v) })} />
            )}
            {sel !== "qr" && sel !== "barcode" && (
              <div className="flex items-center gap-2">
                <span className="text-slate-500">จัดวาง</span>
                {(["left", "center", "right"] as const).map((a) => (
                  <button key={a} type="button" onClick={() => patch(sel, { align: a })}
                    className={`px-2 py-0.5 rounded border ${
                      e.align === a ? "bg-slate-800 text-white border-slate-800" : "border-slate-300 text-slate-600"
                    }`}>
                    {a === "left" ? "ซ้าย" : a === "center" ? "กลาง" : "ขวา"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onSave} disabled={saving}
              className="flex-1 py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
              {saving ? "กำลังบันทึก…" : "บันทึกเลย์เอาต์"}
            </button>
            {hasSaved && (
              <button type="button" onClick={onReset} disabled={saving}
                className="py-2 px-3 rounded-lg border border-slate-300 text-slate-600 text-sm disabled:opacity-50">
                คืนค่ามาตรฐาน
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
