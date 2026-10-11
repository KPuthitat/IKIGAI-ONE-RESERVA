import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { canManage, getManagerView } from "@/lib/special-duty-access";
import { getMonth, listPositions, SpecialDutyError } from "@/lib/special-duty";
import { checkAssignment } from "@/lib/special-duty-rules";
import { closeBooking, fillOpenDays, managerAssign, openDays, publishSchedule, removeDay, startFilling } from "@/lib/special-duty-fill";
import { pushIndividually, schedulePublishedFlex } from "@/lib/special-duty-notify";
import { assignSubstitute, dayBelongsToBranch, EvidenceError, listEvidence, listSubstituteCandidates, markAbsent, reviewEvidence } from "@/lib/special-duty-evidence";
import { EVIDENCE_TEXT, RULE_TEXT, viewerOf } from "@/lib/special-duty-viewer";

// Manager console for ตำแหน่งงานค่าตอบแทนพิเศษ (active branch).
//   GET  ?month=YYYY-MM[&candidates=<positionId>:<date>]
//   POST {month, action: close_booking | start_filling | suggest | apply_suggestions | assign | remove | publish, ...}

const YM = z.string().regex(/^\d{4}-\d{2}$/);

function gate() {
  const user = getSessionUser();
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) } as const;
  const branchId = user.activeBranchId;
  if (!branchId || !userHasBranch(user, branchId)) return { error: NextResponse.json({ error: "no_active_branch" }, { status: 400 }) } as const;
  const viewer = viewerOf(user);
  if (!canManage(viewer, branchId)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  return { user, branchId, viewer } as const;
}

export async function GET(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const q = new URL(req.url).searchParams;
  const month = YM.safeParse(q.get("month"));
  if (!month.success) return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  const m = getMonth(g.branchId, month.data);
  const photosOf = q.get("photos");
  if (photosOf) {
    const id = Number(photosOf);
    if (!dayBelongsToBranch(id, g.branchId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ photos: listEvidence(id).filter((x) => !x.deleted).map((x) => ({ id: x.id, uploadedAt: x.uploadedAt })) });
  }
  const subsOf = q.get("substitutes");
  if (subsOf) return NextResponse.json({ candidates: listSubstituteCandidates(Number(subsOf), g.branchId) });
  const cand = q.get("candidates");
  if (cand) {
    const [pid, date] = cand.split(":");
    const users = getDb().prepare(`SELECT u.id, u.display_name AS name FROM users u
        WHERE u.role IN ('staff','admin') AND u.status NOT IN ('disabled','resigned','terminated') AND COALESCE(u.is_test_account,0) = 0
          AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?) ORDER BY u.display_name`).all(g.branchId) as Array<{ id: number; name: string }>;
    return NextResponse.json({ candidates: users.filter((u) => checkAssignment({ userId: u.id, branchId: g.branchId, yearMonth: month.data, positionId: Number(pid), date }).ok) });
  }
  const filling = ["booking_closed", "filling"].includes(m.status);
  return NextResponse.json({
    month: m, positions: listPositions(g.branchId, month.data, { activeOnly: true }),
    rows: m.enabled ? getManagerView(g.viewer, g.branchId, month.data) : [],
    open: m.enabled && (filling || m.status === "booking_open") ? openDays(g.branchId, month.data) : []
  });
}

const Body = z.object({
  month: YM,
  action: z.enum(["close_booking", "start_filling", "suggest", "apply_suggestions", "assign", "remove", "publish", "approve", "reject", "absent", "substitute"]),
  position_id: z.number().int().optional(), date: z.string().optional(), user_id: z.number().int().optional(),
  day_id: z.number().int().optional(), allow_unfilled: z.boolean().optional(), note: z.string().max(300).optional()
});

export async function POST(req: Request) {
  const g = gate(); if ("error" in g) return g.error;
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = p.data; const ym = d.month; const branchId = g.branchId; const actorId = g.user.id;
  try {
    switch (d.action) {
      case "close_booking": closeBooking({ branchId, yearMonth: ym, actorId }); break;
      case "start_filling": startFilling({ branchId, yearMonth: ym, actorId }); break;
      case "suggest": return NextResponse.json({ ok: true, plan: fillOpenDays({ branchId, yearMonth: ym, managerId: actorId, commit: false }) });
      case "apply_suggestions": return NextResponse.json({ ok: true, plan: fillOpenDays({ branchId, yearMonth: ym, managerId: actorId, commit: true }) });
      case "assign": {
        if (!d.position_id || !d.date || !d.user_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        const r = managerAssign({ branchId, yearMonth: ym, positionId: d.position_id, date: d.date, userId: d.user_id, managerId: actorId });
        if (!r.ok) return NextResponse.json({ ok: false, errors: r.errors.map((e) => ({ ...e, message: RULE_TEXT[e.code] ?? e.code })) }, { status: 422 });
        break;
      }
      case "remove": {
        if (!d.day_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        const r = removeDay({ dayId: d.day_id, branchId, managerId: actorId });
        if (!r.ok) return NextResponse.json({ ok: false, error: r.code }, { status: 422 });
        break;
      }
      case "approve": case "reject": {
        if (!d.day_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        reviewEvidence({ dayId: d.day_id, branchId, managerId: actorId, approve: d.action === "approve", note: d.note });
        break;
      }
      case "absent": {
        if (!d.day_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        markAbsent({ dayId: d.day_id, branchId, managerId: actorId });
        break;
      }
      case "substitute": {
        if (!d.day_id || !d.user_id) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
        assignSubstitute({ dayId: d.day_id, branchId, performerId: d.user_id, managerId: actorId });
        break;
      }
      case "publish": {
        const r = publishSchedule({ branchId, yearMonth: ym, actorId, allowUnfilled: d.allow_unfilled === true });
        if (!r.published) return NextResponse.json({ ok: false, error: "unfilled_days", unfilled: r.unfilled }, { status: 409 });
        const branch = getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string };
        const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
        for (const duty of r.duties) {
          pushIndividually([duty.lineUserId], schedulePublishedFlex({ branchName: branch.name, yearMonth: ym, days: duty.days, url: `${base}/staff/persona/special-duty?month=${ym}` }))
            .catch((e) => console.error("special duty publish push", e));
        }
        break;
      }
    }
    logPersonaAction(actorId, `special_duty.${d.action}`, branchId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SpecialDutyError) return NextResponse.json({ ok: false, error: e.code }, { status: 409 });
    if (e instanceof EvidenceError) return NextResponse.json({ ok: false, error: e.code, message: EVIDENCE_TEXT[e.code] ?? e.code }, { status: 422 });
    throw e;
  }
}
