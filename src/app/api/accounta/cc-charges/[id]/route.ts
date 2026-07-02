import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { updateCCCharge, deleteCCCharge, getCCCharge } from "@/lib/accounta-db";
import { CCBody, toCCInput } from "@/lib/accounta-validate";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!getCCCharge(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = CCBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const ok = updateCCCharge(id, toCCInput(parsed.data));
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const ok = deleteCCCharge(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
