import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { canModule } from "@/lib/auth";
import { cancelTransfer, fundSummary, FundingError, listTransfers, markTransferred } from "@/lib/funding";

// Transfers between company accounts (finance): GET → awaiting + history + fund balances; POST {action: record | cancel}.
export const dynamic = "force-dynamic";
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("record"), id: z.number().int().positive(), transferredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), actualAmount: z.number().positive().max(1_000_000_000).nullable().optional(), note: z.string().max(300).optional(), pin: z.string().max(10) }),
  z.object({ action: z.literal("cancel"), id: z.number().int().positive() })
]);
const gate = () => { const u = getSessionUser(); if (!u) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) }; if (!canModule(u, "accounta.manage")) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) }; return { user: u }; };

export async function GET() {
  const g = gate(); if ("error" in g) return g.error;
  const rows = listTransfers();
  const toIds = [...new Set(rows.filter((r) => r.status !== "cancelled").map((r) => r.toAccountId))];
  const names = new Map((getDb().prepare("SELECT id, name FROM accounta_cash_accounts").all() as Array<{ id: number; name: string }>).map((a) => [a.id, a.name]));
  return NextResponse.json({ ok: true, awaiting: rows.filter((r) => r.status === "awaiting").reverse(), history: rows.filter((r) => r.status !== "awaiting"), funds: toIds.map((id) => ({ accountId: id, name: names.get(id) ?? "", ...fundSummary(id) })) });
}
export async function POST(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  try {
    if (p.data.action === "record") markTransferred(p.data.id, { transferredOn: p.data.transferredOn, actualAmount: p.data.actualAmount ?? null, note: p.data.note }, g.user.id, p.data.pin);
    else cancelTransfer(p.data.id, g.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof FundingError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === "bad_pin" || e.code === "no_pin" ? 401 : e.code === "not_found" ? 404 : 400 });
    throw e;
  }
}
