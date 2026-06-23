import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import {
  isRevshareBranch, listRounds, createRound, updateRound, deleteRound, generateAutoRounds
} from "@/lib/revshare-db";

// Sales rounds for a partner+month. GET list; POST create|auto-generate;
// PATCH edit; DELETE remove. Mutations that record a daily sales row are
// PIN-gated (owner 2026-06-23 — บันทึกผู้ทำรายการ): the caller's own 4-digit
// PIN proves presence and the operator is stamped via created_by/updated_by.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PostZ = z.union([
  z.object({ partner: z.number().int().positive(), action: z.literal("auto"), year: z.number().int(), month: z.number().int().min(1).max(12) }),
  z.object({
    partner: z.number().int().positive(),
    period_start: z.string().regex(ISO), period_end: z.string().regex(ISO),
    sales_amount: z.number().min(0),
    source: z.enum(["manual", "pos_import"]).optional(),
    source_filename: z.string().max(200).optional(),
    label: z.string().max(60).optional(),
    pin: z.string()
  })
]);
const PatchZ = z.object({
  id: z.number().int().positive(), partner: z.number().int().positive(),
  sales_amount: z.number().min(0).optional(),
  period_start: z.string().regex(ISO).optional(), period_end: z.string().regex(ISO).optional(),
  pin: z.string()
});

/** Gate a mutating action behind the caller's own PIN. Returns null on success,
 *  or a ready-to-return error response. */
function pinGate(userId: number, pin: string): NextResponse | null {
  const status = verifyAdminPin(userId, pin);
  if (status.ok) return null;
  const code = status.reason === "no_pin" ? 400 : 403;
  return NextResponse.json({ error: status.reason }, { status: code });
}

function ctx() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isRevshareBranch(branchId) };
}

export function GET(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const partner = Number(sp.get("partner")), year = Number(sp.get("year")), month = Number(sp.get("month"));
  if (![partner, year, month].every(Number.isInteger)) return NextResponse.json({ error: "bad_params" }, { status: 400 });
  return NextResponse.json({ ok: true, rounds: listRounds(partner, branchId!, year, month) });
}

export async function POST(req: Request) {
  const { user, branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const parsed = PostZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  if ("action" in d) {
    const made = generateAutoRounds(d.partner, branchId!, d.year, d.month, user.id);
    return NextResponse.json({ ok: true, made, rounds: listRounds(d.partner, branchId!, d.year, d.month) });
  }
  const gate = pinGate(user.id, d.pin); if (gate) return gate;
  const id = createRound(d.partner, branchId!, d, user.id);
  if (!id) return NextResponse.json({ error: "create_failed" }, { status: 400 });
  const [y, m] = d.period_start.split("-").map(Number);
  return NextResponse.json({ ok: true, id, rounds: listRounds(d.partner, branchId!, y, m) });
}

export async function PATCH(req: Request) {
  const { user, branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const parsed = PatchZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { id, partner, pin, ...d } = parsed.data;
  const gate = pinGate(user.id, pin); if (gate) return gate;
  if (!updateRound(id, partner, branchId!, d, user.id)) return NextResponse.json({ error: "update_failed" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export function DELETE(req: Request) {
  const { user, branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const id = Number(sp.get("id")), partner = Number(sp.get("partner"));
  const pin = sp.get("pin") ?? "";
  if (![id, partner].every(Number.isInteger)) return NextResponse.json({ error: "bad_params" }, { status: 400 });
  const gate = pinGate(user.id, pin); if (gate) return gate;
  if (!deleteRound(id, partner, branchId!)) return NextResponse.json({ error: "delete_failed" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
