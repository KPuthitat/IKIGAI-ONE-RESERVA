import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { setManualOfferConditions } from "@/lib/recruita-offer";

// POST /api/admin/persona/employees/[id]/offer-conditions — { conditions: string }
// HR types (or clears, with an empty string) the conditions of an employee's offer by hand
// (owner 2026-11-10). Separate from the RECRUITA text, which is never edited here.
const Body = z.object({ conditions: z.string().max(2000) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const target = getDb().prepare("SELECT id, status FROM users WHERE id = ?").get(id) as { id: number; status: string } | undefined;
  if (!target || target.status === "disabled") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = setManualOfferConditions(id, user.id, parsed.data.conditions);
  if (!r.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  logPersonaAction(user.id, "employee.offer_conditions", id);
  return NextResponse.json({ ok: true, text: r.text, at: r.at, by: user.display_name ?? null });
}
