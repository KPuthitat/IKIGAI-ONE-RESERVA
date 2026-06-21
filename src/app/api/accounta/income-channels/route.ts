import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  listIncomeChannels, listAllIncomeChannels, createIncomeChannel,
  renameIncomeChannel, setIncomeChannelActive, moveIncomeChannel,
  copyDefaultChannelsToBranch, listDefaultChannelNames
} from "@/lib/accounta-db";

// Income channels are PER-BRANCH (owner 2026-06-21). All operations scope to
// the admin's active branch.
//
// GET   ?all=1  — the active branch's full list (manager) + default names
// GET           — the active branch's active channels (picklist)
// POST          — add a channel to the active branch
// PATCH         — rename / activate / reorder / copy_defaults

const Body = z.object({ name: z.string().trim().min(1).max(60) });
const PatchBody = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  active: z.boolean().optional(),
  move: z.enum(["up", "down"]).optional(),
  copy_defaults: z.boolean().optional()
});

function branchOf() {
  const user = requirePermission("accounta.manage");
  return user.activeBranchId ?? null;
}

export async function GET(req: Request) {
  const branchId = branchOf();
  const all = new URL(req.url).searchParams.get("all") === "1";
  if (all) {
    return NextResponse.json({
      ok: true,
      channels: branchId != null ? listAllIncomeChannels(branchId) : [],
      defaults: listDefaultChannelNames()
    });
  }
  return NextResponse.json({ ok: true, channels: listIncomeChannels(branchId) });
}

export async function POST(req: Request) {
  const branchId = branchOf();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  createIncomeChannel({ name: parsed.data.name, branchId });
  return NextResponse.json({ ok: true, channels: listAllIncomeChannels(branchId) });
}

export async function PATCH(req: Request) {
  const branchId = branchOf();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.copy_defaults) {
    copyDefaultChannelsToBranch(branchId);
    return NextResponse.json({ ok: true, channels: listAllIncomeChannels(branchId) });
  }
  if (d.id == null) return NextResponse.json({ error: "id_required" }, { status: 400 });
  if (d.name !== undefined && !renameIncomeChannel(d.id, branchId, d.name)) {
    return NextResponse.json({ error: "rename_failed", message: "ชื่อช่องทางซ้ำหรือไม่ถูกต้อง" }, { status: 409 });
  }
  if (d.active !== undefined) setIncomeChannelActive(d.id, branchId, d.active);
  if (d.move !== undefined) moveIncomeChannel(d.id, branchId, d.move);
  return NextResponse.json({ ok: true, channels: listAllIncomeChannels(branchId) });
}
