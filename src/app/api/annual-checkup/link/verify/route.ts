import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { verifyAccessLink } from "@/lib/annual-checkup-db";
import { LINK_COOKIE, LINK_MINUTES, makeLinkToken } from "@/lib/annual-checkup-session";

// POST {token, dob: "yyyy-mm-dd" (Christian era)} — PUBLIC. A person without an account opens their results with the link and their date of
// birth. Wrong answers are counted per link and five in a row lock it for 30 minutes (decided in the gateway, not here). The answer never
// says whether the link or the date was the problem.
export const dynamic = "force-dynamic";
const Body = z.object({ token: z.string().min(20).max(80), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, message: "กรุณากรอกวันเดือนปีเกิดให้ครบ" }, { status: 400 });
  const r = verifyAccessLink(p.data.token, p.data.dob);
  if (!r.ok) {
    if (r.reason === "locked") return NextResponse.json({ ok: false, error: "locked", message: "กรอกผิดหลายครั้ง ลิงก์ถูกล็อกชั่วคราว กรุณาลองใหม่ภายหลัง หรือติดต่อผู้ดูแล" }, { status: 429 });
    if (r.reason === "expired" || r.reason === "revoked") return NextResponse.json({ ok: false, error: r.reason, message: "ลิงก์นี้ใช้ไม่ได้แล้ว กรุณาขอลิงก์ใหม่จากผู้ดูแล" }, { status: 410 });
    return NextResponse.json({ ok: false, error: "wrong", message: `ข้อมูลไม่ถูกต้อง${r.attemptsLeft != null ? ` (เหลืออีก ${r.attemptsLeft} ครั้ง)` : ""}` }, { status: 403 });
  }
  cookies().set(LINK_COOKIE, makeLinkToken(r.linkId), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: LINK_MINUTES * 60 });
  return NextResponse.json({ ok: true });
}
