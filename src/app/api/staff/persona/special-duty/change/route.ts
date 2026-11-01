import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { candidatesForRequester, cancelDutyChange, EvidenceError, listMyChanges, REPLACE_REASONS, requestDutyChange } from "@/lib/special-duty-evidence";
import { pushChangeRequested } from "@/lib/special-duty-change-api";
import { EVIDENCE_TEXT } from "@/lib/special-duty-viewer";

// An employee asks to hand over one of their special-duty days (sick leave or any reason — the reason is required).
// GET  ?month=YYYY-MM            → my requests with their status
// GET  ?month=YYYY-MM&candidates=<dayId> → who could take that day (only for a day I hold or perform)
// POST {month, action: request | cancel, ...}  — the branch manager decides in the admin console

const YM = z.string().regex(/^\d{4}-\d{2}$/);

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const q = new URL(req.url).searchParams;
  const month = YM.safeParse(q.get("month"));
  if (!month.success) return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  const cand = q.get("candidates");
  if (cand) {
    try { return NextResponse.json({ candidates: candidatesForRequester(Number(cand), user.id) }); }
    catch (e) { if (e instanceof EvidenceError) return NextResponse.json({ error: e.code }, { status: 403 }); throw e; }
  }
  return NextResponse.json({ requests: listMyChanges(user.id, month.data) });
}

const Body = z.object({
  month: YM,
  action: z.enum(["request", "cancel"]),
  day_id: z.number().int().optional(), request_id: z.number().int().optional(),
  proposed_user_id: z.number().int().nullable().optional(),
  reason_type: z.enum(REPLACE_REASONS).optional(), note: z.string().max(200).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId || !userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = p.data;
  try {
    if (d.action === "request") {
      if (!d.day_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      if (!d.reason_type) return NextResponse.json({ ok: false, error: "reason_required", message: EVIDENCE_TEXT.reason_required }, { status: 422 });
      const id = requestDutyChange({ dayId: d.day_id, userId: user.id, proposedUserId: d.proposed_user_id ?? null, reasonType: d.reason_type, note: d.note });
      const v = listMyChanges(user.id, d.month).find((x) => x.id === id);
      if (v) pushChangeRequested(v, d.month);
      return NextResponse.json({ ok: true, id });
    }
    if (!d.request_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    cancelDutyChange({ requestId: d.request_id, userId: user.id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof EvidenceError) return NextResponse.json({ ok: false, error: e.code, message: EVIDENCE_TEXT[e.code] ?? e.code }, { status: 422 });
    throw e;
  }
}
