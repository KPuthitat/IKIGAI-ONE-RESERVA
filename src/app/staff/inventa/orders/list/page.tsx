import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { getBranchOrders } from "@/lib/inventa-orders-server";
import OrdersListClient from "./OrdersListClient";

export const dynamic = "force-dynamic";

// /staff/inventa/orders/list — dedicated tracking page for purchase orders
// that have already been created (owner 2026-06-13). Split into "ยังค้าง"
// (pending follow-up) vs "จบแล้ว" (closed) so an open PO never gets lost at
// the bottom of the create workspace. Creating a PO still happens at
// /staff/inventa/orders.
export default function InventaOrdersListPage() {
  const user = requireUser();
  const lang = getLang();
  const branchId = user.activeBranchId ?? null;
  const orders = getBranchOrders(branchId, 200);

  return (
    <div className="space-y-4">
      {/* pl-11 on mobile clears the floating hamburger (owner R-mobile). */}
      <div className="pl-11 md:pl-0">
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "inv.ordList.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "inv.ordList.subtitle")}</p>
      </div>
      <OrdersListClient orders={orders} />
    </div>
  );
}
