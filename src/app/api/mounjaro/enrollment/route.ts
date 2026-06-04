import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { enrollSelf, withdrawSelf, eraseMyData, type MjActor } from "@/lib/mounjaro-db";

// POST /api/mounjaro/enrollment — employee self-service enrollment lifecycle.
//   action 'enroll'   → express interest (creates a pending enrollment)
//   action 'withdraw' → leave the program (keeps the record, status=withdrawn)
//   action 'erase'    → PDPA erasure (hide from portal; medical record retained)
// All scoped to the acting employee by the gateway — no id is accepted.

const Body = z.object({
  action: z.enum(["enroll", "withdraw", "erase"]),
  reason: z.string().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const actor = user as MjActor;
  try {
    if (parsed.data.action === "enroll") {
      const enr = enrollSelf(actor);
      return NextResponse.json({ ok: true, status: enr.status });
    }
    if (parsed.data.action === "withdraw") {
      withdrawSelf(actor, parsed.data.reason ?? null);
      return NextResponse.json({ ok: true });
    }
    eraseMyData(actor);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
