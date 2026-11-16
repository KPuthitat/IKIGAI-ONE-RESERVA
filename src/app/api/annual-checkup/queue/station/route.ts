import { NextResponse } from "next/server";
import { z } from "zod";
import { passStation } from "@/lib/annual-checkup-db";
import { handle } from "@/lib/annual-checkup-api";

// POST {token | queueId, station} — staff at a station mark the person as having passed it. Needs a check-in and a station on the person's route.
const Body = z.union([
  z.object({ token: z.string().min(1).max(100), station: z.string().min(1).max(40) }),
  z.object({ queueId: z.number().int().positive(), station: z.string().min(1).max(40) })
]);

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const r = passStation(user, "token" in p.data ? { token: p.data.token.trim() } : { queueId: p.data.queueId }, p.data.station);
    return NextResponse.json({ ok: true, already: r.already, scan: r.scan });
  });
}
