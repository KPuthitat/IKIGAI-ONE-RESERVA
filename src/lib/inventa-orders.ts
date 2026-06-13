// Shared presentation helpers for INVENTA purchase orders, used by both the
// create workspace (OrdersClient) and the dedicated tracking page
// (orders/list/OrdersListClient). Kept here so the status colours and the
// "pending vs done" split live in one place instead of being duplicated.

export type OrderStatus =
  | "draft"
  | "sent"
  | "approved"
  | "paid"
  | "shipping"
  | "received"
  | "returned"
  | "cancelled";

export type OrderRow = {
  id: number;
  status: OrderStatus;
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

export const STATUS_CLS: Record<OrderStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  paid: "bg-teal-100 text-teal-700",
  shipping: "bg-sky-100 text-sky-700",
  received: "bg-green-100 text-green-700",
  returned: "bg-orange-100 text-orange-700",
  cancelled: "bg-rose-100 text-rose-600"
};

// "Pending" = created but not yet closed out, so it still needs follow-up
// (approve / pay / receive). Everything else is a finished order. The owner
// wants these two groups split so an open PO never gets forgotten.
export const PENDING_STATUSES: readonly OrderStatus[] = [
  "draft",
  "sent",
  "approved",
  "paid",
  "shipping"
];

export function isPendingOrder(status: OrderStatus): boolean {
  return PENDING_STATUSES.includes(status);
}
