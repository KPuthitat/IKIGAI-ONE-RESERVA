import { NextResponse } from "next/server";
import { z } from "zod";
import { checkIn } from "@/lib/annual-checkup-db";
import { handle } from "@/lib/annual-checkup-api";

// POST {token} | {queueId} — confirm a check-in (by scanned token, or by the roster row for people without an account). Idempotent:
// a second call changes nothing and reports who checked the person in.
const Body = z.union([z.object({ token: z.string().min(1).max(100) }), z.object({ queueId: z.number().int().positive() })]);

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const r = checkIn(user, "token" in p.data ? { token: p.data.token.trim() } : { queueId: p.data.queueId });
    return NextResponse.json({ ok: true, already: r.already, scan: r.scan });
  });
}
