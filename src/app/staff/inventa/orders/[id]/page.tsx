import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import PrintActions from "./PrintActions";
import OrderEditor, { type CatalogItem, type EditorLine } from "./OrderEditor";

export const dynamic = "force-dynamic";

type OrderHead = {
  id: number;
  branch_id: number | null;
  status: "draft" | "sent" | "approved" | "received" | "cancelled";
  note: string | null;
  created_at: string;
  sent_at: string | null;
  approved_at: string | null;
  created_by: number | null;
  created_by_name: string | null;
  approved_by_name: string | null;
};
type Line = {
  id: number;
  item_id: number;
  supplier_id: number | null;
  qty_on_hand: number | null;
  suggested_qty: number | null;
  order_qty: number;
  unit_cost_at_order: number;
  item_name: string;
  item_code: string | null;
  unit: string | null;
  supplier_name: string | null;
};

export default function InventaOrderDetailPage({
  params
}: { params: { id: string } }) {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();
  const id = Number(params.id);
  const stLabel = (s: OrderHead["status"]) => t(lang, `inv.ord.st.${s}`);

  const order = Number.isInteger(id)
    ? (db.prepare(`
        SELECT o.*, cu.display_name AS created_by_name,
               au.display_name AS approved_by_name
        FROM inventa_orders o
        LEFT JOIN users cu ON cu.id = o.created_by
        LEFT JOIN users au ON au.id = o.approved_by
        WHERE o.id = ?
      `).get(id) as OrderHead | undefined)
    : undefined;

  if (!order) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "inv.po.notFound")} — <Link href="/staff/inventa/orders" className="text-brand underline">{t(lang, "inv.po.back")}</Link>
      </div>
    );
  }

  const isSuper = user.role === "super_admin";
  const isAdmin = user.role === "admin" || isSuper;
  if (!isSuper && order.branch_id !== (user.activeBranchId ?? null)) {
    return (
      <div className="card text-sm text-rose-600">
        {t(lang, "inv.po.branchMismatch")} —{" "}
        <Link href="/staff/inventa/orders" className="text-brand underline">{t(lang, "inv.po.back")}</Link>
      </div>
    );
  }

  const lines = db.prepare(`
    SELECT l.*, i.name AS item_name, i.item_code, i.unit,
           s.name AS supplier_name
    FROM inventa_order_lines l
    JOIN inventa_items i ON i.id = l.item_id
    LEFT JOIN inventa_suppliers s ON s.id = l.supplier_id
    WHERE l.order_id = ?
    ORDER BY (s.name IS NULL), s.name COLLATE NOCASE, i.name COLLATE NOCASE
  `).all(id) as Line[];

  // Edit affordances (owner 2026-06-07). A 'sent' (รออนุมัติ) order can
  // have its lines corrected by an admin or the creator — PIN-gated +
  // audited at the API. We only load the branch catalogue (for the
  // "add item" picker) when the order is actually editable.
  const canManage = isAdmin || order.created_by === user.id;
  const editable = canManage && order.status === "sent";
  const editorLines: EditorLine[] = lines.map((l) => ({
    id: l.id,
    item_id: l.item_id,
    item_name: l.item_name,
    item_code: l.item_code,
    unit: l.unit,
    order_qty: l.order_qty,
    unit_cost_at_order: l.unit_cost_at_order
  }));
  const catalog: CatalogItem[] = editable
    ? (db.prepare(`
        SELECT id, name, item_code, unit, cost_price, unit_cost
        FROM inventa_items
        WHERE active = 1 AND (branch_id IS ? OR branch_id = ?)
        ORDER BY name COLLATE NOCASE
      `).all(order.branch_id, order.branch_id) as Array<{
        id: number; name: string; item_code: string | null; unit: string | null;
        cost_price: number | null; unit_cost: number | null;
      }>).map((c) => ({
        id: c.id, name: c.name, item_code: c.item_code, unit: c.unit,
        cost: c.cost_price != null ? c.cost_price : (c.unit_cost ?? 0)
      }))
    : [];

  const branch = order.branch_id
    ? (db.prepare("SELECT name, reg_address, tax_branch_code, company_id, contact_phone FROM branches WHERE id = ?")
        .get(order.branch_id) as {
          name: string; reg_address: string | null;
          tax_branch_code: string | null; company_id: number | null;
          contact_phone: string | null;
        } | undefined)
    : undefined;
  const company = branch?.company_id
    ? (db.prepare("SELECT name_th, tax_id, address, phone FROM companies WHERE id = ?")
        .get(branch.company_id) as {
          name_th: string; tax_id: string | null;
          address: string | null; phone: string | null;
        } | undefined)
    : undefined;

  // Group lines by supplier — each supplier prints as its own PO sheet.
  const bySupplier = new Map<string, Line[]>();
  for (const l of lines) {
    const k = l.supplier_name ?? t(lang, "inv.ord.noSupplier");
    const arr = bySupplier.get(k) ?? [];
    arr.push(l);
    bySupplier.set(k, arr);
  }
  const supplierGroups = [...bySupplier.entries()];
  const grandTotal = lines.reduce((s, l) => s + l.order_qty * l.unit_cost_at_order, 0);
  const buyerName = company?.name_th ?? branch?.name ?? t(lang, "inv.dash");
  const buyerAddr = branch?.reg_address || company?.address || "";

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2 pl-11 md:pl-0">
        <Link href="/staff/inventa/orders" className="text-sm text-brand hover:underline">
          {t(lang, "inv.po.backList")}
        </Link>
        <span className="text-sm text-slate-400">·</span>
        <span className="font-bold text-slate-800">{t(lang, "inv.po.title", { id: order.id })}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
          {stLabel(order.status)}
        </span>
        <span className="flex-1" />
        <PrintActions
          orderId={order.id}
          status={order.status}
          canApprove={isAdmin}
          canManage={canManage}
        />
      </div>

      {/* Inline line editor for a 'sent' order (owner 2026-06-07) —
          collapsed to a single "แก้ไขรายการ" button until opened. */}
      {editable && (
        <OrderEditor
          orderId={order.id}
          editable={editable}
          lines={editorLines}
          catalog={catalog}
        />
      )}

      {/* On-screen summary (owner 2026-06-06). The authoritative supplier
          document is the A4 PDF (เปิด/ดาวน์โหลด PDF above) — this view is
          for quick review + approval. Tables scroll horizontally on
          mobile (overflow-x-auto) so nothing runs off the screen. */}
      <div className="card space-y-4">
        <div className="flex justify-between gap-4 flex-wrap">
          <div>
            <div className="text-lg font-bold text-slate-800">{t(lang, "inv.po.docTitle")} #{order.id}</div>
            <div className="text-xs text-slate-500 mt-1">
              {t(lang, "inv.po.date")} {order.created_at.slice(0, 10)} · {t(lang, "inv.po.status")} {stLabel(order.status)}
            </div>
          </div>
          <div className="text-right text-xs text-slate-600">
            <div className="font-bold text-slate-800">{buyerName}</div>
            {buyerAddr && <div className="max-w-[260px] ml-auto">{buyerAddr}</div>}
            {company?.tax_id && <div>{t(lang, "inv.po.taxId")} {company.tax_id}
              {branch?.tax_branch_code ? ` (${t(lang, "inv.po.branchCode")} ${branch.tax_branch_code})` : ""}</div>}
            {(branch?.contact_phone || company?.phone) &&
              <div>{t(lang, "inv.po.tel")} {branch?.contact_phone || company?.phone}</div>}
          </div>
        </div>

        {supplierGroups.map(([supplier, rows]) => {
          const subtotal = rows.reduce((s, l) => s + l.order_qty * l.unit_cost_at_order, 0);
          return (
            <div key={supplier} className="space-y-2">
              <div className="text-sm">
                <span className="text-slate-500">{t(lang, "inv.po.supplierLabel")} </span>
                <span className="font-bold text-slate-800">{supplier}</span>
              </div>
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-sm border-collapse min-w-[640px]">
                  <thead>
                    <tr className="border-y border-slate-300 text-left text-xs text-slate-600">
                      <th className="py-2 pr-2 w-8">#</th>
                      <th className="py-2 pr-2">{t(lang, "inv.po.colItem")}</th>
                      <th className="py-2 pr-2">{t(lang, "inv.po.colCode")}</th>
                      <th className="py-2 pr-2 text-right">{t(lang, "inv.po.colOnhand")}</th>
                      <th className="py-2 pr-2 text-right">{t(lang, "inv.po.colOrder")}</th>
                      <th className="py-2 pr-2">{t(lang, "inv.po.colUnit")}</th>
                      <th className="py-2 pr-2 text-right">{t(lang, "inv.po.colCost")}</th>
                      <th className="py-2 pl-2 text-right">{t(lang, "inv.po.colTotal")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((l, i) => (
                      <tr key={l.id} className="border-b border-slate-100 align-top">
                        <td className="py-1.5 pr-2 text-slate-400">{i + 1}</td>
                        <td className="py-1.5 pr-2 font-medium text-slate-800">{l.item_name}</td>
                        <td className="py-1.5 pr-2 text-slate-500 whitespace-nowrap">{l.item_code ?? t(lang, "inv.dash")}</td>
                        <td className="py-1.5 pr-2 text-right text-slate-500">{l.qty_on_hand ?? t(lang, "inv.dash")}</td>
                        <td className="py-1.5 pr-2 text-right font-bold">{l.order_qty}</td>
                        <td className="py-1.5 pr-2 text-slate-500">{l.unit ?? t(lang, "inv.dash")}</td>
                        <td className="py-1.5 pr-2 text-right text-slate-500">
                          ฿{l.unit_cost_at_order.toLocaleString("th-TH", { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-1.5 pl-2 text-right">
                          ฿{(l.order_qty * l.unit_cost_at_order).toLocaleString("th-TH", { maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-300 font-bold">
                      <td colSpan={7} className="py-2 text-right">{t(lang, "inv.po.subtotal")}</td>
                      <td className="py-2 pl-2 text-right">
                        ฿{subtotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          );
        })}

        {order.note && (
          <div className="text-xs text-slate-600">
            <span className="text-slate-400">{t(lang, "inv.po.note")} </span>{order.note}
          </div>
        )}

        {supplierGroups.length > 1 && (
          <div className="text-right text-sm font-bold text-slate-800 border-t border-slate-200 pt-2">
            {t(lang, "inv.po.grand")} ฿{grandTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })}
          </div>
        )}

        <p className="text-[11px] text-slate-400">
          เอกสารสำหรับส่งผู้จำหน่าย (A4) — กดปุ่ม “เปิด / ดาวน์โหลด PDF” ด้านบน
        </p>
      </div>
    </div>
  );
}
