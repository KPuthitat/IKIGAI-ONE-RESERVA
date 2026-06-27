import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listVendorsManage, createVendor, updateVendor, deleteVendor } from "@/lib/accounta-db";

// GET    /api/accounta/vendors      — branch vendor master (manage page)
// POST   /api/accounta/vendors      — add (de-duped on name)
// PATCH  /api/accounta/vendors      — edit one (rename / tax id / category)
// DELETE /api/accounta/vendors?id=  — remove one

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  tax_id: z.string().trim().max(30).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional()
});
const PatchBody = Body.extend({ id: z.number().int().positive() });

export async function GET() {
  const user = requirePermission("accounta.manage");
  return NextResponse.json({ ok: true, vendors: listVendorsManage(user.activeBranchId ?? null) });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  if (user.activeBranchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const id = createVendor(user.activeBranchId, user.id, parsed.data);
  return NextResponse.json({ ok: true, id, vendors: listVendorsManage(user.activeBranchId) });
}

export async function PATCH(req: Request) {
  const user = requirePermission("accounta.manage");
  if (user.activeBranchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { id, ...rest } = parsed.data;
  const ok = updateVendor(id, user.activeBranchId, rest);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, vendors: listVendorsManage(user.activeBranchId) });
}

export async function DELETE(req: Request) {
  const user = requirePermission("accounta.manage");
  if (user.activeBranchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!deleteVendor(id, user.activeBranchId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, vendors: listVendorsManage(user.activeBranchId) });
}
