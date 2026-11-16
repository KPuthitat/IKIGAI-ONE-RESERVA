import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { assignTestStation, saveStation, StationRefused } from "@/lib/annual-checkup-stations";

// POST {action:"save", id?, code?, nameTh, sortNo, active} | {action:"assign", testCode, stationId|null} — the owner or a clinic recorder edits the stations.
const Body = z.union([
  z.object({ action: z.literal("save"), id: z.number().int().positive().optional(), code: z.string().max(40).optional(), nameTh: z.string().min(1).max(100), sortNo: z.number().int().min(0).max(999), active: z.boolean() }),
  z.object({ action: z.literal("assign"), testCode: z.string().min(1).max(40), stationId: z.number().int().positive().nullable() })
]);

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  try {
    if (p.data.action === "save") return NextResponse.json({ ok: true, id: saveStation(user.id, p.data) });
    assignTestStation(user.id, p.data.testCode, p.data.stationId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof StationRefused) return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: e.code === "not_allowed" ? 403 : 422 });
    throw e;
  }
}
