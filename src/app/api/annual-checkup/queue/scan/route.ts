import { NextResponse } from "next/server";
import { z } from "zod";
import { lookupQueueByToken } from "@/lib/annual-checkup-db";
import { ERROR_TEXT, handleClinical } from "@/lib/annual-checkup-api";

// POST {token} — clinic staff scanned a QR: who is this and what are they here for. Clinic recorders only (gateway); an unknown
// token gets the same answer whatever the reason.
const Body = z.object({ token: z.string().min(1).max(100) });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "QR ไม่ถูกต้อง" }, { status: 400 });
    const scan = lookupQueueByToken(user, p.data.token.trim());
    if (!scan) return NextResponse.json({ ok: false, error: "queue_not_found", message: ERROR_TEXT.queue_not_found }, { status: 404 });
    return NextResponse.json({ ok: true, scan });
  });
}
