import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import OrdersClient, { type LowStockItem } from "./OrdersClient";
import { getBranchOrders } from "@/lib/inventa-orders-server";

export const dynamic = "force-dynamic";

// /staff/inventa/orders — INVENTA Phase 3 reorder workspace.
//   • "รายการที่ควรสั่ง" — items at/below safety stock, grouped by
//     supplier, with a suggested order qty staff can adjust.
//   • Submitting creates a purchase order (status='sent') and pings
//     the branch LINE group for management approval.
//   • "ใบสั่งซื้อล่าสุด" — recent orders with status; open one to
//     approve / print the supplier PO.
export default function InventaOrdersPage() {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();
  const branchId = user.activeBranchId ?? null;

  // Low-stock items, EXCLUDING anything already sitting on an open PO
  // (status sent/approved). Owner 2026-06-06: a vendor's items that were
  // just ordered shouldn't keep appearing in "should order" — that's how
  // the same item gets ordered twice. Once the PO is received/cancelled
  // the item is eligible again. Staff can still re-add it manually if
  // they really need more before the PO arrives.
  const lowStock = db.prepare(`
    SELECT i.id, i.name, i.item_code, i.unit,
           i.grid_row, i.grid_col, i.pick_freq,
           i.current_qty, i.safety_stock,
           i.unit_cost, i.cost_price, i.pack_unit, i.pack_size,
           s.name AS supplier_name
    FROM inventa_items i
    LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.active = 1
      AND (i.branch_id IS ? OR i.branch_id = ?)
      AND i.current_qty <= i.safety_stock
      AND NOT EXISTS (
        SELECT 1 FROM inventa_order_lines ol
        JOIN inventa_orders o ON o.id = ol.order_id
        WHERE ol.item_id = i.id
          AND o.status IN ('sent', 'approved', 'paid', 'shipping')
          AND (o.branch_id IS ? OR o.branch_id = ?)
      )
    ORDER BY (s.name IS NULL), s.name COLLATE NOCASE, i.name COLLATE NOCASE
  `).all(branchId, branchId, branchId, branchId) as LowStockItem[];

  // Full active catalogue (same shape) so staff can ADD items that
  // aren't low-stock into the same PO (owner 2026-06-06). Clinic
  // inventories are small, so passing the whole list and filtering
  // client-side keeps the UX instant without a search round-trip.
  const catalog = db.prepare(`
    SELECT i.id, i.name, i.item_code, i.unit,
           i.grid_row, i.grid_col, i.pick_freq,
           i.current_qty, i.safety_stock,
           i.unit_cost, i.cost_price, i.pack_unit, i.pack_size,
           s.name AS supplier_name
    FROM inventa_items i
    LEFT JOIN inventa_suppliers s ON s.id = i.supplier_id
    WHERE i.active = 1
      AND (i.branch_id IS ? OR i.branch_id = ?)
    ORDER BY (s.name IS NULL), s.name COLLATE NOCASE, i.name COLLATE NOCASE
    LIMIT 2000
  `).all(branchId, branchId) as LowStockItem[];

  const orders = getBranchOrders(branchId, 50);

  return (
    <div className="space-y-4">
      {/* pl-11 on mobile clears the floating hamburger (owner R-mobile). */}
      <div className="pl-11 md:pl-0">
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "inv.orders.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "inv.orders.subtitle")}</p>
      </div>
      <OrdersClient
        lowStock={lowStock}
        catalog={catalog}
        orders={orders}
      />
    </div>
  );
}
