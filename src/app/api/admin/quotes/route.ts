import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { branchVendors, chooseQuote, deleteQuote, getCompare, permsFor, QUOTE_ERROR_TH, QuoteError, saveQuote, setSoleSource } from "@/lib/quotes";
import { viewerOf } from "@/lib/purchasing";

// Quotation comparison for a memo or a PR (owner 2026-11-27). GET ?scope=memo|pr&id= → the comparison and what this person may do on it.
// POST {action: save_quote | delete_quote | set_sole | choose, scope, id, ...}. Who may edit / choose is decided in lib/quotes (draft stage; executives may re-choose on a sent PR before approvals).
export const dynamic = "force-dynamic";
const Ref = { scope: z.enum(["memo", "pr"]), id: z.number().int().positive() };
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_quote"), ...Ref, quote: z.object({
    id: z.number().int().positive().optional(), vendorId: z.number().int().positive().nullable().optional(), vendorName: z.string().max(200).optional(), quoteNo: z.string().max(60).optional(),
    quoteDate: z.string().nullable().optional(), validUntil: z.string().nullable().optional(), amount: z.number().min(0).max(1_000_000_000), note: z.string().max(600).optional(),
    priceScore: z.number().int().min(0).max(100), priceReason: z.string().max(600).optional(), benefitScore: z.number().int().min(0).max(100), benefitReason: z.string().max(600).optional() }) }),
  z.object({ action: z.literal("delete_quote"), ...Ref, quoteId: z.number().int().positive() }),
  z.object({ action: z.literal("set_sole"), ...Ref, on: z.boolean(), reason: z.string().max(600).optional() }),
  z.object({ action: z.literal("choose"), ...Ref, quoteId: z.number().int().positive(), weightPrice: z.number().int().min(0).max(100), reason: z.string().max(600) })
]);

function gate() {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  const viewer = viewerOf(user);
  if (user.role === "staff" && !viewer.isCLevel) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user, viewer };
}
const fail = (e: unknown) => {
  if (e instanceof QuoteError) return NextResponse.json({ error: e.code, message: QUOTE_ERROR_TH[e.code] }, { status: e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "bad_status" ? 409 : 400 });
  throw e;
};

export async function GET(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const sp = new URL(req.url).searchParams; const scope = sp.get("scope"), id = Number(sp.get("id"));
  if ((scope !== "memo" && scope !== "pr") || !id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try { return NextResponse.json({ ok: true, compare: getCompare(scope, id), perms: permsFor(scope, id, g.viewer), vendors: branchVendors(scope, id) }); } catch (e) { return fail(e); }
}

export async function POST(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const d = p.data;
  try {
    let quoteId: number | undefined;
    if (d.action === "save_quote") { quoteId = saveQuote(d.scope, d.id, d.quote, g.viewer); logPersonaAction(g.user.id, `quotes.save.${d.scope}`, d.id); }
    else if (d.action === "delete_quote") { deleteQuote(d.scope, d.id, d.quoteId, g.viewer); logPersonaAction(g.user.id, `quotes.delete.${d.scope}`, d.id); }
    else if (d.action === "set_sole") { setSoleSource(d.scope, d.id, d.on, d.reason ?? "", g.viewer); logPersonaAction(g.user.id, `quotes.sole.${d.scope}`, d.id); }
    else chooseQuote(d.scope, d.id, d.quoteId, d.weightPrice, d.reason, g.viewer);
    return NextResponse.json({ ok: true, quoteId, compare: getCompare(d.scope, d.id), perms: permsFor(d.scope, d.id, g.viewer) });
  } catch (e) { return fail(e); }
}
