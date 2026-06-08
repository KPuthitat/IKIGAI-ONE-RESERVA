"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import {
  PICK_FREQ_META, isLowStock, expiryBucket,
  type PickFreq, type ItemType, type InventaSupplier, type InventaLookup,
  type InventaItemLot, type ExpiryBucket
} from "@/lib/inventa";

// Deterministic colour per category code/name so categories read as
// distinct chips (e.g. ATB vs ARI). No colour column on lookups — we
// hash the label into a fixed Tailwind palette (stable across renders).
const CAT_COLORS = [
  "bg-sky-100 text-sky-800",
  "bg-emerald-100 text-emerald-800",
  "bg-amber-100 text-amber-800",
  "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800",
  "bg-teal-100 text-teal-800",
  "bg-indigo-100 text-indigo-800",
  "bg-orange-100 text-orange-800",
  "bg-pink-100 text-pink-800",
  "bg-cyan-100 text-cyan-800"
];
function catColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return CAT_COLORS[h % CAT_COLORS.length];
}

type Item = {
  id: number;
  item_code: string | null;
  barcode: string | null;
  name: string;
  generic_name: string | null;
  cgd_code: string | null;
  category: string | null;
  storage_location: string | null;
  item_type: ItemType;
  item_type_label: string | null;
  unit: string | null;
  unit_cost: number;
  cost_price: number | null;
  last_purchase_price: number | null;
  last_purchase_units: number | null;
  price_opd: number | null;
  price_ipd: number | null;
  price_uc: number | null;
  supplier_id: number | null;
  supplier_name: string | null;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  safety_stock: number;
  current_qty: number;
  /** Soonest lot expiry across this item's still-positive-qty lots,
   *  or null when no lots are tracked or none are dated. Drives the
   *  row tinting (#93) so expired/critical items are obvious in the
   *  catalogue without opening the modal. */
  earliest_expiry: string | null;
};

export default function InventaClient({
  items, suppliers, lookups, isSuperAdmin
}: {
  items: Item[];
  suppliers: InventaSupplier[];
  lookups: InventaLookup[];
  isSuperAdmin: boolean;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [freqFilter, setFreqFilter] = useState<PickFreq | "">("");
  // 2026-05-31 (#89): catalogue gains filter-by-category +
  // filter-by-supplier dropdowns and a sort menu. State stays
  // local — small enough volume (≤500 items per branch) that
  // sort+filter happens in memo, no URL sync needed.
  const [catFilter, setCatFilter] = useState<string>("");
  const [supFilter, setSupFilter] = useState<string>("");
  const [locFilter, setLocFilter] = useState<string>("");
  // "ยังไม่ตั้งราคาทุน" — items with no usable cost (owner-pinned cost_price
  // nor a derived unit_cost), so the owner can find + price them (owner F5).
  const [noCostOnly, setNoCostOnly] = useState(false);
  const [sortBy, setSortBy] = useState<
    "name" | "code" | "qty_asc" | "qty_desc" | "cost_desc" | "low_first"
  >("name");
  const [edit, setEdit] = useState<Item | null>(null);
  const [adding, setAdding] = useState<Partial<Item> | null>(null);
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanCam, setScanCam] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const refresh = () => startTransition(() => router.refresh());

  // Categories ↔ codes lookup so the catalogue can render the
  // category abbrev (e.g. "PAIN") instead of the full Thai name
  // when one is set. Falls back to the long form when null.
  const categoryCodeByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lookups) {
      if (l.kind === "category" && l.code) m.set(l.value, l.code);
    }
    return m;
  }, [lookups]);
  // Same for storage: show the short code (e.g. "D4") instead of the
  // full shelf name ("ชั้นวางยา D4") when a code is set.
  const storageCodeByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lookups) {
      if (l.kind === "storage" && l.code) m.set(l.value, l.code);
    }
    return m;
  }, [lookups]);
  const categoryList = useMemo(
    () => lookups.filter((l) => l.kind === "category"),
    [lookups]
  );
  const storageList = useMemo(
    () => lookups.filter((l) => l.kind === "storage"),
    [lookups]
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = items.filter((i) => {
      if (freqFilter && i.pick_freq !== freqFilter) return false;
      if (catFilter && (i.category ?? "") !== catFilter) return false;
      if (supFilter && String(i.supplier_id ?? "") !== supFilter) return false;
      if (locFilter && (i.storage_location ?? "") !== locFilter) return false;
      if (noCostOnly && (i.cost_price ?? i.unit_cost ?? 0) > 0) return false;
      if (!term) return true;
      return [
        i.name, i.generic_name, i.item_code, i.barcode,
        i.category, i.storage_location
      ].some((v) => (v ?? "").toLowerCase().includes(term));
    });
    // Sort. low_first lifts at-or-below safety_stock items to the
    // top — the most common "what should I deal with now" view.
    const cmp = {
      name: (a: Item, b: Item) => a.name.localeCompare(b.name, "th"),
      code: (a: Item, b: Item) =>
        (a.item_code ?? "").localeCompare(b.item_code ?? "", "th"),
      qty_asc: (a: Item, b: Item) => a.current_qty - b.current_qty,
      qty_desc: (a: Item, b: Item) => b.current_qty - a.current_qty,
      cost_desc: (a: Item, b: Item) =>
        (b.cost_price ?? b.unit_cost ?? 0) - (a.cost_price ?? a.unit_cost ?? 0),
      low_first: (a: Item, b: Item) => {
        const la = isLowStock(a.current_qty, a.safety_stock) ? 0 : 1;
        const lb = isLowStock(b.current_qty, b.safety_stock) ? 0 : 1;
        if (la !== lb) return la - lb;
        return a.name.localeCompare(b.name, "th");
      }
    }[sortBy];
    return [...out].sort(cmp);
  }, [items, q, freqFilter, catFilter, supFilter, locFilter, noCostOnly, sortBy]);

  const activeFilterCount =
    (catFilter ? 1 : 0) + (supFilter ? 1 : 0) + (locFilter ? 1 : 0) + (freqFilter ? 1 : 0) + (noCostOnly ? 1 : 0);
  function clearFilters() {
    setCatFilter(""); setSupFilter(""); setLocFilter(""); setFreqFilter(""); setNoCostOnly(false);
  }

  // Scan: USB scanners type the code then send Enter. Look it up — a
  // hit opens the edit modal (adjust qty/details); a miss opens the
  // add modal pre-filled with the scanned barcode.
  async function onScan(raw: string) {
    const code = raw.trim();
    if (!code) return;
    setScanBusy(true);
    try {
      const res = await fetch(
        apiUrl(`/api/inventa/items?code=${encodeURIComponent(code)}`)
      );
      const j = await res.json().catch(() => ({}));
      if (j?.item) setEdit(j.item as Item);
      else setAdding({ barcode: code });
    } finally {
      setScanBusy(false);
      if (scanRef.current) scanRef.current.value = "";
    }
  }

  return (
    <>
      <div className="card space-y-3">
        {/* Scan box — full width, the primary daily entry point. */}
        <input
          ref={scanRef}
          className="input w-full"
          placeholder={t("inv.scan.ph")}
          disabled={scanBusy}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onScan((e.target as HTMLInputElement).value);
            }
          }}
        />

        {/* Scan QR — full-width primary action (same treatment as the
            RESERVA scanner button on mobile). */}
        <button type="button"
          onClick={() => setScanCam(true)}
          className="w-full text-sm px-4 py-2.5 rounded-lg border border-brand text-brand font-bold hover:bg-rose-50">
          {t("inv.btn.scanQr")}
        </button>

        {/* Primary actions — 2-up grid on mobile, inline from sm up.
            Import stays visible here (it's step 1 of the workflow). */}
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
          <button type="button"
            onClick={() => setAdding({})}
            className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90">
            {t("inv.btn.addItem")}
          </button>
          <Link href="/staff/inventa/count"
            className="text-sm px-4 py-2 rounded-lg border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 font-bold text-center">
            {t("inv.nav.count")}
          </Link>
          <Link href="/staff/inventa/orders"
            className="text-sm px-4 py-2 rounded-lg border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 font-bold text-center">
            {t("inv.nav.orders")}
          </Link>
          <button type="button"
            onClick={() => setShowImport(true)}
            className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            {t("inv.btn.importCsv")}
          </button>
          <button type="button"
            onClick={() => setShowSuppliers(true)}
            className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            {t("inv.btn.suppliers")} ({suppliers.length})
          </button>
        </div>

        {/* Secondary tools — collapsed by default so the bar stays
            clean on a phone. Native <details> = no extra state. */}
        <details className="group">
          <summary className="cursor-pointer list-none text-xs font-medium text-slate-500 hover:text-slate-700 select-none flex items-center gap-1">
            <span className="transition-transform group-open:rotate-90">›</span>
            {t("inv.tools.more")}
          </summary>
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 mt-2">
            <Link href="/staff/inventa/labels"
              className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-center">
              {t("inv.nav.qr")}
            </Link>
            {isSuperAdmin && (
              <Link href="/staff/inventa/settings"
                className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-center">
                {t("inv.nav.settings")}
              </Link>
            )}
          </div>
        </details>

        {/* Search + colour-band filter */}
        <div className="flex flex-wrap gap-2 items-center">
          <input className="input flex-1 min-w-[160px]" value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("inv.search.ph")} />
          <div className="flex gap-1.5 items-center">
            <button type="button" onClick={() => setFreqFilter("")}
              className={`text-xs px-3 py-1.5 rounded-md border ${
                freqFilter === ""
                  ? "bg-brand text-white border-brand font-bold"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
              {t("inv.filter.all")}
            </button>
            {(["R", "Y", "G"] as const).map((f) => {
              const fm = PICK_FREQ_META[f];
              const active = freqFilter === f;
              return (
                <button key={f} type="button"
                  title={fm.label}
                  onClick={() => setFreqFilter(active ? "" : f)}
                  className={`w-6 h-6 rounded-full ${fm.dot} transition ${
                    active
                      ? "ring-2 ring-offset-1 ring-slate-500"
                      : "opacity-50 hover:opacity-100"}`} />
              );
            })}
          </div>
        </div>

        {/* Filter + sort menu (#89). Native selects so the touch
            target stays accessible on mobile without pulling in a
            popover lib. The clear-all chip only appears when there's
            something to clear so the bar stays calm by default. */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1 w-full sm:w-auto">
            <span className="text-slate-500 w-20 shrink-0 sm:w-auto">{t("inv.flt.cat")}</span>
            <select className="input !py-1 !px-2 flex-1 min-w-0 sm:flex-none sm:!w-auto sm:max-w-[220px] text-xs"
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">{t("inv.filter.all")}</option>
              {categoryList.map((c) => (
                <option key={c.id} value={c.value}>
                  {c.code ? `${c.code} · ${c.value}` : c.value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 w-full sm:w-auto">
            <span className="text-slate-500 w-20 shrink-0 sm:w-auto">{t("inv.flt.sup")}</span>
            <select className="input !py-1 !px-2 flex-1 min-w-0 sm:flex-none sm:!w-auto sm:max-w-[220px] text-xs"
              value={supFilter}
              onChange={(e) => setSupFilter(e.target.value)}>
              <option value="">{t("inv.filter.all")}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.code ? `${s.code} · ${s.name}` : s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 w-full sm:w-auto">
            <span className="text-slate-500 w-20 shrink-0 sm:w-auto">{t("inv.flt.loc")}</span>
            <select className="input !py-1 !px-2 flex-1 min-w-0 sm:flex-none sm:!w-auto sm:max-w-[220px] text-xs"
              value={locFilter}
              onChange={(e) => setLocFilter(e.target.value)}>
              <option value="">{t("inv.filter.all")}</option>
              {storageList.map((s) => (
                <option key={s.id} value={s.value}>
                  {s.code ? `${s.code} · ${s.value}` : s.value}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setNoCostOnly((v) => !v)}
            className={`px-2.5 py-1 rounded-full border ${
              noCostOnly ? "bg-rose-600 text-white border-rose-600" : "border-slate-300 text-slate-600"}`}>
            ยังไม่ตั้งราคาทุน
          </button>
          <label className="flex items-center gap-1 w-full sm:w-auto sm:ml-auto">
            <span className="text-slate-500 w-20 shrink-0 sm:w-auto">{t("inv.sort.label")}</span>
            <select className="input !py-1 !px-2 flex-1 min-w-0 sm:flex-none sm:!w-auto sm:max-w-[220px] text-xs"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
              <option value="name">{t("inv.sort.name")}</option>
              <option value="code">{t("inv.sort.code")}</option>
              <option value="low_first">{t("inv.sort.lowFirst")}</option>
              <option value="qty_asc">{t("inv.sort.qtyAsc")}</option>
              <option value="qty_desc">{t("inv.sort.qtyDesc")}</option>
              <option value="cost_desc">{t("inv.sort.costDesc")}</option>
            </select>
          </label>
          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilters}
              className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
              {t("inv.flt.clear", { n: activeFilterCount })}
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              {/* Colour band — dot only, header label omitted (self-evident). */}
              <th className="py-2 pr-2 w-6"></th>
              <th className="py-2 pr-2 w-12">{t("inv.col.location")}</th>
              <th className="py-2 pr-3 w-2/5">{t("inv.col.name")}</th>
              <th className="py-2 pr-2">{t("inv.col.category")}</th>
              <th className="py-2 pr-2">{t("inv.col.supplier")}</th>
              <th className="py-2 pr-2">{t("inv.col.unit")}</th>
              <th className="py-2 pr-2 text-right">{t("inv.col.cost")}</th>
              <th className="py-2 pr-2 text-right">{t("inv.col.qty")}</th>
              <th className="py-2 pr-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((i) => {
              const low = isLowStock(i.current_qty, i.safety_stock);
              const fm = i.pick_freq ? PICK_FREQ_META[i.pick_freq] : null;
              // Row tone (#93). Expired wins — it's the most urgent
              // and the darkest tone signals "do not dispense".
              // Critical (≤30d) is a soft amber tint. Low-stock
              // keeps the existing rose tint. Otherwise hover-only.
              const bucket = expiryBucket(i.earliest_expiry);
              const rowTone =
                bucket === "expired"
                  ? "bg-red-100/80 ring-1 ring-red-300"
                  : bucket === "critical"
                  ? "bg-amber-50"
                  : low
                  ? "bg-rose-50/50"
                  : "hover:bg-slate-50";
              const textTone = bucket === "expired" ? "text-red-900" : "";
              return (
                <tr key={i.id}
                  className={`border-b last:border-0 ${rowTone} ${textTone}`}>
                  <td className="py-2 pr-2 whitespace-nowrap">
                    {fm ? (
                      <span title={fm.label}
                        className={`inline-block w-3.5 h-3.5 rounded-full align-middle ${fm.dot}`} />
                    ) : (
                      <span className="text-slate-300">{t("inv.dash")}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-[11px] text-slate-500">
                    {i.storage_location
                      ? (storageCodeByName.get(i.storage_location) ?? i.storage_location)
                      : t("inv.dash")}
                  </td>
                  {/* Two-line cell (#89): item_code is the primary
                      anchor (bold uppercase, larger), the name reads
                      as a secondary descriptor below it. When no
                      item_code is set, the name promotes up so the
                      cell never goes blank. Generic name is kept as
                      a third subtle line for drug lookups. */}
                  <td className="py-2 pr-3">
                    <div className="break-words">
                    {i.item_code ? (
                      <>
                        <div className="font-bold uppercase tracking-wide text-slate-900 text-sm leading-tight">
                          {i.item_code}
                        </div>
                        <div className="text-xs text-slate-600 leading-tight">{i.name}</div>
                        {i.generic_name && (
                          <div className="text-[10px] text-slate-400 leading-tight">{i.generic_name}</div>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="font-bold text-slate-800 text-sm leading-tight">{i.name}</div>
                        {i.generic_name && (
                          <div className="text-[10px] text-slate-400 leading-tight">{i.generic_name}</div>
                        )}
                      </>
                    )}
                    </div>
                  </td>
                  <td className="py-2 pr-2 text-xs whitespace-nowrap">
                    {/* Category as a colour chip — uses the abbrev code
                        when set (e.g. ATB / ARI), colour hashed from the
                        label so each category is visually distinct. */}
                    {i.category ? (
                      <span className={`inline-block font-bold px-1.5 py-0.5 rounded ${catColor(categoryCodeByName.get(i.category) ?? i.category)}`}>
                        {categoryCodeByName.get(i.category) ?? i.category}
                      </span>
                    ) : (
                      <span className="text-slate-400">{t("inv.dash")}</span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-slate-600 text-xs">
                    <div className="max-w-[130px] truncate" title={i.supplier_name ?? ""}>
                      {i.supplier_name ?? t("inv.dash")}
                    </div>
                  </td>
                  <td className="py-2 pr-2 text-slate-600 text-xs whitespace-nowrap">{i.unit ?? t("inv.dash")}</td>
                  <td className="py-2 pr-3 text-right text-slate-700">
                    {/* Show the EFFECTIVE cost (owner-pinned ราคาทุน wins,
                        else derived unit_cost) so an edit to ราคาทุน
                        reflects here — previously this showed only
                        unit_cost, making cost edits look like they didn't
                        save (owner 2026-06-08, item 4). */}
                    {(() => {
                      const c = i.cost_price ?? i.unit_cost;
                      return c ? c.toLocaleString(undefined, { maximumFractionDigits: 4 }) : t("inv.dash");
                    })()}
                  </td>
                  <td className={`py-2 pr-3 text-right font-bold ${
                    bucket === "expired" ? "text-red-900"
                    : low ? "text-rose-600"
                    : "text-slate-800"
                  }`}>
                    {i.current_qty}
                    {low && <span className="ml-1 text-[10px] font-normal">{t("inv.low")}</span>}
                    {bucket === "expired" && (
                      <span className="ml-1 inline-block text-[9px] font-bold uppercase tracking-wide bg-red-900 text-red-50 px-1.5 py-0.5 rounded">
                        {t("inv.expired")}
                      </span>
                    )}
                    {bucket === "critical" && (
                      <span className="ml-1 inline-block text-[9px] font-bold uppercase tracking-wide bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded">
                        {t("inv.expiringSoon")}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button type="button" onClick={() => setEdit(i)}
                      className="text-xs text-brand hover:underline">{t("inv.btn.edit")}</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="py-6 text-center text-slate-400 text-sm">
                {t("inv.empty")}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {scanCam && (
        <BarcodeScanner
          title={t("inv.scan.findTitle")}
          onResult={(code) => onScan(code)}
          onClose={() => setScanCam(false)}
        />
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); refresh(); }}
        />
      )}

      {(edit || adding) && (
        <ItemModal
          item={edit}
          seed={adding ?? undefined}
          suppliers={suppliers}
          lookups={lookups}
          isSuperAdmin={isSuperAdmin}
          onClose={() => { setEdit(null); setAdding(null); }}
          onSaved={() => { setEdit(null); setAdding(null); refresh(); }}
        />
      )}

      {showSuppliers && (
        <SuppliersModal
          suppliers={suppliers}
          onClose={() => setShowSuppliers(false)}
          onChanged={refresh}
        />
      )}
    </>
  );
}

// ── Item add/edit modal ────────────────────────────────────────────
function ItemModal({
  item, seed, suppliers, lookups, isSuperAdmin, onClose, onSaved
}: {
  item: Item | null;
  seed?: Partial<Item>;
  suppliers: InventaSupplier[];
  lookups: InventaLookup[];
  isSuperAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();
  const opts = (kind: string) =>
    lookups.filter((l) => l.kind === kind).map((l) => l.value);
  const storageOpts = opts("storage");
  const unitOpts = opts("unit");
  const itemTypeOpts = opts("item_type");
  // Category list is local state so an inline "+ เพิ่มหมวดหมู่" shows
  // up immediately without closing the modal (owner 2026-06-03).
  const [categoryOpts, setCategoryOpts] = useState<string[]>(opts("category"));
  const [addingCat, setAddingCat] = useState(false);

  // Add a new category lookup inline (super_admin only — matches the
  // /api/inventa/lookups POST guard). Then select it.
  async function addCategoryInline() {
    const value = window.prompt("ชื่อหมวดหมู่ใหม่");
    if (!value || !value.trim()) return;
    setAddingCat(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/lookups"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "category", value: value.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        const v = value.trim();
        setCategoryOpts((p) => (p.includes(v) ? p : [...p, v]));
        up("category", v);
      } else {
        window.alert(j?.error === "super_admin_only"
          ? "เพิ่มหมวดหมู่ได้เฉพาะผู้ดูแลระบบสูงสุด"
          : "เพิ่มหมวดหมู่ไม่สำเร็จ");
      }
    } finally { setAddingCat(false); }
  }

  const base: Partial<Item> = item ?? seed ?? {};
  const [f, setF] = useState({
    item_code: base.item_code ?? "",
    barcode: base.barcode ?? "",
    name: base.name ?? "",
    generic_name: base.generic_name ?? "",
    category: base.category ?? "",
    item_type: (base.item_type ?? "drug") as ItemType,
    item_type_label: base.item_type_label ?? "",
    unit: base.unit ?? "",
    unit_cost: base.unit_cost != null ? String(base.unit_cost) : "",
    cost_price: base.cost_price != null ? String(base.cost_price) : "",
    storage_location: base.storage_location ?? "",
    supplier_id: base.supplier_id != null ? String(base.supplier_id) : "",
    grid_row: base.grid_row ?? "",
    grid_col: base.grid_col != null ? String(base.grid_col) : "",
    pick_freq: (base.pick_freq ?? "") as PickFreq | "",
    safety_stock: base.safety_stock != null ? String(base.safety_stock) : "50",
    current_qty: base.current_qty != null ? String(base.current_qty) : "0"
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cast the spread result back to the state shape — a computed-key
  // assignment of a string into the union-typed (ItemType / PickFreq)
  // slots would otherwise widen and fail the build.
  const up = (k: keyof typeof f, v: string) =>
    setF((p) => ({ ...p, [k]: v }) as typeof p);

  // Camera scan → fills the barcode field (add/edit item).
  const [scanField, setScanField] = useState(false);

  async function save() {
    setErr(null);
    if (!f.name.trim()) { setErr(t("inv.err.name")); return; }
    setBusy(true);
    try {
      const body = {
        item_code: f.item_code.trim() || null,
        barcode: f.barcode.trim() || null,
        name: f.name.trim(),
        generic_name: f.generic_name.trim() || null,
        category: f.category.trim() || null,
        item_type: f.item_type,
        item_type_label: f.item_type_label.trim() || null,
        unit: f.unit.trim() || null,
        // Use !== "" (not truthy) so a typed 0 is preserved instead of
        // being silently dropped to null/default (owner 2026-06-08, item 4).
        unit_cost: f.unit_cost !== "" ? Number(f.unit_cost) : 0,
        cost_price: f.cost_price !== "" ? Number(f.cost_price) : null,
        storage_location: f.storage_location.trim() || null,
        supplier_id: f.supplier_id ? Number(f.supplier_id) : null,
        grid_row: f.grid_row || null,
        grid_col: f.grid_col ? Number(f.grid_col) : null,
        pick_freq: f.pick_freq || null,
        safety_stock: Number(f.safety_stock) || 0,
        current_qty: Number(f.current_qty) || 0
      };
      const res = item
        ? await fetch(apiUrl(`/api/inventa/items/${item.id}`), {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body) })
        : await fetch(apiUrl("/api/inventa/items"), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setErr(j?.error ?? t("inv.err.generic")); return; }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!item) return;
    if (!confirm(t("inv.confirm.del", { name: item.name }))) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/items/${item.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setErr(j?.error ?? t("inv.err.del")); return; }
      onSaved();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">
          {item ? t("inv.item.edit") : t("inv.item.add")}
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t("inv.f.itemType")}</label>
            <select className="input" value={f.item_type_label}
              onChange={(e) => up("item_type_label", e.target.value)}>
              <option value="">{t("inv.dash")}</option>
              {itemTypeOpts.map((it) => <option key={it} value={it}>{it}</option>)}
            </select>
            <p className="text-[10px] text-slate-400 mt-1">
              เพิ่ม/แก้ประเภทได้ที่หน้า &quot;ตั้งค่า&quot;
            </p>
          </div>
          <div>
            <label className="label">{t("inv.f.barcode")}</label>
            <div className="flex gap-2">
              <input className="input flex-1" value={f.barcode}
                onChange={(e) => up("barcode", e.target.value)}
                placeholder={t("inv.f.barcodePh")} />
              <button type="button" onClick={() => setScanField(true)}
                className="px-3 rounded-lg border border-brand text-brand text-sm font-bold hover:bg-rose-50 whitespace-nowrap">
                {t("inv.btn.scan")}
              </button>
            </div>
          </div>
          <div className="col-span-2">
            <label className="label">{t("inv.f.name")} *</label>
            <input className="input" value={f.name}
              onChange={(e) => up("name", e.target.value)} />
          </div>
          <div>
            <label className="label">{t("inv.f.altName")}</label>
            <input className="input" value={f.generic_name}
              onChange={(e) => up("generic_name", e.target.value)} />
          </div>
          <div>
            <label className="label">{t("inv.f.code")}</label>
            <input className="input" value={f.item_code}
              onChange={(e) => up("item_code", e.target.value)}
              placeholder={t("inv.f.codePh")} />
          </div>
          <div className="col-span-2">
            <label className="label">{t("inv.f.category")}</label>
            <div className="flex gap-2">
              <select className="input flex-1" value={f.category}
                onChange={(e) => up("category", e.target.value)}>
                <option value="">{t("inv.cat.choose")}</option>
                {categoryOpts.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {isSuperAdmin && (
                <button type="button" onClick={addCategoryInline} disabled={addingCat}
                  className="px-3 rounded-lg border border-brand text-brand text-sm font-bold hover:bg-rose-50 whitespace-nowrap disabled:opacity-50">
                  + เพิ่ม
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Storage location + colour band */}
        <div className="border-t border-slate-200 pt-3">
          <div className="text-xs font-bold text-slate-700 mb-2">
            {t("inv.sec.locBand")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("inv.f.location")}</label>
              <select className="input" value={f.storage_location}
                onChange={(e) => up("storage_location", e.target.value)}>
                <option value="">{t("inv.dash")}</option>
                {storageOpts.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t("inv.f.band")}</label>
              <div className="flex items-center gap-2 h-[42px]">
                <button type="button" onClick={() => up("pick_freq", "")}
                  title={t("inv.band.none")}
                  className={`w-7 h-7 rounded-full border border-slate-300 text-slate-400 text-sm flex items-center justify-center ${
                    f.pick_freq === "" ? "ring-2 ring-offset-1 ring-slate-500" : "opacity-60 hover:opacity-100"}`}>
                  ✕
                </button>
                {(["R", "Y", "G"] as const).map((c) => {
                  const fm = PICK_FREQ_META[c];
                  const active = f.pick_freq === c;
                  return (
                    <button key={c} type="button"
                      title={fm.label}
                      onClick={() => up("pick_freq", c)}
                      className={`w-7 h-7 rounded-full ${fm.dot} transition ${
                        active
                          ? "ring-2 ring-offset-1 ring-slate-500"
                          : "opacity-50 hover:opacity-100"}`} />
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Unit + cost (per smallest unit, entered directly) */}
        <div className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-3">
          <div>
            <label className="label">{t("inv.f.unit")}</label>
            <select className="input" value={f.unit}
              onChange={(e) => up("unit", e.target.value)}>
              <option value="">{t("inv.dash")}</option>
              {unitOpts.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          {/* ราคาทุน — the headline cost the owner wants to control.
              Highlighted with an emerald left border + ฿ prefix so it
              reads as "the money figure to watch", visually distinct
              from the auto-derived unit_cost row below. PO totals
              estimate from this first; unit_cost is the fallback. */}
          <div>
            <label className="label flex items-center gap-1">
              <span className="text-emerald-700">฿</span>
              {t("inv.f.costPrice")}
            </label>
            <input className="input border-l-4 border-l-emerald-500 font-semibold"
              type="number" min="0" step="0.01"
              value={f.cost_price}
              onChange={(e) => up("cost_price", e.target.value)}
              placeholder={t("inv.f.costPricePh")} />
            <p className="text-[10px] text-slate-400 mt-1">
              {t("inv.f.costPriceHint")}
            </p>
          </div>
          <div className="col-span-2">
            <label className="label">{t("inv.f.cost")}</label>
            <input className="input" type="number" min="0" step="0.0001"
              value={f.unit_cost}
              onChange={(e) => up("unit_cost", e.target.value)}
              placeholder={t("inv.f.costPh")} />
            <p className="text-[10px] text-slate-400 mt-1">
              {t("inv.f.costHint")}
            </p>
          </div>
          <div>
            <label className="label">{t("inv.f.onhand")}</label>
            {item ? (
              // Editing an existing item → qty is read-only here; the
              // real adjustment path is a stock-count round (owner
              // 2026-06-03). Avoids accidental edits from the catalogue.
              <>
                <div className="input bg-slate-50 text-slate-700 flex items-center">
                  {f.current_qty || "0"}
                </div>
                <p className="text-[10px] text-slate-400 mt-1">
                  ปรับจำนวนที่ &quot;รอบเช็คสต๊อค&quot;
                </p>
              </>
            ) : (
              <input className="input" type="number" min="0" value={f.current_qty}
                onChange={(e) => up("current_qty", e.target.value)} />
            )}
          </div>
          <div>
            <label className="label">{t("inv.f.safety")}</label>
            <input className="input" type="number" min="0" value={f.safety_stock}
              onChange={(e) => up("safety_stock", e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">{t("inv.f.safetyHint")}</p>
          </div>
          <div className="col-span-2">
            <label className="label">{t("inv.f.supplier")}</label>
            <select className="input" value={f.supplier_id}
              onChange={(e) => up("supplier_id", e.target.value)}>
              <option value="">{t("inv.dash")}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Lots & expiry — only available once the item exists
            (adding lots before creating the item has nothing to
            link against). Collapsible so it stays out of the way
            during quick edits. */}
        {item && (
          <div className="border-t border-slate-200 pt-3">
            <LotsSection itemId={item.id} unitLabel={item.unit ?? ""} currentCost={item.cost_price ?? null} />
          </div>
        )}

        {err && <div className="text-rose-600 text-sm">✗ {err}</div>}

        <div className="flex gap-2 pt-1">
          {item && (
            <button type="button" onClick={del} disabled={busy}
              className="px-4 py-2.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-sm">
              {t("inv.btn.delete")}
            </button>
          )}
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
            {t("inv.btn.cancel")}
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
            {busy ? t("inv.btn.saving") : t("inv.btn.save")}
          </button>
        </div>
      </div>

      {scanField && (
        <BarcodeScanner
          title={t("inv.scan.title2")}
          onResult={(code) => up("barcode", code)}
          onClose={() => setScanField(false)}
        />
      )}
    </div>
  );
}

// ── Suppliers manager ──────────────────────────────────────────────
function SuppliersModal({
  suppliers, onClose, onChanged
}: {
  suppliers: InventaSupplier[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [cycle, setCycle] = useState("");
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/suppliers"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          order_cycle: cycle.trim() || null,
          lead_time: lead.trim() || null
        })
      });
      if (res.ok) {
        setName(""); setCycle(""); setLead("");
        onChanged();
      }
    } finally { setBusy(false); }
  }

  async function del(id: number, nm: string) {
    if (!confirm(t("inv.sup.delConfirm", { name: nm }))) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/suppliers/${id}`), { method: "DELETE" });
      if (res.ok) onChanged();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">{t("inv.sup.title")}</h3>
        <p className="text-xs text-slate-500">
          {t("inv.sup.help")}
        </p>

        <div className="space-y-2 border border-slate-200 rounded-lg p-3">
          <input className="input" value={name} placeholder={t("inv.sup.namePh")}
            onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input className="input text-sm" value={cycle}
              placeholder={t("inv.sup.cyclePh")}
              onChange={(e) => setCycle(e.target.value)} />
            <input className="input text-sm" value={lead}
              placeholder={t("inv.sup.leadPh")}
              onChange={(e) => setLead(e.target.value)} />
          </div>
          <button type="button" onClick={add} disabled={busy || !name.trim()}
            className="w-full py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
            {t("inv.sup.add")}
          </button>
        </div>

        <div className="divide-y divide-slate-100">
          {suppliers.map((s) => (
            <div key={s.id} className="py-2 flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-slate-800 text-sm">{s.name}</div>
                <div className="text-xs text-slate-500">
                  {s.order_cycle ? `${t("inv.sup.order")}: ${s.order_cycle}` : ""}
                  {s.lead_time ? ` · ${t("inv.sup.deliver")}: ${s.lead_time}` : ""}
                </div>
              </div>
              <button type="button" onClick={() => del(s.id, s.name)}
                className="text-xs text-rose-600 hover:underline">{t("inv.btn.delete")}</button>
            </div>
          ))}
          {suppliers.length === 0 && (
            <div className="py-4 text-center text-slate-400 text-sm">{t("inv.sup.none")}</div>
          )}
        </div>

        <button type="button" onClick={onClose}
          className="w-full py-2.5 rounded-lg bg-slate-100 text-slate-700 text-sm font-medium">
          {t("inv.close")}
        </button>
      </div>
    </div>
  );
}

// ── CSV bulk import ────────────────────────────────────────────────
// Excel-compatible CSV (no npm dependency, deploy stays plain
// `npm run build`; handles Thai with a UTF-8 BOM). Thai header row
// maps 1:1 to system fields; the client parses, the server inserts
// row-by-row and reports skips.
const IMPORT_COLUMNS: Array<[string, string]> = [
  ["ชื่อสินค้า", "name"],
  ["ชื่อรอง", "generic_name"],
  ["รหัสสินค้า", "item_code"],
  ["บาร์โค้ด", "barcode"],
  ["หมวดหมู่", "category"],
  ["ประเภท", "item_type"],
  ["หน่วยเล็กสุด", "unit"],
  ["ราคาต่อหน่วย", "unit_cost"],
  ["ตำแหน่งจัดเก็บ", "storage_location"],
  ["แถบสี(R/Y/G)", "pick_freq"],
  ["จุดสั่งซื้อ", "safety_stock"],
  ["คงเหลือ", "current_qty"],
  ["ผู้จำหน่าย(บริษัท)", "supplier"]
];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((x) => x.trim() !== "")) rows.push(row);
  }
  return rows;
}

function ImportModal({
  onClose, onDone
}: { onClose: () => void; onDone: () => void }) {
  const { t } = useLang();
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; errors: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function downloadTemplate() {
    const header = IMPORT_COLUMNS.map(([h]) => h).join(",");
    const sample = [
      "ตัวอย่างสินค้า A", "", "A0001", "8850000000001",
      "หมวดทั่วไป", "สินค้า", "ชิ้น", "1.00", "ชั้นวางทั่วไป",
      "G", "100", "250", ""
    ].join(",");
    const blob = new Blob(["﻿" + header + "\n" + sample + "\n"], {
      type: "text/csv;charset=utf-8"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "inventa_template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    setErr(null); setResult(null);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const grid = parseCsv(String(reader.result ?? ""));
        if (grid.length < 2) { setErr(t("inv.imp.empty")); return; }
        const head = grid[0].map((h) => h.trim());
        const idx: Record<string, number> = {};
        IMPORT_COLUMNS.forEach(([label, key]) => {
          const at = head.indexOf(label);
          if (at >= 0) idx[key] = at;
        });
        if (idx.name === undefined) {
          setErr(t("inv.imp.noName"));
          return;
        }
        const out: Record<string, string>[] = [];
        for (let r = 1; r < grid.length; r++) {
          const o: Record<string, string> = {};
          for (const [, key] of IMPORT_COLUMNS) {
            if (idx[key] !== undefined) o[key] = (grid[r][idx[key]] ?? "").trim();
          }
          if (o.name) out.push(o);
        }
        setRows(out);
      } catch {
        setErr(t("inv.imp.readFail"));
      }
    };
    reader.readAsText(file, "utf-8");
  }

  async function doImport() {
    if (rows.length === 0) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/items/import"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setErr(j?.error ?? t("inv.imp.failGeneric")); return; }
      setResult({ created: j.created ?? 0, errors: j.errors ?? [] });
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">{t("inv.imp.title")}</h3>
        <p className="text-xs text-slate-500">{t("inv.imp.help")}</p>

        <button type="button" onClick={downloadTemplate}
          className="w-full py-2 rounded-lg border border-brand text-brand text-sm font-bold hover:bg-rose-50">
          {t("inv.imp.dl")}
        </button>

        <div>
          <input type="file" accept=".csv,text/csv" onChange={onFile}
            className="block w-full text-sm text-slate-600
              file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0
              file:bg-slate-100 file:text-slate-700 file:font-medium" />
          {fileName && (
            <p className="text-xs text-slate-500 mt-1">
              {fileName} — {t("inv.imp.preview", { n: rows.length })}
            </p>
          )}
        </div>

        {err && <div className="text-sm text-rose-600">✗ {err}</div>}

        {result && (
          <div className="text-sm bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-1">
            <div className="text-emerald-700 font-bold">
              {t("inv.imp.done", { n: result.created })}
            </div>
            {result.errors.length > 0 && (
              <div className="text-rose-600 text-xs">
                {t("inv.imp.errors", { n: result.errors.length })}:
                <ul className="list-disc pl-4 mt-1">
                  {result.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          {result ? (
            <button type="button" onClick={onDone}
              className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold">
              {t("inv.imp.finish")}
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={busy}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
                {t("inv.btn.cancel")}
              </button>
              <button type="button" onClick={doImport}
                disabled={busy || rows.length === 0}
                className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
                {busy ? t("inv.imp.importing") : t("inv.imp.doImport", { n: rows.length })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Lots & expiry section (#92) ────────────────────────────────────
// Per-item lot register. Lots track receipts + expiry; the item-
// level current_qty stays the source of truth for "how much do we
// have" (lots don't enforce sum). Each row carries an expiry bucket
// chip rendered with the same colour vocabulary as the catalogue
// row tint (#93) so staff who learn the meaning in one place
// recognise it in the other.

/** Tailwind classes for each expiry bucket. The "expired" tone is
 *  intentionally the darkest — that's the row the staff should
 *  pull off the shelf immediately. */
const EXPIRY_BUCKET_META: Record<ExpiryBucket, { chip: string; label: string; }> = {
  expired:    { chip: "bg-red-900 text-red-50 border border-red-950",         label: "หมดอายุแล้ว" },
  critical:   { chip: "bg-amber-200 text-amber-900 border border-amber-300",  label: "ภายใน 30 วัน" },
  warn:       { chip: "bg-yellow-100 text-yellow-800 border border-yellow-200", label: "ภายใน 90 วัน" },
  ok:         { chip: "bg-emerald-100 text-emerald-700 border border-emerald-200", label: "ปลอดภัย" },
  no_expiry:  { chip: "bg-slate-100 text-slate-500 border border-slate-200",  label: "ไม่มีวันหมดอายุ" }
};

function LotsSection({ itemId, unitLabel, currentCost }: {
  itemId: number; unitLabel: string; currentCost: number | null;
}) {
  const { t } = useLang();
  const [lots, setLots] = useState<InventaItemLot[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Add-lot row state. lot_number / expiry_date both optional —
  // sometimes the supplier doesn't print a lot code but the box
  // still has an expiry stamp, sometimes the opposite.
  const [lot, setLot] = useState("");
  const [exp, setExp] = useState("");
  const [qty, setQty] = useState("");
  // ราคาทุนรับเข้า/หน่วย — prefilled with the item's current cost (owner
  // F6). A different value re-prices the item on receipt; the new value
  // becomes the live cost so the next lot defaults to it.
  const [cost, setCost] = useState(currentCost != null ? String(currentCost) : "");
  const [costNote, setCostNote] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/items/${itemId}/lots`));
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setLots(j.lots ?? []);
    } finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!qty) return;
    setBusy(true); setCostNote(null);
    try {
      const unitCost = cost.trim() === "" ? null : Number(cost);
      const res = await fetch(apiUrl(`/api/inventa/items/${itemId}/lots`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lot_number: lot.trim() || null,
          expiry_date: exp || null,
          qty: Number(qty) || 0,
          unit_cost: unitCost
        })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        // Keep the entered cost (it's now the live cost) so the next lot
        // defaults to it; clear the batch-specific fields.
        setLot(""); setExp(""); setQty("");
        if (j.costChanged) setCostNote("ปรับราคาทุนของสินค้าตามราคารับเข้านี้แล้ว");
        await reload();
      }
    } finally { setBusy(false); }
  }
  async function del(lotId: number) {
    if (!confirm(t("inv.lot.delConfirm"))) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/items/${itemId}/lots/${lotId}`),
        { method: "DELETE" });
      if (res.ok) await reload();
    } finally { setBusy(false); }
  }

  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <details className="group">
      <summary className="cursor-pointer list-none select-none flex items-center justify-between">
        <span className="text-xs font-bold text-slate-700">
          {t("inv.lot.title")}
          <span className="ml-2 text-[10px] font-normal text-slate-400">
            ({lots.length})
          </span>
        </span>
        <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="mt-2 space-y-2">
        {/* Existing lots */}
        {loading && lots.length === 0 && (
          <div className="text-xs text-slate-400 text-center py-2">{t("inv.lot.loading")}</div>
        )}
        {!loading && lots.length === 0 && (
          <div className="text-xs text-slate-400 text-center py-2">{t("inv.lot.none")}</div>
        )}
        {lots.map((l) => {
          const bucket = expiryBucket(l.expiry_date, todayIso);
          const meta = EXPIRY_BUCKET_META[bucket];
          return (
            <div key={l.id}
              className={
                "flex items-center gap-2 rounded-lg border p-2 " +
                (bucket === "expired"
                  ? "bg-red-50 border-red-300"
                  : bucket === "critical"
                  ? "bg-amber-50 border-amber-200"
                  : "border-slate-200")
              }>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={"text-[10px] px-1.5 py-0.5 rounded-md font-bold " + meta.chip}>
                    {meta.label}
                  </span>
                  {l.expiry_date && (
                    <span className="text-xs text-slate-600 tabular-nums">
                      {l.expiry_date}
                    </span>
                  )}
                  <span className="text-xs text-slate-500">
                    × {l.qty}{unitLabel ? ` ${unitLabel}` : ""}
                  </span>
                  {l.unit_cost != null && (
                    <span className="text-[11px] text-slate-500">
                      @ ฿{l.unit_cost.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  )}
                </div>
                {l.lot_number && (
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    Lot: {l.lot_number}
                  </div>
                )}
              </div>
              <button type="button" disabled={busy}
                onClick={() => del(l.id)}
                className="text-[10px] text-rose-600 hover:underline">
                {t("inv.btn.delete")}
              </button>
            </div>
          );
        })}

        {/* Add-lot form */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 grid grid-cols-2 gap-2">
          <input className="input text-sm col-span-2" value={lot}
            placeholder={t("inv.lot.lotPh")}
            onChange={(e) => setLot(e.target.value)} />
          <input className="input text-sm" type="date" value={exp}
            onChange={(e) => setExp(e.target.value)} />
          <input className="input text-sm" type="number" min="0" value={qty}
            placeholder={t("inv.lot.qtyPh", { unit: unitLabel || t("inv.ord.unit") })}
            onChange={(e) => setQty(e.target.value)} />
          <div className="col-span-2">
            <label className="text-[11px] text-slate-500">ราคาทุนรับเข้า/หน่วย (บาท)</label>
            <input className="input text-sm mt-0.5" type="number" min="0" step="0.01" inputMode="decimal"
              value={cost} placeholder="เช่น 12.50"
              onChange={(e) => setCost(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-0.5">
              ค่าเริ่มต้นคือราคาทุนปัจจุบัน · หากกรอกต่างจากเดิม ระบบจะปรับราคาทุนของสินค้าและบันทึกประวัติให้
            </p>
          </div>
          {costNote && (
            <p className="col-span-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1">
              {costNote}
            </p>
          )}
          <button type="button" onClick={add}
            disabled={busy || !qty}
            className="col-span-2 py-1.5 rounded-lg bg-brand text-white text-xs font-bold disabled:opacity-50">
            {t("inv.lot.add")}
          </button>
        </div>
      </div>
    </details>
  );
}
