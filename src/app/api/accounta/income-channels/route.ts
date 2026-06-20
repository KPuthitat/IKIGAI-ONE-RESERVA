import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  listIncomeChannels, listAllIncomeChannels, createIncomeChannel,
  renameIncomeChannel, setIncomeChannelActive, moveIncomeChannel
} from "@/lib/accounta-db";

// GET   /api/accounta/income-channels        — active income channels (picklist)
// GET   /api/accounta/income-channels?all=1  — every channel incl. inactive (manager)
// POST  /api/accounta/income-channels        — add a channel
// PATCH /api/accounta/income-channels        — rename / activate / reorder

const Body = z.object({ name: z.string().trim().min(1).max(60) });
const PatchBody = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(60).optional(),
  active: z.boolean().optional(),
  move: z.enum(["up", "down"]).optional()
});

export async function GET(req: Request) {
  requirePermission("accounta.manage");
  const all = new URL(req.url).searchParams.get("all") === "1";
  return NextResponse.json({ ok: true, channels: all ? listAllIncomeChannels() : listIncomeChannels() });
}

export async function POST(req: Request) {
  requirePermission("accounta.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createIncomeChannel(parsed.data);
  return NextResponse.json({ ok: true, id, channels: listAllIncomeChannels() });
}

export async function PATCH(req: Request) {
  requirePermission("accounta.manage");
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.name !== undefined && !renameIncomeChannel(d.id, d.name)) {
    return NextResponse.json({ error: "rename_failed", message: "ชื่อช่องทางซ้ำหรือไม่ถูกต้อง" }, { status: 409 });
  }
  if (d.active !== undefined) setIncomeChannelActive(d.id, d.active);
  if (d.move !== undefined) moveIncomeChannel(d.id, d.move);
  return NextResponse.json({ ok: true, channels: listAllIncomeChannels() });
}
