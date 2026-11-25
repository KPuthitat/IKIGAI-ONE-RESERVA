import { NextResponse } from "next/server";
import { z } from "zod";
import { createAccessLink, revokeAccessLink } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST {action: "create", roundId, externalId, days} → {url} (shown once; only its hash is stored) | {action: "revoke", linkId}
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), roundId: z.number().int().positive(), externalId: z.number().int().positive(), days: z.number().int().min(1).max(90) }),
  z.object({ action: z.literal("revoke"), linkId: z.number().int().positive() })
]);

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    if (p.data.action === "revoke") { revokeAccessLink(user, p.data.linkId); return NextResponse.json({ ok: true }); }
    const l = createAccessLink(user, p.data.roundId, p.data.externalId, p.data.days);
    return NextResponse.json({ ok: true, url: `${PUBLIC_BASE}/health/r/${l.token}`, expires_at: l.expires_at });
  });
}
