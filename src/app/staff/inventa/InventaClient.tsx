"use client";

import { useMemo, useRef, useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import {
  PICK_FREQ_META, isLowStock,
  type PickFreq, type ItemType, type InventaSupplier, type InventaLookup
} from "@/lib/inventa";

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
  unit: string | null;
  unit_cost: number;
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
  const [edit, setEdit] = useState<Item | null>(null);
  const [adding, setAdding] = useState<Partial<Item> | null>(null);
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanCam, setScanCam] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const refresh = () => startTransition(() => router.refresh());

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((i) => {
      if (freqFilter && i.pick_freq !== freqFilter) return false;
      if (!term) return true;
      return [
        i.name, i.generic_name, i.item_code, i.barcode,
        i.category, i.storage_location
      ].some((v) => (v ?? "").toLowerCase().includes(term));
    });
  }, [items, q, freqFilter]);

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
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2 pr-3">{t("inv.col.band")}</th>
              <th className="py-2 pr-3">{t("inv.col.name")}</th>
              <th className="py-2 pr-3">{t("inv.col.category")}</th>
              <th className="py-2 pr-3">{t("inv.col.supplier")}</th>
              <th className="py-2 pr-3">{t("inv.col.unit")}</th>
              <th className="py-2 pr-3 text-right">{t("inv.col.cost")}</th>
              <th className="py-2 pr-3 text-right">{t("inv.col.qty")}</th>
              <th className="py-2 pr-3 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((i) => {
              const low = isLowStock(i.current_qty, i.safety_stock);
              const fm = i.pick_freq ? PICK_FREQ_META[i.pick_freq] : null;
              return (
                <tr key={i.id}
                  className={`border-b last:border-0 ${low ? "bg-rose-50/50" : "hover:bg-slate-50"}`}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {fm && (
                      <span title={fm.label}
                        className={`inline-block w-3.5 h-3.5 rounded-full align-middle ${fm.dot}`} />
                    )}
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {i.storage_location || t("inv.dash")}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{i.name}</div>
                    {i.generic_name && (
                      <div className="text-xs text-slate-400">{i.generic_name}</div>
                    )}
                    {i.item_code && (
                      <div className="text-[10px] text-slate-400">{i.item_code}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-slate-600 text-xs">{i.category ?? t("inv.dash")}</td>
                  <td className="py-2 pr-3 text-slate-600 text-xs">{i.supplier_name ?? t("inv.dash")}</td>
                  <td className="py-2 pr-3 text-slate-600 text-xs">{i.unit ?? t("inv.dash")}</td>
                  <td className="py-2 pr-3 text-right text-slate-700">
                    {i.unit_cost ? i.unit_cost.toLocaleString(undefined, { maximumFractionDigits: 4 }) : t("inv.dash")}
                  </td>
                  <td className={`py-2 pr-3 text-right font-bold ${low ? "text-rose-600" : "text-slate-800"}`}>
                    {i.current_qty}
                    {low && <span className="ml-1 text-[10px] font-normal">{t("inv.low")}</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button type="button" onClick={() => setEdit(i)}
                      className="text-xs text-brand hover:underline">{t("inv.btn.edit")}</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="py-6 text-center text-slate-400 text-sm">
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
  item, seed, suppliers, lookups, onClose, onSaved
}: {
  item: Item | null;
  seed?: Partial<Item>;
  suppliers: InventaSupplier[];
  lookups: InventaLookup[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();
  const opts = (kind: string) =>
    lookups.filter((l) => l.kind === kind).map((l) => l.value);
  const storageOpts = opts("storage");
  const unitOpts = opts("unit");
  const categoryOpts = opts("category");

  const base: Partial<Item> = item ?? seed ?? {};
  const [f, setF] = useState({
    item_code: base.item_code ?? "",
    barcode: base.barcode ?? "",
    name: base.name ?? "",
    generic_name: base.generic_name ?? "",
    category: base.category ?? "",
    item_type: (base.item_type ?? "drug") as ItemType,
    unit: base.unit ?? "",
    unit_cost: base.unit_cost != null ? String(base.unit_cost) : "",
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
        unit: f.unit.trim() || null,
        unit_cost: f.unit_cost ? Number(f.unit_cost) : 0,
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
            <label className="label">{t("inv.f.type")} *</label>
            <select className="input" value={f.item_type}
              onChange={(e) => up("item_type", e.target.value)}>
              <option value="drug">{t("inv.type.goods")}</option>
              <option value="equipment">{t("inv.type.material")}</option>
            </select>
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
            <select className="input" value={f.category}
              onChange={(e) => up("category", e.target.value)}>
              <option value="">{t("inv.cat.choose")}</option>
              {categoryOpts.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
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
          <div>
            <label className="label">{t("inv.f.cost")}</label>
            <input className="input" type="number" min="0" step="0.0001"
              value={f.unit_cost}
              onChange={(e) => up("unit_cost", e.target.value)}
              placeholder={t("inv.f.costPh")} />
          </div>
          <div>
            <label className="label">{t("inv.f.onhand")}</label>
            <input className="input" type="number" min="0" value={f.current_qty}
              onChange={(e) => up("current_qty", e.target.value)} />
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
