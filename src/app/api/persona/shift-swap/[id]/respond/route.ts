import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { respondSwap } from "@/lib/shift-swap";

// POST /api/persona/shift-swap/[id]/respond { action: "accept" | "decline" }
// The target staff accepts (→ roster swaps automatically) or declines.
const Body = z.object({ action: z.enum(["accept", "decline"]) });

const ERR_MSG: Record<string, string> = {
  not_found: "ไม่พบคำขอ",
  not_target: "คำขอนี้ไม่ได้ส่งถึงคุณ",
  not_pending: "คำขอนี้ถูกตอบไปแล้ว",
  roster_changed: "ตารางมีการเปลี่ยนแปลง — ให้ผู้ขอส่งคำขอใหม่อีกครั้ง"
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const res = respondSwap(user.id, id, parsed.data.action);
  if (!res.ok) return NextResponse.json({ error: res.error, message: ERR_MSG[res.error] }, { status: 400 });
  return NextResponse.json({ ok: true, action: res.action });
}
