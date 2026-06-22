import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  isRevshareBranch, listPartners, getPartner, getTiers, getFloors,
  createPartner, updatePartner, replaceTiers, replaceFloors
} from "@/lib/revshare-db";

// Revenue-Share partners — scoped to the admin's active branch (which must have
// revshare_enabled). GET list / ?id full; POST create; PATCH fields|tiers|floors.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const baseEnum = z.enum(["gross", "after_discount", "nett"]);
const TierZ = z.object({ lower: z.number().min(0), upper: z.number().positive().nullable(), rate: z.number().min(0).max(1) });
const FloorZ = z.object({ monthFrom: z.number().int().positive(), monthTo: z.number().int().positive(), amount: z.number().min(0) });

const CreateZ = z.object({
  name: z.string().trim().min(1).max(120),
  venue: z.string().trim().max(120).optional(),
  start_date: z.string().regex(ISO),
  sales_base: baseEnum.optional(),
  pos_categories: z.array(z.string()).optional(),
  vat_enabled: z.boolean().optional(),
  vat_rate: z.number().min(0).max(1).optional(),
  wht_rate: z.number().min(0).max(1).optional(),
  note: z.string().trim().max(500).optional()
});
const PatchZ = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  venue: z.string().trim().max(120).nullable().optional(),
  start_date: z.string().regex(ISO).optional(),
  sales_base: baseEnum.optional(),
  pos_categories: z.array(z.string()).optional(),
  vat_enabled: z.boolean().optional(),
  vat_rate: z.number().min(0).max(1).optional(),
  wht_rate: z.number().min(0).max(1).optional(),
  active: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  tiers: z.array(TierZ).optional(),
  floors: z.array(FloorZ).optional()
});

function ctx() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isRevshareBranch(branchId) };
}

export function GET(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (Number.isInteger(id) && id > 0) {
    const partner = getPartner(id, branchId!);
    if (!partner) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, partner, tiers: getTiers(id), floors: getFloors(id) });
  }
  return NextResponse.json({ ok: true, partners: listPartners(branchId!) });
}

export async function POST(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const parsed = CreateZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const id = createPartner(branchId!, parsed.data);
  if (!id) return NextResponse.json({ error: "create_failed" }, { status: 400 });
  return NextResponse.json({ ok: true, id, partners: listPartners(branchId!) });
}

export async function PATCH(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const parsed = PatchZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { id, tiers, floors, ...fields } = parsed.data;
  if (tiers) {
    if (!replaceTiers(id, branchId!, tiers.map((t) => ({ lower: t.lower, upper: t.upper, rate: t.rate }))))
      return NextResponse.json({ error: "tiers_failed" }, { status: 400 });
  }
  if (floors) {
    if (!replaceFloors(id, branchId!, floors.map((f) => ({ monthFrom: f.monthFrom, monthTo: f.monthTo, amount: f.amount }))))
      return NextResponse.json({ error: "floors_failed" }, { status: 400 });
  }
  if (Object.keys(fields).length > 0) updatePartner(id, branchId!, fields);
  return NextResponse.json({ ok: true, partner: getPartner(id, branchId!), tiers: getTiers(id), floors: getFloors(id) });
}
