import { NextResponse } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/annual-checkup-api";
import { selfPassStation } from "@/lib/annual-checkup-db";

const Body = z.object({ roundId: z.number().int().positive(), code: z.string().min(1).max(64), marked: z.boolean() });

// POST {roundId, code, marked:true} — the employee records that they have been through a station (they scanned its QR and confirmed). It is an
// official pass like a staff scan. Only after check-in and only for a station on their own route.
export async function POST(req: Request) {
  return handle(async (user) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ ok: false, error: "bad_request", message: "ข้อมูลไม่ถูกต้อง" }, { status: 422 });
    // a pass is an official record and cannot be taken back from here (append-only); a mistaken tap is corrected by clinic staff
    if (!parsed.data.marked) return NextResponse.json({ ok: false, error: "cannot_undo", message: "ยกเลิกเองไม่ได้ กรุณาแจ้งเจ้าหน้าที่หากกดผิด" }, { status: 422 });
    const r = selfPassStation(user, parsed.data.roundId, parsed.data.code);
    return NextResponse.json({ ok: true, already: r.already });
  });
}
