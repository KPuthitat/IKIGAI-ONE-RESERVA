import { NextResponse } from "next/server";
import { z } from "zod";
import { checkIn } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST {token | queueId, kitNo?} — confirm a check-in (by scanned token, or by the roster row for people without an account) and link the
// sample-kit number scanned / typed by the staff. Idempotent: a second call changes nothing (it only fills a kit number that was missing)
// and reports who checked the person in.
const Body = z.union([
  z.object({ token: z.string().min(1).max(100), kitNo: z.string().max(60).nullable().optional() }),
  z.object({ queueId: z.number().int().positive(), kitNo: z.string().max(60).nullable().optional() })
]);

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const r = checkIn(user, "token" in p.data ? { token: p.data.token.trim() } : { queueId: p.data.queueId }, { kitNo: p.data.kitNo });
    return NextResponse.json({ ok: true, already: r.already, scan: r.scan });
  });
}
