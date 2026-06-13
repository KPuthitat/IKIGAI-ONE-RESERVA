"use client";

import Link from "next/link";
import { useLang } from "@/lib/LangProvider";
import { type OrderRow, STATUS_CLS, isPendingOrder } from "@/lib/inventa-orders";
import { formatBkkDateTime } from "@/lib/time";

function fmtBaht(n: number): string {
  return "฿" + n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function OrderCard({ o, highlight }: { o: OrderRow; highlight: boolean }) {
  const { t } = useLang();
  return (
    <Link
      href={`/staff/inventa/orders/${o.id}`}
      className={`block rounded-xl border p-3 transition hover:shadow-sm ${
        highlight
          ? "border-amber-300 bg-amber-50/40 hover:bg-amber-50"
          : "border-slate-200 bg-white hover:bg-slate-50"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-bold text-slate-800">#{o.id}</span>
        {o.supplier_name && (
          <span className="text-sm font-medium text-slate-700">{o.supplier_name}</span>
        )}
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_CLS[o.status]}`}>
          {t(`inv.ord.st.${o.status}`)}
        </span>
        <span className="ml-auto text-sm font-semibold text-slate-700">{fmtBaht(o.total_cost)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
        <span>{t("inv.ord.lineCount", { n: o.line_count })}</span>
        <span>{o.created_by_name ?? t("inv.dash")}</span>
        <span>{formatBkkDateTime(o.created_at)}</span>
      </div>
    </Link>
  );
}

export default function OrdersListClient({ orders }: { orders: OrderRow[] }) {
  const { t } = useLang();
  const pending = orders.filter((o) => isPendingOrder(o.status));
  const done = orders.filter((o) => !isPendingOrder(o.status));

  return (
    <div className="space-y-4">
      {/* Summary banner — the eye-catcher so open POs aren't forgotten. */}
      <div
        className={`card flex items-center gap-3 ${
          pending.length > 0
            ? "border-amber-300 bg-amber-50"
            : "border-emerald-200 bg-emerald-50"
        }`}
      >
        <span className="text-3xl font-bold tabular-nums text-slate-800">{pending.length}</span>
        <div className="text-sm">
          <div className="font-bold text-slate-800">
            {pending.length > 0 ? t("inv.ordList.summaryPending") : t("inv.ordList.summaryClear")}
          </div>
          <div className="text-xs text-slate-500">
            {t("inv.ordList.summaryTotal", { n: orders.length })}
          </div>
        </div>
      </div>

      {orders.length === 0 && (
        <div className="card text-sm text-slate-400">{t("inv.ordList.allEmpty")}</div>
      )}

      {/* ── Pending (ยังค้าง) ───────────────────────────────────── */}
      {pending.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-amber-700">
            {t("inv.ordList.pending", { n: pending.length })}
          </h2>
          <div className="space-y-2">
            {pending.map((o) => (
              <OrderCard key={o.id} o={o} highlight />
            ))}
          </div>
        </div>
      )}

      {/* ── Done (จบแล้ว) ──────────────────────────────────────── */}
      {done.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-slate-500">
            {t("inv.ordList.done", { n: done.length })}
          </h2>
          <div className="space-y-2">
            {done.map((o) => (
              <OrderCard key={o.id} o={o} highlight={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
