"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { binCode, type PickFreq } from "@/lib/inventa";

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
  /** Moving avg derived from purchase lines; fallback when
   *  cost_price is null. Kept on the row so a re-tagged item with
   *  no manual price still shows a sensible estimate. */
  unit_cost: number;
  /** Owner-pinned cost. Wins over unit_cost for total estimation
   *  so the budget number on screen stays under the owner's
   *  control regardless of receipt history. Null = use unit_cost. */
  cost_price: number | null;
  supplier_name: string | null;
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

export type OrderRow = {
  id: number;
  status: "draft" | "sent" | "approved" | "received" | "cancelled";
  note: string | null;
  created_at: string;
  sent_at: string | null;
  approved_at: string | null;
  line_count: number;
  total_cost: number;
  created_by_name: string | null;
  approved_by_name: string | null;
  supplier_name: string | null;
};

const STATUS_CLS: Record<OrderRow["status"], string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  received: "bg-sky-100 text-sky-700",
  cancelled: "bg-rose-100 text-rose-600"
};

export default function OrdersClient({
  lowStock, catalog = [], orders, canApprove
}: {
  lowStock: LowStockItem[];
  catalog?: LowStockItem[];
  orders: OrderRow[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const { t } = useLang();
  // selected item_id → order qty (string for the input). Default qty
  // = max(0, safety - current). Unchecked = not in the order.
  const [sel, setSel] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // Extra catalogue items added manually (owner 2026-06-06) — beyond the
  // "should order" low-stock list. They render in their supplier group
  // alongside low-stock rows and flow through the same submit.
  const [extraItems, setExtraItems] = useState<LowStockItem[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addQuery, setAddQuery] = useState("");

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
      const k = it.supplier_name ?? t("inv.ord.noSupplier");
      const arr = m.get(k) ?? [];
      arr.push(it);
      m.set(k, arr);
    }
    return [...m.entries()];
  }, [allItems, t]);

  // Catalogue items NOT already shown (low-stock or added), filtered by
  // the search box. Capped so a big catalogue doesn't render hundreds.
  const addCandidates = useMemo(() => {
    const shown = new Set(allItems.map((i) => i.id));
    const q = addQuery.trim().toLowerCase();
    return catalog
      .filter((c) => !shown.has(c.id))
      .filter((c) => !q ||
        c.name.toLowerCase().includes(q) ||
        (c.item_code ?? "").toLowerCase().includes(q))
      .slice(0, 15);
  }, [catalog, allItems, addQuery]);

  function addExtra(it: LowStockItem) {
    setExtraItems((p) => (p.some((e) => e.id === it.id) ? p : [...p, it]));
    setSel((p) => ({ ...p, [it.id]: p[it.id] ?? String(Math.max(1, suggested(it) || 1)) }));
    setAddQuery("");
  }

  function suggested(it: LowStockItem): number {
    return Math.max(0, it.safety_stock - it.current_qty);
  }
  function toggle(it: LowStockItem) {
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
  function selectAll() {
    const all: Record<number, string> = {};
    for (const it of allItems) all[it.id] = String(suggested(it) || 1);
    setSel(all);
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
    setSel((p) => {
      const next = { ...p };
      const allPicked = items.every((it) => it.id in next);
      if (allPicked) {
        for (const it of items) delete next[it.id];
      } else {
        for (const it of items) next[it.id] = next[it.id] ?? String(suggested(it) || 1);
      }
      return next;
    });
  }

  const chosen = Object.entries(sel)
    .map(([id, q]) => ({ item_id: Number(id), order_qty: Number(q) }))
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
      const qty = Number(qStr) || 0;
      if (qty <= 0) continue;
      const key = it.supplier_name ?? t("inv.ord.noSupplier");
      m.set(key, (m.get(key) ?? 0) + qty * effectiveCost(it));
    }
    return m;
  }, [sel, itemById, t]);
  const grandTotal = useMemo(() => {
    let n = 0;
    for (const v of totalsBySupplier.values()) n += v;
    return n;
  }, [totalsBySupplier]);

  async function submit() {
    if (chosen.length === 0) { setErr(t("inv.ord.selectMin")); return; }
    setBusy(true); setErr(null); setOkMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/orders"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || undefined, lines: chosen })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("inv.ord.sendFail")); return; }
      const ids: number[] = Array.isArray(j.ids) ? j.ids : (j.id ? [j.id] : []);
      if (ids.length === 1) {
        // Single supplier → go straight to its PO.
        router.push(`/staff/inventa/orders/${ids[0]}`);
        return;
      }
      // Multiple suppliers → split into separate POs; stay here and show
      // them in "ใบสั่งซื้อล่าสุด".
      setSel({});
      setNote("");
      setOkMsg(`สร้างใบสั่งซื้อ ${ids.length} ใบ (แยกตามผู้จำหน่าย) แล้ว — เปิดแต่ละใบเพื่อพิมพ์/ส่ง`);
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
          {allItems.length > 0 && (
            <button type="button" onClick={selectAll}
              className="text-xs text-brand hover:underline">
              {t("inv.ord.selectAll")}
            </button>
          )}
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
                const qty = checked ? (Number(sel[it.id]) || 0) : 0;
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
                          {t("inv.ord.onhand")} {it.current_qty} / {t("inv.ord.repoint")} {it.safety_stock}
                          {it.unit ? ` ${it.unit}` : ""} · {t("inv.ord.cost")}{" "}
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
                      <span className="text-[11px] text-slate-500">{it.unit ?? t("inv.ord.unit")}</span>
                    </div>
                    {/* Per-line live preview — appears only when the
                        row is selected so the unchecked rows stay
                        quiet. Right-aligned to match qty column. */}
                    {checked && lineTotal > 0 && (
                      <div className="w-full text-right text-[11px] text-slate-600 -mt-0.5">
                        = {fmtBaht(lineTotal)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* ── Add other items (owner 2026-06-06) ──────────────────────
            Pull any active catalogue item into this PO even if it isn't
            low-stock. Useful for one-off / planned purchases. */}
        <div className="border-t border-slate-100 pt-3">
          {!showAdd ? (
            <button type="button" onClick={() => setShowAdd(true)}
              className="text-xs text-brand hover:underline font-medium">
              + เพิ่มรายการอื่น (นอกเหนือจากที่ควรสั่ง)
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  className="input text-sm flex-1"
                  placeholder="ค้นหาสินค้าด้วยชื่อหรือรหัส…"
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  autoFocus
                />
                <button type="button"
                  onClick={() => { setShowAdd(false); setAddQuery(""); }}
                  className="text-xs text-slate-500 hover:underline whitespace-nowrap">
                  ปิด
                </button>
              </div>
              {addQuery.trim() && addCandidates.length === 0 && (
                <p className="text-xs text-slate-400">ไม่พบสินค้า (อาจอยู่ในรายการด้านบนแล้ว)</p>
              )}
              {addCandidates.length > 0 && (
                <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {addCandidates.map((c) => (
                    <button type="button" key={c.id}
                      onClick={() => addExtra(c)}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-2">
                      <span className="text-sm min-w-0">
                        <span className="font-medium text-slate-800">{c.name}</span>
                        {c.item_code && <span className="ml-1 text-[11px] text-slate-400">[{c.item_code}]</span>}
                        <span className="block text-[11px] text-slate-500">
                          {c.supplier_name ?? t("inv.ord.noSupplier")} · {t("inv.ord.onhand")} {c.current_qty}{c.unit ? ` ${c.unit}` : ""}
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

      {/* ── Recent orders ───────────────────────────────────────── */}
      <div className="card space-y-2">
        {okMsg && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            {okMsg}
          </div>
        )}
        <h2 className="font-bold text-slate-800 text-sm">
          {t("inv.ord.recent", { n: orders.length })}
        </h2>
        {orders.length === 0 && (
          <p className="text-sm text-slate-400">{t("inv.ord.none")}</p>
        )}
        {orders.map((o) => {
          return (
            <Link key={o.id} href={`/staff/inventa/orders/${o.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-2 hover:bg-slate-50 -mx-1 px-1 rounded">
              <span className="font-bold text-slate-700 text-sm">#{o.id}</span>
              {o.supplier_name && (
                <span className="text-xs font-medium text-slate-700">{o.supplier_name}</span>
              )}
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_CLS[o.status]}`}>
                {t(`inv.ord.st.${o.status}`)}
              </span>
              <span className="text-xs text-slate-500">
                {t("inv.ord.lineCount", { n: o.line_count })} · ฿{o.total_cost.toLocaleString("th-TH", { maximumFractionDigits: 2 })}
              </span>
              <span className="text-[11px] text-slate-400">
                {o.created_by_name ?? t("inv.dash")} · {o.created_at.slice(0, 16).replace("T", " ")}
              </span>
              {canApprove && o.status === "sent" && (
                <span className="text-[11px] text-amber-700 font-medium ml-auto">
                  {t("inv.ord.awaiting")}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
