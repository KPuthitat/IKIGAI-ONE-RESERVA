import { NextResponse } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/annual-checkup-api";
import { setMyStationMark } from "@/lib/annual-checkup-db";

const Body = z.object({ roundId: z.number().int().positive(), code: z.string().min(1).max(64), marked: z.boolean() });

// POST — the employee ticks / unticks "I have been through this station" on their own queue entry (their own convenience; the clinic's
// scan stays the official record). Only after check-in and only for a station on their own route.
export async function POST(req: Request) {
  return handle(async (user) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ ok: false, error: "bad_request", message: "ข้อมูลไม่ถูกต้อง" }, { status: 422 });
    setMyStationMark(user, parsed.data.roundId, parsed.data.code, parsed.data.marked);
    return NextResponse.json({ ok: true });
  });
}
