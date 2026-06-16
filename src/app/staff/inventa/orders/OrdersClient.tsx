"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import {
  binCode, hasPack, formatPackBreakdown,
  isFractionalItem, fracOnHand, formatFracQty, isLowStockItem,
  type PickFreq
} from "@/lib/inventa";
import { type OrderRow, isPendingOrder } from "@/lib/inventa-orders";

export type LowStockItem = {
  id: number;
  name: string;
  item_code: string | null;
  unit: string | null;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  current_qty: number;
  safety_stock: number;
  count_mode?: "discrete" | "fractional" | null;
  qty_frac?: number | null;
  /** 1 = muted from the reorder list (LASA substitute not in use). */
  reorder_muted?: number | null;
  /** Moving avg derived from purchase lines; fallback when
   *  cost_price is null. Kept on the row so a re-tagged item with
   *  no manual price still shows a sensible estimate. */
  unit_cost: number;
  /** Owner-pinned cost. Wins over unit_cost for total estimation
   *  so the budget number on screen stays under the owner's
   *  control regardless of receipt history. Null = use unit_cost. */
  cost_price: number | null;
  supplier_name: string | null;
  /** N5 pack — surfaces "= N กล่อง" next to the order qty so staff can
   *  round to whole packs. Null when the item has no pack. */
  pack_unit: string | null;
  pack_size: number | null;
};

/** Pick the per-unit cost used in PO totals. cost_price wins; if
 *  null we fall back to the auto-derived unit_cost. Both treated
 *  as non-negative — the server-side validators enforce that. */
function effectiveCost(it: LowStockItem): number {
  return it.cost_price != null ? it.cost_price : (it.unit_cost ?? 0);
}

/** Format a baht figure with thousands sep + 2dp. Centralised so
 *  the supplier subtotal, grand total, and the per-line preview all
 *  share the same look. */
function fmtBaht(n: number): string {
  return "฿" + n.toLocaleString("th-TH", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}


export default function OrdersClient({
  lowStock, catalog = [], orders
}: {
  lowStock: LowStockItem[];
  catalog?: LowStockItem[];
  orders: OrderRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  // Pending = created POs still awaiting follow-up. Surfaced as a badge on
  // the link to the tracking page so an open order isn't forgotten.
  const pendingCount = useMemo(
    () => orders.filter((o) => isPendingOrder(o.status)).length,
    [orders]
  );
  // selected item_id → order qty (string for the input). Default qty
  // = max(0, safety - current). Unchecked = not in the order.
  const [sel, setSel] = useState<Record<number, string>>({});
  // G6 (owner 2026-06-10): per-item order unit. false = base unit (เม็ด),
  // true = the configured pack unit (กล่อง). The typed qty is in this
  // unit; it's converted to base units before sending so current_qty +
  // cost-per-unit stay consistent. Only meaningful when hasPack(item).
  const [packMode, setPackMode] = useState<Record<number, boolean>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // Extra catalogue items added manually (owner 2026-06-06) — beyond the
  // "should order" low-stock list. They render in their supplier group
  // alongside low-stock rows and flow through the same submit.
  const [extraItems, setExtraItems] = useState<LowStockItem[]>([]);
  // Which "add item" box is open (owner 2026-06-06): a supplier key for a
  // per-supplier add, or the sentinel OTHER_KEY for the "new supplier"
  // box. null = all closed. Only one box is open at a time.
  const OTHER_KEY = "__other__";
  const [addOpenFor, setAddOpenFor] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const noSupplierLabel = t("inv.ord.noSupplier");
  const supplierKey = (it: LowStockItem) => it.supplier_name ?? noSupplierLabel;

  // Draft persistence (owner 2026-06-16): keep the selection + quantities so
  // navigating away and back doesn't lose work. Stored in localStorage; extra
  // (manually-added) items are restored from the CURRENT catalogue only, so a
  // draft saved on another branch can't leak foreign items in.
  const DRAFT_KEY = "inventa_order_draft_v1";
  const hydratedRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as {
          sel?: Record<number, string>; packMode?: Record<number, boolean>;
          note?: string; extraIds?: number[];
        };
        if (d.sel) setSel(d.sel);
        if (d.packMode) setPackMode(d.packMode);
        if (typeof d.note === "string") setNote(d.note);
        if (d.extraIds?.length) {
          const byId = new Map(catalog.map((c) => [c.id, c]));
          const restored = d.extraIds
            .map((id) => byId.get(id))
            .filter((x): x is LowStockItem => !!x);
          if (restored.length) setExtraItems(restored);
        }
      }
    } catch { /* corrupt/unavailable — ignore */ }
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        sel, packMode, note, extraIds: extraItems.map((e) => e.id)
      }));
    } catch { /* quota/unavailable — ignore */ }
  }, [sel, packMode, note, extraItems]);
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }
  function clearSelection() {
    setSel({}); setPackMode({}); setNote(""); setExtraItems([]);
    clearDraft();
  }

  // Low-stock list + any manually-added catalogue items (deduped by id).
  const allItems = useMemo(() => {
    const seen = new Set(lowStock.map((i) => i.id));
    const merged = [...lowStock];
    for (const e of extraItems) if (!seen.has(e.id)) { merged.push(e); seen.add(e.id); }
    return merged;
  }, [lowStock, extraItems]);

  const groups = useMemo(() => {
    const m = new Map<string, LowStockItem[]>();
    for (const it of allItems) {
      const k = it.supplier_name ?? noSupplierLabel;
      const arr = m.get(k) ?? [];
      arr.push(it);
      m.set(k, arr);
    }
    return [...m.entries()];
  }, [allItems, noSupplierLabel]);

  // Catalogue candidates for the currently-open add box, scoped to its
  // supplier (owner 2026-06-06): a per-supplier box shows ONLY that
  // vendor's items; the OTHER box shows items from suppliers not yet in
  // the builder (so you can start a new vendor group). Excludes items
  // already shown; matches the search; capped to keep the list short.
  const groupKeySet = useMemo(() => new Set(groups.map(([k]) => k)), [groups]);
  const addCandidates = useMemo(() => {
    if (!addOpenFor) return [];
    const shown = new Set(allItems.map((i) => i.id));
    const q = addQuery.trim().toLowerCase();
    return catalog.filter((c) => {
      if (shown.has(c.id)) return false;
      const key = supplierKey(c);
      if (addOpenFor === OTHER_KEY) { if (groupKeySet.has(key)) return false; }
      else if (key !== addOpenFor) return false;
      if (q && !c.name.toLowerCase().includes(q) && !(c.item_code ?? "").toLowerCase().includes(q)) return false;
      return true;
    }).slice(0, 15);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, allItems, addQuery, addOpenFor, groupKeySet]);

  function addExtra(it: LowStockItem) {
    setExtraItems((p) => (p.some((e) => e.id === it.id) ? p : [...p, it]));
    setSel((p) => ({ ...p, [it.id]: p[it.id] ?? String(Math.max(1, suggested(it) || 1)) }));
    setAddQuery("");
  }

  // Render the "add item" control for a given target (supplier key or
  // OTHER_KEY). A plain render function — NOT a nested component — so the
  // search input keeps focus across keystrokes. Only the open target
  // shows its candidate list.
  const renderAddBox = (targetKey: string, openLabel: string, placeholder: string) => {
    const open = addOpenFor === targetKey;
    return (
      <div className="pt-1.5">
        {!open ? (
          <button type="button"
            onClick={() => { setAddOpenFor(targetKey); setAddQuery(""); }}
            className="text-xs text-brand hover:underline font-medium">
            {openLabel}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input className="input text-sm flex-1" placeholder={placeholder}
                value={addQuery} onChange={(e) => setAddQuery(e.target.value)} autoFocus />
              <button type="button"
                onClick={() => { setAddOpenFor(null); setAddQuery(""); }}
                className="text-xs text-slate-500 hover:underline whitespace-nowrap">ปิด</button>
            </div>
            {addQuery.trim() && addCandidates.length === 0 && (
              <p className="text-xs text-slate-400">ไม่พบสินค้า</p>
            )}
            {addCandidates.length > 0 && (
              <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                {addCandidates.map((c) => (
                  <button type="button" key={c.id} onClick={() => addExtra(c)}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-2">
                    <span className="text-sm min-w-0">
                      <span className="font-medium text-slate-800">{c.name}</span>
                      {c.item_code && <span className="ml-1 text-[11px] text-slate-400">[{c.item_code}]</span>}
                      <span className="block text-[11px] text-slate-500">
                        {c.supplier_name ?? noSupplierLabel} · {t("inv.ord.onhand")}{" "}
                        {isFractionalItem(c) ? formatFracQty(fracOnHand(c)) : `${c.current_qty}${c.unit ? ` ${c.unit}` : ""}`}
                      </span>
                    </span>
                    <span className="text-brand font-bold text-sm flex-shrink-0">+ เพิ่ม</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  function suggested(it: LowStockItem): number {
    // Fractional items order in whole bottles — default to 1 bottle when low
    // (staff can bump it). Discrete: top up to the safety level.
    if (isFractionalItem(it)) return 1;
    return Math.max(0, it.safety_stock - it.current_qty);
  }
  function toggle(it: LowStockItem) {
    // A freshly (re)selected row always starts in the base unit; clear any
    // stale pack-mode flag so the seeded base qty isn't read as packs (G6).
    setPackMode((p) => (it.id in p ? (() => { const n = { ...p }; delete n[it.id]; return n; })() : p));
    setSel((p) => {
      const next = { ...p };
      if (it.id in next) delete next[it.id];
      else next[it.id] = String(suggested(it) || 1);
      return next;
    });
  }
  function setQty(id: number, v: string) {
    setSel((p) => ({ ...p, [id]: v.replace(/[^0-9]/g, "") }));
  }
  // ── G6 order-unit conversion ──────────────────────────────────────
  /** Is this row currently being ordered in its pack unit? */
  function inPack(it: LowStockItem): boolean {
    return !!packMode[it.id] && hasPack(it);
  }
  /** The unit label to show next to the qty input for this row. */
  function unitLabel(it: LowStockItem): string {
    return inPack(it) ? (it.pack_unit ?? "") : (it.unit ?? t("inv.ord.unit"));
  }
  /** Convert the typed qty (in the row's current unit) to base units —
   *  what the API + stock + cost all expect. */
  function toBaseQty(it: LowStockItem, typed: string | number): number {
    const n = Number(typed) || 0;
    return inPack(it) && it.pack_size ? n * it.pack_size : n;
  }
  /** Flip a row between base unit and pack unit. Re-seeds the qty to a
   *  whole, sensible amount in the new unit so the input never carries a
   *  fractional value across the switch. */
  function toggleUnit(it: LowStockItem) {
    if (!hasPack(it)) return;
    const nextPack = !packMode[it.id];
    setPackMode((p) => ({ ...p, [it.id]: nextPack }));
    setSel((s) => {
      if (!(it.id in s)) return s;
      const sug = suggested(it) || 1;
      const val = nextPack && it.pack_size
        ? String(Math.max(1, Math.ceil(sug / it.pack_size)))
        : String(sug);
      return { ...s, [it.id]: val };
    });
  }
  function selectAll() {
    const all: Record<number, string> = {};
    for (const it of allItems) all[it.id] = String(suggested(it) || 1);
    setSel(all);
    setPackMode({}); // bulk-seeded qtys are all in base units
  }
  // Per-supplier select/clear (owner 2026-06-06) — lets staff issue a PO
  // for just some suppliers now and come back for the rest later. When
  // every item in the group is already selected, clicking clears the
  // group; otherwise it selects all of them.
  function supplierState(items: LowStockItem[]): "all" | "some" | "none" {
    const picked = items.filter((it) => it.id in sel).length;
    if (picked === 0) return "none";
    if (picked === items.length) return "all";
    return "some";
  }
  function toggleSupplier(items: LowStockItem[]) {
    const allPicked = items.every((it) => it.id in sel);
    setSel((p) => {
      const next = { ...p };
      if (allPicked) {
        for (const it of items) delete next[it.id];
      } else {
        for (const it of items) next[it.id] = next[it.id] ?? String(suggested(it) || 1);
      }
      return next;
    });
    // Clear pack-mode for the rows this touched so newly-seeded base qtys
    // aren't misread as packs (G6).
    setPackMode((p) => {
      const next = { ...p };
      for (const it of items) delete next[it.id];
      return next;
    });
  }

  const chosen = Object.entries(sel)
    .map(([id, q]) => {
      const it = allItems.find((x) => x.id === Number(id));
      // order_qty is always sent in BASE units (the pack toggle is a
      // data-entry convenience only) so the API, stock, and cost stay
      // in one consistent unit.
      return { item_id: Number(id), order_qty: it ? toBaseQty(it, q) : Number(q) || 0 };
    })
    .filter((l) => l.order_qty > 0);

  // Live PO totals. Rebuilds on every sel/qty change so the budget
  // figure tracks the user's keystrokes. Per-supplier subtotal helps
  // the owner decide whether to defer/split a vendor (#91).
  const itemById = useMemo(() => {
    const m = new Map<number, LowStockItem>();
    for (const it of allItems) m.set(it.id, it);
    return m;
  }, [allItems]);
  const totalsBySupplier = useMemo(() => {
    const m = new Map<string, number>();
    for (const [idStr, qStr] of Object.entries(sel)) {
      const it = itemById.get(Number(idStr));
      if (!it) continue;
      const qty = toBaseQty(it, qStr);
      if (qty <= 0) continue;
      const key = it.supplier_name ?? t("inv.ord.noSupplier");
      m.set(key, (m.get(key) ?? 0) + qty * effectiveCost(it));
    }
    return m;
  }, [sel, packMode, itemById, t]);
  const grandTotal = useMemo(() => {
    let n = 0;
    for (const v of totalsBySupplier.values()) n += v;
    return n;
  }, [totalsBySupplier]);

  /** POST a set of lines as PO(s). Returns the created order ids, or null
   *  on failure (error already surfaced). Shared by the global submit and
   *  the per-supplier create buttons. */
  async function postOrder(lines: Array<{ item_id: number; order_qty: number }>): Promise<number[] | null> {
    const res = await fetch(apiUrl("/api/inventa/orders"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note.trim() || undefined, lines })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) { setErr(j.error ?? t("inv.ord.sendFail")); return null; }
    return Array.isArray(j.ids) ? j.ids : (j.id ? [j.id] : []);
  }

  async function submit() {
    if (chosen.length === 0) { setErr(t("inv.ord.selectMin")); return; }
    setBusy(true); setErr(null); setOkMsg(null);
    try {
      const ids = await postOrder(chosen);
      if (!ids) return;
      clearDraft();
      if (ids.length === 1) {
        // Single supplier → go straight to its PO.
        router.push(`/staff/inventa/orders/${ids[0]}`);
        return;
      }
      // Multiple suppliers → split into separate POs; stay here and show
      // them in "ใบสั่งซื้อล่าสุด".
      setSel({});
      setNote("");
      setExtraItems([]);
      setOkMsg(`สร้างใบสั่งซื้อ ${ids.length} ใบ (แยกตามผู้จำหน่าย) แล้ว — เปิดแต่ละใบเพื่อพิมพ์/ส่ง`);
      router.refresh();
    } catch {
      setErr(t("inv.ord.sendFail"));
    } finally {
      setBusy(false);
    }
  }

  /** Create a PO for ONE supplier's selected lines (owner F3 2026-06-07).
   *  Stays on the page so staff can issue the remaining suppliers one at a
   *  time; the just-created PO appears under "ใบสั่งซื้อล่าสุด". */
  async function submitSupplier(supplier: string, items: LowStockItem[]) {
    const ids = new Set(items.map((i) => i.id));
    const lines = chosen.filter((l) => ids.has(l.item_id));
    if (lines.length === 0) { setErr(t("inv.ord.selectMin")); return; }
    setBusy(true); setErr(null); setOkMsg(null);
    try {
      const created = await postOrder(lines);
      if (!created) return;
      // Drop just this supplier's lines from the selection; keep the rest.
      setSel((prev) => {
        const next = { ...prev };
        for (const l of lines) delete next[l.item_id];
        return next;
      });
      setOkMsg(`สร้างใบสั่งซื้อของ ${supplier} แล้ว — เปิดด้านล่างเพื่อพิมพ์/ส่ง (ผู้จำหน่ายอื่นกดสร้างต่อได้)`);
      router.refresh();
    } catch {
      setErr(t("inv.ord.sendFail"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Reorder builder ─────────────────────────────────────── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800 text-sm">
            {t("inv.ord.reorder", { n: lowStock.length })}
          </h2>
          <div className="flex items-center gap-3">
            {(chosen.length > 0 || extraItems.length > 0) && (
              <button type="button" onClick={clearSelection}
                className="text-xs text-slate-400 hover:text-rose-600 hover:underline">
                ล้างที่เลือก
              </button>
            )}
            {allItems.length > 0 && (
              <button type="button" onClick={selectAll}
                className="text-xs text-brand hover:underline">
                {t("inv.ord.selectAll")}
              </button>
            )}
          </div>
        </div>

        {lowStock.length === 0 && extraItems.length === 0 && (
          <p className="text-sm text-slate-400">
            {t("inv.ord.noLow")}
          </p>
        )}

        {groups.map(([supplier, items]) => {
          const subtotal = totalsBySupplier.get(supplier) ?? 0;
          const supState = supplierState(items);
          return (
            <div key={supplier} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 bg-ink-gradient text-white rounded-lg px-3 py-2 mt-1">
                {/* Per-supplier checkbox — select/clear the whole vendor so
                    staff can issue a PO for just some suppliers now and
                    defer the rest (owner 2026-06-06). */}
                <label className="flex items-center gap-2 min-w-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={supState === "all"}
                    ref={(el) => { if (el) el.indeterminate = supState === "some"; }}
                    onChange={() => toggleSupplier(items)}
                    className="flex-shrink-0"
                  />
                  <span className="text-sm font-bold truncate">
                    {supplier}
                    <span className="ml-2 text-[11px] font-normal text-white/70">{items.length} รายการ</span>
                  </span>
                </label>
                {subtotal > 0 && (
                  <div className="text-xs font-bold flex-shrink-0">
                    {fmtBaht(subtotal)}
                  </div>
                )}
              </div>
              {items.map((it) => {
                const checked = it.id in sel;
                const bin = binCode(it.grid_row, it.grid_col, it.pick_freq);
                const cost = effectiveCost(it);
                // qty is always in BASE units (typed value × pack_size when
                // the row is in pack mode) so cost/total math is unit-safe.
                const qty = checked ? toBaseQty(it, sel[it.id]) : 0;
                const lineTotal = qty * cost;
                // Cost source label. cost_price = owner-pinned; else the
                // value derived from the item's last purchase price. A
                // zero means neither was ever entered — flag it clearly
                // so the owner knows which items need a cost (the ฿0.00
                // wasn't a calc bug; the purchase price is just missing).
                const costMissing = cost <= 0;
                const costSrc = it.cost_price != null
                  ? t("inv.ord.costSrcManual")
                  : t("inv.ord.costSrcAvg");
                return (
                  <div key={it.id}
                    className={"flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 " +
                      (checked ? "bg-rose-50/40" : "")}>
                    <label className="flex items-center gap-2 flex-1 min-w-[180px] cursor-pointer">
                      <input type="checkbox" checked={checked}
                        onChange={() => toggle(it)} />
                      <span className="text-sm">
                        <span className="font-medium text-slate-800">{it.name}</span>
                        {bin && <span className="ml-1 text-[11px] text-slate-400">[{bin}]</span>}
                        <span className="block text-[11px] text-slate-500">
                          {/* On-hand qty emphasised + colour-coded by reorder
                              point (owner F4 2026-06-07): below the reorder
                              point → red; at/above → black, both bold. */}
                          {t("inv.ord.onhand")}{" "}
                          <span className={`font-bold text-sm ${
                            isLowStockItem(it) ? "text-rose-600" : "text-slate-900"}`}>
                            {isFractionalItem(it) ? formatFracQty(fracOnHand(it)) : it.current_qty}
                          </span>
                          {isFractionalItem(it) ? "" : (it.unit ? ` ${it.unit}` : "")}
                          {" "}/ {t("inv.ord.repoint")}{" "}
                          {isFractionalItem(it) ? `${it.safety_stock}% ของขวด` : it.safety_stock}
                          {" "}· {t("inv.ord.cost")}{" "}
                          {costMissing ? (
                            <span className="text-rose-600 font-medium">{t("inv.ord.costMissing")}</span>
                          ) : (
                            <>฿{cost.toFixed(2)}<span className="text-slate-400"> ({costSrc})</span></>
                          )}
                        </span>
                      </span>
                    </label>
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] text-slate-500">{t("inv.ord.order")}</span>
                      <input
                        className="input !w-20 !py-1 text-sm text-right"
                        inputMode="numeric"
                        value={checked ? sel[it.id] : String(suggested(it))}
                        disabled={!checked}
                        onChange={(e) => setQty(it.id, e.target.value)}
                      />
                      {/* Fixed-width unit so every qty input lines up in a
                          column regardless of unit length (owner 2026-06-07:
                          เม็ด/ขวด/กล่อง/แอมป์ differ in width). When the item
                          has a pack unit, this becomes a tap-to-switch toggle
                          (G6) so staff can order in หน่วยย่อย or แพ็ค. */}
                      {hasPack(it) ? (
                        <button type="button"
                          disabled={!checked}
                          onClick={() => toggleUnit(it)}
                          title="แตะเพื่อสลับหน่วยสั่งซื้อ (หน่วยย่อย ↔ แพ็ค)"
                          className="text-[11px] inline-block w-12 text-left underline decoration-dotted underline-offset-2 text-brand disabled:text-slate-400 disabled:no-underline">
                          {unitLabel(it)} ⇅
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-500 inline-block w-12 text-left">{it.unit ?? t("inv.ord.unit")}</span>
                      )}
                    </div>
                    {/* Pack ↔ base conversion hint. When ordering in packs,
                        show how many base units that is (e.g. 1 กล่อง = 500
                        เม็ด); when ordering in base units, show the whole-pack
                        breakdown (N5, e.g. 50 เม็ด = 5 กล่อง). */}
                    {/* Per-line live preview — on its own line BELOW the row
                        (owner 2026-06-16): the sub-unit breakdown when ordering
                        by pack, then the line cost as an emphasised pill. */}
                    {checked && qty > 0 && hasPack(it) && (
                      <div className="w-full text-sm font-semibold text-emerald-700 mt-0.5">
                        {inPack(it)
                          ? `= ${qty.toLocaleString("th-TH")} ${it.unit ?? ""}`
                          : `= ${formatPackBreakdown(qty, it, it.unit)}`}
                      </div>
                    )}
                    {checked && lineTotal > 0 && (
                      <div className="w-full text-right mt-0.5">
                        <span className="inline-block bg-brand/10 text-brand font-bold text-base rounded-md px-2.5 py-0.5">
                          = {fmtBaht(lineTotal)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
              {/* Per-supplier add — only this vendor's catalogue items
                  (owner 2026-06-06). Sits at the bottom of the group. */}
              {renderAddBox(supplier, "+ เพิ่มสินค้าจากผู้จำหน่ายนี้", "ค้นหาสินค้าของผู้จำหน่ายนี้…")}
              {/* Per-supplier "create PO" — issue this vendor now, defer the
                  rest (owner R3 2026-06-07). Always shown; disabled until at
                  least one of THIS vendor's rows is ticked. The button
                  carries this vendor's subtotal so it's clear what you're
                  about to order. */}
              {(() => {
                const pickedCount = items.filter((it) => it.id in sel).length;
                return (
                  <div className="flex items-center justify-between gap-2 pt-2">
                    <span className="text-[11px] text-slate-500">
                      {pickedCount > 0
                        ? <>เลือก {pickedCount} รายการ{subtotal > 0 && <> · {fmtBaht(subtotal)}</>}</>
                        : "ยังไม่ได้เลือกรายการของผู้จำหน่ายนี้"}
                    </span>
                    <button type="button" disabled={busy || supState === "none"}
                      onClick={() => submitSupplier(supplier, items)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0">
                      สร้างใบสั่งซื้อ{subtotal > 0 ? ` · ${fmtBaht(subtotal)}` : ""}
                    </button>
                  </div>
                );
              })()}
            </div>
          );
        })}

        {/* Add items from a supplier NOT yet in the list (starts a new
            vendor group). Per-supplier adds live inside each group above. */}
        <div className="border-t border-slate-100 pt-3">
          {renderAddBox(OTHER_KEY, "+ เพิ่มจากผู้จำหน่ายอื่น (ที่ยังไม่มีในรายการ)", "ค้นหาสินค้าด้วยชื่อหรือรหัส…")}
        </div>

        {allItems.length > 0 && (
          <div className="border-t border-slate-100 pt-3 space-y-2">
            {/* Grand-total budget bar (#91). Sticks visually right
                above the submit row so the figure stays in the
                owner's peripheral vision as they tick items. */}
            {chosen.length > 0 && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-baseline justify-between gap-3">
                <div>
                  <div className="text-[11px] text-emerald-700 uppercase tracking-[1px] font-bold">
                    {t("inv.ord.estTotal")}
                  </div>
                  <div className="text-[10px] text-emerald-700/70 mt-0.5">
                    {t("inv.ord.estTotalHint", { n: chosen.length })}
                  </div>
                </div>
                <div className="text-2xl font-bold text-emerald-700 tabular-nums">
                  {fmtBaht(grandTotal)}
                </div>
              </div>
            )}
            <textarea className="input text-sm" rows={2} value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("inv.ord.notePh")} />
            {err && <div className="text-sm text-rose-600">{err}</div>}
            <div className="flex items-center gap-3">
              <button type="button" onClick={submit}
                disabled={busy || chosen.length === 0}
                className="btn-primary text-sm disabled:opacity-50">
                {busy ? t("inv.ord.sending") : t("inv.ord.submit", { n: chosen.length })}
              </button>
              <span className="text-[11px] text-slate-400">
                {t("inv.ord.submitHint")}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Link to the created-orders tracking page (owner 2026-06-13).
             The full list now lives on its own prominent menu so open POs
             don't get forgotten at the bottom of this create workspace. ── */}
      <div className="card space-y-2">
        {okMsg && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            {okMsg}
          </div>
        )}
        <Link
          href="/staff/inventa/orders/list"
          className="flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 hover:bg-amber-100 transition"
        >
          <span className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-800">{t("inv.ord.viewCreated")}</span>
            {pendingCount > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-200 text-amber-800 font-medium">
                {t("inv.ord.pendingBadge", { n: pendingCount })}
              </span>
            )}
          </span>
          <span className="text-amber-700 font-bold">→</span>
        </Link>
      </div>
    </div>
  );
}
