"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import PinPromptModal from "@/app/components/PinPromptModal";

export type EditorLine = {
  id: number;
  item_id: number;
  item_name: string;
  item_code: string | null;
  unit: string | null;
  order_qty: number;
  unit_cost_at_order: number;
};

export type CatalogItem = {
  id: number;
  name: string;
  item_code: string | null;
  unit: string | null;
  cost: number;
};

type Row = {
  key: string;
  lineId?: number;        // present = existing line
  item_id: number;
  name: string;
  code: string | null;
  unit: string | null;
  cost: number;
  origQty: number;        // 0 for new rows
  qty: string;
  isNew: boolean;
  removed: boolean;
};

// Inline editor for a 'sent' purchase order (owner 2026-06-07). Lets an
// admin/creator change quantities, remove lines, or add catalogue items
// when e.g. a supplier is out of stock, then save behind a PIN. The
// server records who edited + a before/after snapshot.
export default function OrderEditor({
  orderId, editable, lines, catalog
}: {
  orderId: number;
  editable: boolean;
  lines: EditorLine[];
  catalog: CatalogItem[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);

  function start() {
    setRows(lines.map((l, i) => ({
      key: `L${l.id}`,
      lineId: l.id,
      item_id: l.item_id,
      name: l.item_name,
      code: l.item_code,
      unit: l.unit,
      cost: l.unit_cost_at_order,
      origQty: l.order_qty,
      qty: String(l.order_qty),
      isNew: false,
      removed: false
    })));
    setSearch("");
    setErr(null);
    setOpen(true);
  }

  function cancel() {
    setOpen(false);
    setRows([]);
    setErr(null);
  }

  function setQty(key: string, v: string) {
    const clean = v.replace(/[^\d]/g, "");
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, qty: clean } : r)));
    setErr(null);
  }

  function toggleRemove(key: string) {
    setRows((rs) => rs.flatMap((r) => {
      if (r.key !== key) return [r];
      // New rows just drop; existing rows toggle the removed flag.
      if (r.isNew) return [];
      return [{ ...r, removed: !r.removed }];
    }));
    setErr(null);
  }

  function addItem(it: CatalogItem) {
    setRows((rs) => [...rs, {
      key: `N${it.id}-${rs.length}`,
      item_id: it.id,
      name: it.name,
      code: it.item_code,
      unit: it.unit,
      cost: it.cost,
      origQty: 0,
      qty: "1",
      isNew: true,
      removed: false
    }]);
    setSearch("");
    setErr(null);
  }

  // Items not already present (counting only non-removed rows) that match
  // the search box — capped so the dropdown stays light.
  const presentIds = useMemo(
    () => new Set(rows.filter((r) => !r.removed).map((r) => r.item_id)),
    [rows]
  );
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return catalog
      .filter((c) => !presentIds.has(c.id))
      .filter((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.item_code ?? "").toLowerCase().includes(q))
      .slice(0, 20);
  }, [search, catalog, presentIds]);

  const total = rows
    .filter((r) => !r.removed)
    .reduce((s, r) => s + (Number(r.qty) || 0) * r.cost, 0);

  function buildPayload() {
    const updates: Array<{ id: number; order_qty: number }> = [];
    const deletes: number[] = [];
    const adds: Array<{ item_id: number; order_qty: number }> = [];
    for (const r of rows) {
      const qn = Number(r.qty);
      if (r.removed && r.lineId) { deletes.push(r.lineId); continue; }
      if (r.removed) continue;
      if (!Number.isInteger(qn) || qn < 1) return { error: "qty" as const };
      if (r.isNew) adds.push({ item_id: r.item_id, order_qty: qn });
      else if (r.lineId && qn !== r.origQty) updates.push({ id: r.lineId, order_qty: qn });
    }
    return { updates, deletes, adds };
  }

  function trySave() {
    const p = buildPayload();
    if ("error" in p) { setErr(t("inv.po.editQtyErr")); return; }
    const remaining = rows.filter((r) => !r.removed).length;
    if (remaining < 1) { setErr(t("inv.po.editEmpty")); return; }
    if (!p.updates.length && !p.deletes.length && !p.adds.length) {
      setErr(t("inv.po.editNoChange")); return;
    }
    setShowPin(true);
  }

  async function save(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const p = buildPayload();
    if ("error" in p) return { ok: false, message: t("inv.po.editQtyErr") };
    const res = await fetch(apiUrl(`/api/inventa/orders/${orderId}/edit`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, ...p })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) return { ok: false, message: j.error ?? t("inv.po.editFail") };
    setShowPin(false);
    setOpen(false);
    setRows([]);
    router.refresh();
    return { ok: true };
  }

  if (!editable) return null;

  if (!open) {
    return (
      <button type="button" onClick={start}
        className="no-print text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-bold hover:bg-slate-50">
        {t("inv.po.editItems")}
      </button>
    );
  }

  const fmt = (n: number) => "฿" + n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

  return (
    <div className="no-print card border-2 border-amber-300 bg-amber-50/40 space-y-3">
      <div>
        <div className="font-bold text-slate-800">{t("inv.po.editTitle")} #{orderId}</div>
        <div className="text-xs text-slate-500 mt-0.5">{t("inv.po.editHint")}</div>
      </div>

      <div className="space-y-1.5">
        {rows.map((r) => {
          const qn = Number(r.qty) || 0;
          return (
            <div key={r.key}
              className={`flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 ${
                r.removed ? "border-rose-200 bg-rose-50/60 opacity-70"
                : r.isNew ? "border-emerald-200 bg-emerald-50/60"
                : "border-slate-200 bg-white"}`}>
              <div className={`flex-1 min-w-[160px] text-sm ${r.removed ? "line-through text-slate-400" : "text-slate-800"}`}>
                <span className="font-medium">{r.name}</span>
                {r.code && <span className="ml-1 text-[11px] text-slate-400 whitespace-nowrap">[{r.code}]</span>}
                {r.isNew && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-600 text-white">{t("inv.po.editNew")}</span>}
                <span className="block text-[11px] text-slate-500">{fmt(r.cost)} / {r.unit ?? "—"}</span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  className="input !w-20 !py-1 text-sm text-right"
                  inputMode="numeric"
                  value={r.qty}
                  disabled={r.removed}
                  onChange={(e) => setQty(r.key, e.target.value)}
                />
                <span className="text-[11px] text-slate-500 inline-block w-12 text-left">{r.unit ?? ""}</span>
              </div>
              <div className="w-20 text-right text-xs text-slate-600 tabular-nums">
                {r.removed ? "—" : fmt(qn * r.cost)}
              </div>
              <button type="button" onClick={() => toggleRemove(r.key)}
                className={`text-xs px-2 py-1 rounded-md border ${
                  r.removed ? "border-slate-300 text-slate-600 hover:bg-slate-50"
                  : "border-rose-300 text-rose-600 hover:bg-rose-50"}`}>
                {r.removed ? t("inv.po.editUndo") : t("inv.po.editRemove")}
              </button>
            </div>
          );
        })}
      </div>

      {/* Add catalogue item */}
      <div className="relative">
        <input className="input w-full text-sm" value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("inv.po.editAddPh")} />
        {search.trim() && (
          <div className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {matches.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400">{t("inv.po.editNoMatch")}</div>
            ) : matches.map((c) => (
              <button key={c.id} type="button" onClick={() => addItem(c)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-amber-50 border-b border-slate-100 last:border-b-0">
                <span className="font-medium text-slate-800">{c.name}</span>
                {c.item_code && <span className="ml-1 text-[11px] text-slate-400">[{c.item_code}]</span>}
                <span className="block text-[11px] text-slate-500">{fmt(c.cost)} / {c.unit ?? "—"}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <p className="text-xs text-rose-600 font-medium">{err}</p>}

      <div className="flex items-center justify-between gap-2 border-t border-amber-200 pt-2">
        <div className="text-sm font-bold text-slate-800">{t("inv.po.colTotal")} {fmt(total)}</div>
        <div className="flex gap-2">
          <button type="button" onClick={cancel}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            {t("inv.po.editCancel")}
          </button>
          <button type="button" onClick={trySave}
            className="text-xs px-3 py-1.5 rounded-full bg-emerald-600 text-white font-bold hover:opacity-90">
            {t("inv.po.editSave")}
          </button>
        </div>
      </div>

      {showPin && (
        <PinPromptModal
          title={t("inv.po.editPinTitle")}
          description={t("inv.po.editPinHint")}
          submitLabel={t("inv.po.editSave")}
          onSubmit={save}
          onClose={() => setShowPin(false)}
        />
      )}
    </div>
  );
}
