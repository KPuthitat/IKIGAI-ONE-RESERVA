import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { updateRecurring, setRecurringActive, deleteRecurring, getRecurring } from "@/lib/accounta-db";
import { RecurringBody, toRecurringInput } from "../route";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// PATCH — either a quick { active } toggle, or a full template update.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!getRecurring(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const raw = await req.json().catch(() => ({}));
  const toggle = z.object({ active: z.boolean() }).strict().safeParse(raw);
  if (toggle.success) {
    setRecurringActive(id, toggle.data.active);
    return NextResponse.json({ ok: true });
  }
  const parsed = RecurringBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const ok = updateRecurring(id, toRecurringInput(parsed.data));
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const ok = deleteRecurring(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
