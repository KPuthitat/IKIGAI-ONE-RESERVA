import { NextResponse } from "next/server";
import { getDb, logPersonaAction } from "@/lib/db";
import { sqlNameWithPrefix } from "@/lib/name";
import { createNotice, listForAdmin } from "@/lib/policy-notices";
import { loadPickerStaff } from "@/lib/staff-picker";
import { adminGate, errorResponse, NoticeBody } from "@/lib/policy-notices-api";

// GET  → every notice with its acknowledged / recipient counts, plus the branches to scope a notice to
// POST {title, purpose?, meeting_at?, location?, ack_deadline?} → create (status scheduled)

export async function GET() {
  const g = adminGate(); if ("error" in g) return g.error;
  const { staff, branches } = loadPickerStaff(g.user.activeBranchId ?? null);
  const me = getDb().prepare(`SELECT ${sqlNameWithPrefix("u")} AS name FROM users u WHERE u.id = ?`).get(g.user.id) as { name: string } | undefined;
  return NextResponse.json({ ok: true, notices: listForAdmin(), staff, branches, me: me?.name ?? "" });
}

export async function POST(req: Request) {
  const g = adminGate(); if ("error" in g) return g.error;
  const parsed = NoticeBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const d = parsed.data;
  try {
    const id = createNotice({ title: d.title, purpose: d.purpose, meetingAt: d.meeting_at ?? null, location: d.location, announcer: d.announcer, branchId: null, ackDeadline: d.ack_deadline ?? null }, g.user.id);
    logPersonaAction(g.user.id, "policy_notice_create", id);
    return NextResponse.json({ ok: true, id });
  } catch (e) { return errorResponse(e); }
}
