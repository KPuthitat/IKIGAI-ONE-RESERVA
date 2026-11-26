// Gate and request shapes for the memo routes (Next route files may only export handlers).
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, type SessionUser } from "./auth";
import { getDb } from "./db";
import { MEMO_ERROR_TH, MemoError } from "./memos";
import { viewerOf, type Viewer } from "./purchasing";

/** Admins, super admins and executives (C-level) — the people who write memos or are asked to sign them. */
export function memoGate(): { user: SessionUser; viewer: Viewer } | { error: NextResponse } {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  const viewer = viewerOf(user);
  if (user.role === "staff" && !viewer.isCLevel) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user, viewer };
}

export function memoBranches(viewer: Viewer): Array<{ id: number; name: string }> {
  const db = getDb();
  if (viewer.role === "super_admin" || viewer.isCLevel) return db.prepare("SELECT id, name FROM branches ORDER BY display_order, name").all() as Array<{ id: number; name: string }>;
  if (!viewer.adminBranchIds.length) return [];
  return db.prepare(`SELECT id, name FROM branches WHERE id IN (${viewer.adminBranchIds.map(() => "?").join(",")}) ORDER BY display_order, name`).all(...viewer.adminBranchIds) as Array<{ id: number; name: string }>;
}

const Item = z.object({ description: z.string().max(200), qty: z.number().positive().max(1_000_000), unit: z.string().max(20).optional(), unit_price: z.number().min(0).max(100_000_000) });
export const MemoBody = z.object({
  id: z.number().int().positive().optional(),
  branch_id: z.number().int().positive(), subject: z.string().min(1).max(200), body: z.string().max(4000).optional(), category: z.string().min(1).max(200),
  needed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), vendor_id: z.number().int().positive().nullable().optional(), vendor_name: z.string().max(200).optional(),
  vat_rate: z.number().optional(), items: z.array(Item).min(1).max(100), signer_ids: z.array(z.number().int().positive()).max(20)
});
export const Body = z.object({
  action: z.enum(["save", "submit", "reopen", "cancel", "sign", "reject", "open_pr"]),
  memo: MemoBody.optional(), id: z.number().int().positive().optional(), pin: z.string().max(10).optional(), reason: z.string().max(1000).optional(), over_budget_reason: z.string().max(1000).optional()
});

export function memoError(e: unknown) {
  if (e instanceof MemoError) {
    const status = e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "bad_status" || e.code === "already_signed" ? 409 : e.code === "wrong_pin" || e.code === "no_pin" ? 401 : 400;
    return NextResponse.json({ error: e.code, detail: e.detail, message: MEMO_ERROR_TH[e.code] }, { status });
  }
  throw e;
}
