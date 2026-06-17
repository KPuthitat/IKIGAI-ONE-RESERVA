import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listIncomeChannels, createIncomeChannel } from "@/lib/accounta-db";

// GET  /api/accounta/income-channels — active income channels (picklist)
// POST /api/accounta/income-channels — add a channel (owner-extensible)

const Body = z.object({ name: z.string().trim().min(1).max(60) });

export async function GET() {
  requirePermission("accounta.manage");
  return NextResponse.json({ ok: true, channels: listIncomeChannels() });
}

export async function POST(req: Request) {
  requirePermission("accounta.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createIncomeChannel(parsed.data);
  return NextResponse.json({ ok: true, id, channels: listIncomeChannels() });
}
