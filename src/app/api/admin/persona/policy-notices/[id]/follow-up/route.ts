import { NextResponse } from "next/server";
import { logPersonaAction } from "@/lib/db";
import { createFollowUp } from "@/lib/policy-notices";
import { adminGate, errorResponse } from "@/lib/policy-notices-api";

// POST → start a follow-up letter ("ฉบับแก้ไข") continuing a notice that has been sent
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const g = adminGate(); if ("error" in g) return g.error;
  try {
    const id = createFollowUp(Number(params.id), g.user.id);
    logPersonaAction(g.user.id, "policy_notice_follow_up", id);
    return NextResponse.json({ ok: true, id });
  } catch (e) { return errorResponse(e); }
}
