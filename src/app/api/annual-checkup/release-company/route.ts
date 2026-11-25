import { NextResponse } from "next/server";
import { z } from "zod";
import { releaseCompany, verifyCompany } from "@/lib/annual-checkup-db";
import { handleClinical, isUnlocked } from "@/lib/annual-checkup-api";

// POST {roundId, payerId, action?: "verify" | "release"} — "verify": the approver verifies every draft result of the company; "release" (default): open the results of every person of one paying company who is ready; the rest are listed with the reason.
const Body = z.object({ roundId: z.number().int().positive(), payerId: z.number().int().positive(), action: z.enum(["verify", "release"]).default("release") });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    if (p.data.action === "verify") return NextResponse.json({ ok: true, ...verifyCompany(user, p.data.roundId, p.data.payerId, { licenseUnlocked: isUnlocked(user) }) });
    return NextResponse.json({ ok: true, ...releaseCompany(user, p.data.roundId, p.data.payerId, { licenseUnlocked: isUnlocked(user) }) });
  });
}
