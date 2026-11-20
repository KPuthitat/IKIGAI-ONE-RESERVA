import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { deleteRound, isAnnualCheckupForbidden, isAnnualCheckupInvalid, setRoundStatus, updateRoundInfo } from "@/lib/annual-checkup-db";
import { ERROR_TEXT } from "@/lib/annual-checkup-api";

// POST — the owner or a clinic recorder manages a round:
//   {roundId, status}                       open / close (employees see their number and QR only while it is open)
//   {roundId, action:"update", name, ...}   edit the name, year, dates and place
//   {roundId, action:"delete", confirmName} delete a round imported by mistake (only when it holds no health data and nobody has checked in)
const Status = z.object({ roundId: z.number().int().positive(), status: z.enum(["open", "closed", "draft"]) });
const Update = z.object({ roundId: z.number().int().positive(), action: z.literal("update"), name: z.string().max(120), yearBe: z.number().int().nullable(),
  startDate: z.string().max(10).nullable(), endDate: z.string().max(10).nullable(), location: z.string().max(200).nullable() });
const Delete = z.object({ roundId: z.number().int().positive(), action: z.literal("delete"), confirmName: z.string().max(120) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const u = Update.safeParse(body), d = Delete.safeParse(body), s = Status.safeParse(body);
    if (u.success) { updateRoundInfo(user, u.data.roundId, { name: u.data.name, yearBe: u.data.yearBe, startDate: u.data.startDate, endDate: u.data.endDate, location: u.data.location }); return NextResponse.json({ ok: true }); }
    if (d.success) { const r = deleteRound(user, d.data.roundId, d.data.confirmName); return NextResponse.json({ ok: true, people: r.people }); }
    if (s.success) { const r = setRoundStatus(user, s.data.roundId, s.data.status); return NextResponse.json({ ok: true, changed: r.changed }); }
    return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  } catch (e) {
    if (isAnnualCheckupForbidden(e)) return NextResponse.json({ ok: false, error: e.code, message: ERROR_TEXT[e.code] ?? ERROR_TEXT.not_allowed }, { status: 403 });
    if (isAnnualCheckupInvalid(e)) return NextResponse.json({ ok: false, error: e.code, message: e.message !== e.code ? e.message : (ERROR_TEXT[e.code] ?? e.code) }, { status: 422 });
    throw e;
  }
}
