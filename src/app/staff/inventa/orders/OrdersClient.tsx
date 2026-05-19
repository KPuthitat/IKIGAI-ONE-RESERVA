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
  unit_cost: number;
  supplier_name: string | null;
};

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
};

const STATUS_CLS: Record<OrderRow["status"], string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  received: "bg-sky-100 text-sky-700",
  cancelled: "bg-rose-100 text-rose-600"
};

export default function OrdersClient({
  lowStock, orders, canApprove
}: {
  lowStock: LowStockItem[];
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

  const groups = useMemo(() => {
    const m = new Map<string, LowStockItem[]>();
    for (const it of lowStock) {
      const k = it.supplier_name ?? t("inv.ord.noSupplier");
      const arr = m.get(k) ?? [];
      arr.push(it);
      m.set(k, arr);
    }
    return [...m.entries()];
  }, [lowStock, t]);

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
    for (const it of lowStock) all[it.id] = String(suggested(it) || 1);
    setSel(all);
  }

  const chosen = Object.entries(sel)
    .map(([id, q]) => ({ item_id: Number(id), order_qty: Number(q) }))
    .filter((l) => l.order_qty > 0);

  async function submit() {
    if (chosen.length === 0) { setErr(t("inv.ord.selectMin")); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/orders"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || undefined, lines: chosen })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("inv.ord.sendFail")); return; }
      router.push(`/staff/inventa/orders/${j.id}`);
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
          {lowStock.length > 0 && (
            <button type="button" onClick={selectAll}
              className="text-xs text-brand hover:underline">
              {t("inv.ord.selectAll")}
            </button>
          )}
        </div>

        {lowStock.length === 0 && (
          <p className="text-sm text-slate-400">
            {t("inv.ord.noLow")}
          </p>
        )}

        {groups.map(([supplier, items]) => (
          <div key={supplier} className="space-y-1.5">
            <div className="text-[11px] tracking-[1px] text-slate-400 uppercase">
              {supplier}
            </div>
            {items.map((it) => {
              const checked = it.id in sel;
              const bin = binCode(it.grid_row, it.grid_col, it.pick_freq);
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
                        {it.unit ? ` ${it.unit}` : ""} · {t("inv.ord.cost")} ฿{it.unit_cost}
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
                </div>
              );
            })}
          </div>
        ))}

        {lowStock.length > 0 && (
          <div className="border-t border-slate-100 pt-3 space-y-2">
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
