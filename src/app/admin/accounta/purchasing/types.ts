export type Kind = "opex" | "capex";
export type PrStatus = "draft" | "submitted" | "approved" | "rejected" | "ordered" | "received" | "closed" | "cancelled";
export type Usage = { branchId: number; category: string; kind: Kind; budget: number; actual: number; committed: number; remaining: number };
export type Pr = {
  id: number; prNo: string; branchId: number; branchName: string; kind: Kind; category: string; title: string; reason: string; neededDate: string | null;
  status: PrStatus; vendorId: number | null; vendorName: string; vatRate: number; subtotal: number; vatAmount: number; total: number;
  overBudget: boolean; overBudgetReason: string; requestedBy: number; requestedByName: string; submittedAt: string | null;
  decidedBy: number | null; decidedByName: string | null; decidedAt: string | null; decisionNote: string; createdAt: string; poNo: string | null;
};
export type Item = { lineNo: number; description: string; qty: number; unit: string; unitPrice: number; amount: number };
export type Bill = { expenseId: number; billDate: string; vendorName: string; description: string; amount: number };
export type Po = { poNo: string; vendorName: string; total: number; expectedDate: string | null; note: string; issuedAt: string; receivedAt: string | null; receiveNote: string };
export type Overview = {
  year: number; me: { userId: number; isApprover: boolean; adminBranchIds: number[] };
  branches: Array<{ id: number; name: string }>; vendors: Record<number, Array<{ id: number; name: string }>>;
  categories: Array<{ name: string; kind: Kind }>; usage: Usage[]; prs: Pr[];
};
export type Detail = { pr: Pr; items: Item[]; po: Po | null; bills: Bill[]; linkable: Bill[]; impact: { usage: Usage; afterRemaining: number; over: boolean } };

export const STATUS: Record<PrStatus, { label: string; cls: string }> = {
  draft: { label: "ร่าง", cls: "tag-mute" }, submitted: { label: "รออนุมัติ", cls: "tag-warn" }, approved: { label: "อนุมัติแล้ว", cls: "tag-ok" },
  rejected: { label: "ไม่อนุมัติ", cls: "tag-bad" }, ordered: { label: "สั่งซื้อแล้ว", cls: "tag-info" }, received: { label: "รับของแล้ว", cls: "tag-info" },
  closed: { label: "ปิดแล้ว", cls: "tag-ok" }, cancelled: { label: "ยกเลิก", cls: "tag-mute" }
};
export const KIND_LABEL: Record<Kind, string> = { opex: "OPEX", capex: "CAPEX" };

export async function api<T = Record<string, unknown>>(url: string, init?: { method: string; body: unknown }): Promise<{ ok: boolean; j: T & { message?: string; error?: string } }> {
  const r = await fetch(url, init ? { method: init.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}
