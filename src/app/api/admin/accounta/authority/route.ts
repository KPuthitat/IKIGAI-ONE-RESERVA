import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { authoritySnapshot, AuthorityError, setAccountApprovers, setTiers, setTopExec } from "@/lib/pr-authority-admin";
import { RULE_TH } from "@/lib/pr-authority";
import { setQuotesRequired } from "@/lib/quotes";

// Approval authority (owner only): GET → everything; POST {action: set_tiers | set_approvers | set_top}.
export const dynamic = "force-dynamic";
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_tiers"), accountId: z.number().int().positive().nullable(), tiers: z.array(z.object({ upTo: z.number().positive().nullable(), rule: z.string() })).max(8) }),
  z.object({ action: z.literal("set_approvers"), accountId: z.number().int().positive(), userIds: z.array(z.number().int().positive()).max(20) }),
  z.object({ action: z.literal("set_top"), userId: z.number().int().positive(), value: z.boolean() }),
  z.object({ action: z.literal("set_quotes_required"), value: z.boolean() })
]);

export async function GET() {
  const u = getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (u.role !== "super_admin") return NextResponse.json({ error: "forbidden", message: "เฉพาะเจ้าของระบบ" }, { status: 403 });
  return NextResponse.json({ ok: true, ...authoritySnapshot(), ruleText: RULE_TH });
}
export async function POST(req: Request) {
  const u = getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (u.role !== "super_admin") return NextResponse.json({ error: "forbidden", message: "เฉพาะเจ้าของระบบ" }, { status: 403 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  try {
    const d = p.data;
    if (d.action === "set_tiers") setTiers(d.accountId, d.tiers, u.id);
    else if (d.action === "set_approvers") setAccountApprovers(d.accountId, d.userIds, u.id);
    else if (d.action === "set_quotes_required") setQuotesRequired(d.value, u.id);
    else setTopExec(d.userId, d.value, u.id);
    return NextResponse.json({ ok: true });
  } catch (e) { if (e instanceof AuthorityError) return NextResponse.json({ error: e.code, message: e.message }, { status: 422 }); throw e; }
}
