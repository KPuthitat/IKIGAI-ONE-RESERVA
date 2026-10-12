import { NextResponse } from "next/server";
import { getDb, logPersonaAction } from "@/lib/db";
import { createNotice, listForAdmin } from "@/lib/policy-notices";
import { adminGate, errorResponse, NoticeBody } from "@/lib/policy-notices-api";

// GET  → every notice with its acknowledged / recipient counts, plus the branches to scope a notice to
// POST {title, purpose?, meeting_at?, location?, branch_id?, ack_deadline?} → create (status scheduled)

export async function GET() {
  const g = adminGate(); if ("error" in g) return g.error;
  const branches = getDb().prepare("SELECT id, name FROM branches ORDER BY name").all() as Array<{ id: number; name: string }>;
  return NextResponse.json({ ok: true, notices: listForAdmin(), branches });
}

export async function POST(req: Request) {
  const g = adminGate(); if ("error" in g) return g.error;
  const parsed = NoticeBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const d = parsed.data;
  try {
    const id = createNotice({ title: d.title, purpose: d.purpose, meetingAt: d.meeting_at ?? null, location: d.location, branchId: d.branch_id ?? null, ackDeadline: d.ack_deadline ?? null }, g.user.id);
    logPersonaAction(g.user.id, "policy_notice_create", id);
    return NextResponse.json({ ok: true, id });
  } catch (e) { return errorResponse(e); }
}
