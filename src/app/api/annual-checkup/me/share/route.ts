import { NextResponse } from "next/server";
import { z } from "zod";
import { setMyShare } from "@/lib/annual-checkup-db";
import { handle } from "@/lib/annual-checkup-api";

// POST {scope: "followup"|"values", on: boolean} — an employee decides what HR may see. Their own row only (the user comes from the session).
const Body = z.object({ scope: z.enum(["followup", "values"]), on: z.boolean() });
export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    setMyShare(user, p.data.scope, p.data.on);
    return NextResponse.json({ ok: true });
  });
}
