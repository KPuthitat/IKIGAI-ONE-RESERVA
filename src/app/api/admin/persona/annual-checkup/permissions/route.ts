import { NextResponse } from "next/server";
import { z } from "zod";
import { addToClinic, grantCapability, revokeCapability, searchPeopleOutsideClinic } from "@/lib/annual-checkup-db";
import { handle } from "@/lib/annual-checkup-api";

// Owner only (the gateway checks super_admin again). Every grant / revoke needs a reason and is kept in annual_checkup_grants.
//   POST {action: "grant"|"revoke", userId, capability: "recorder"|"approver", reason} | {action: "add_to_clinic", userId, reason} | {action: "search", q}
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["grant", "revoke"]), userId: z.number().int().positive(), capability: z.enum(["recorder", "approver"]), reason: z.string().min(1).max(500) }),
  z.object({ action: z.literal("add_to_clinic"), userId: z.number().int().positive(), reason: z.string().min(1).max(500) }),
  z.object({ action: z.literal("search"), q: z.string().max(60) })
]);

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณาระบุเหตุผลและข้อมูลให้ครบ" }, { status: 400 });
    const d = p.data;
    if (d.action === "search") return NextResponse.json({ ok: true, people: searchPeopleOutsideClinic(user, d.q) });
    if (d.action === "add_to_clinic") { addToClinic(user, d.userId, d.reason); return NextResponse.json({ ok: true }); }
    if (d.action === "grant") grantCapability(user, d.userId, d.capability, d.reason); else revokeCapability(user, d.userId, d.capability, d.reason);
    return NextResponse.json({ ok: true });
  });
}
