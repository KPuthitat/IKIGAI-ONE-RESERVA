import { NextResponse } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/annual-checkup-api";
import { selfCheckIn } from "@/lib/annual-checkup-db";
import { readStationToken, REGISTER_CODE } from "@/lib/annual-checkup-session";

// POST {roundId, token} — the employee checks themselves in after scanning the registration poster. The token is the poster's signed code, so
// the page that offers the button is the only way in; it only ever checks in the signed-in person's own row.
const Body = z.object({ roundId: z.number().int().positive(), token: z.string().min(10).max(200) });

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success || readStationToken(p.data.token) !== REGISTER_CODE) return NextResponse.json({ ok: false, error: "bad_request", message: "QR ลงทะเบียนไม่ถูกต้อง กรุณาสแกนป้ายลงทะเบียนอีกครั้ง" }, { status: 422 });
    const r = selfCheckIn(user, p.data.roundId);
    return NextResponse.json({ ok: true, already: r.already });
  });
}
