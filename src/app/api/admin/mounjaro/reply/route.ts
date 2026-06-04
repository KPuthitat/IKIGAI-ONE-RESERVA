import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { replySelfLog, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

// POST /api/admin/mounjaro/reply — doctor replies to one of their
// patients' self-logs.

const Body = z.object({
  self_log_id: z.number().int().positive(),
  reply: z.string().min(1).max(1000)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isClinicalUnlocked(user)) return NextResponse.json({ error: "locked" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    replySelfLog(user as MjActor, parsed.data.self_log_id, parsed.data.reply);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
