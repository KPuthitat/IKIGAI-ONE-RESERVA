// Shared helpers for the purchasing (PR/PO + budget) admin route (Next route files may only export handlers).
import { NextResponse } from "next/server";
import { z } from "zod";
import { canModule, getSessionUser, type SessionUser } from "./auth";
import { getDb } from "./db";
import { isApprover, PurchasingError, PURCHASING_ERROR_TH, viewerOf, type Viewer } from "./purchasing";

/** Branch admins with ACCOUNTA access, and every approver (C-level / super_admin) even without the module. */
export function purchasingGate(): { user: SessionUser; viewer: Viewer } | { error: NextResponse } {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  const viewer = viewerOf(user);
  if (!canModule(user, "accounta.manage") && !isApprover(viewer)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user, viewer };
}

/** The branches this viewer works with: approvers see the company's branches, an admin only their own. */
export function visibleBranches(user: SessionUser, viewer: Viewer): Array<{ id: number; name: string }> {
  const db = getDb();
  if (isApprover(viewer)) return db.prepare("SELECT id, name FROM branches ORDER BY display_order, name").all() as Array<{ id: number; name: string }>;
  if (viewer.adminBranchIds.length === 0) return [];
  return db.prepare(`SELECT id, name FROM branches WHERE id IN (${viewer.adminBranchIds.map(() => "?").join(",")}) ORDER BY display_order, name`).all(...viewer.adminBranchIds) as Array<{ id: number; name: string }>;
}

const Item = z.object({ description: z.string().max(200), qty: z.number().positive().max(1_000_000), unit: z.string().max(20).optional(), unit_price: z.number().min(0).max(100_000_000) });
export const PrBody = z.object({
  id: z.number().int().positive().optional(),
  branch_id: z.number().int().positive(), category: z.string().min(1).max(200), title: z.string().min(1).max(200),
  reason: z.string().max(2000).optional(), needed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  vendor_id: z.number().int().positive().nullable().optional(), vendor_name: z.string().max(200).optional(),
  vat_rate: z.number().optional(), over_budget_reason: z.string().max(1000).optional(), items: z.array(Item).min(1).max(100)
});

export const Body = z.object({
  action: z.enum(["save_pr", "submit", "decide", "reopen", "cancel", "issue_po", "receive", "link_bills", "unlink_bill", "set_budget"]),
  pr: PrBody.optional(),
  id: z.number().int().positive().optional(),
  approve: z.boolean().optional(), note: z.string().max(1000).optional(), pin: z.string().optional(),
  expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), vendor_name: z.string().max(200).optional(),
  expense_ids: z.array(z.number().int().positive()).max(50).optional(), expense_id: z.number().int().positive().optional(),
  year: z.number().int().min(2000).max(2100).optional(), budget: z.array(z.object({ branch_id: z.number().int().positive(), category: z.string(), amount: z.number().min(0).max(1_000_000_000) })).max(300).optional()
});

export function purchasingError(e: unknown) {
  if (e instanceof PurchasingError) {
    const status = e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "bad_status" ? 409 : 400;
    return NextResponse.json({ error: e.code, message: PURCHASING_ERROR_TH[e.code] }, { status });
  }
  throw e;
}
