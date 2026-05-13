import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction, type Branch } from "@/lib/db";
import { notifyToStaffGroup, rosterPublishedFlex } from "@/lib/line";
import { recordPublish } from "@/lib/roster";

// POST /api/admin/persona/roster/publish
//
// Send a "monthly roster is ready / has been edited" notification to
// the global executive group. Distinct from the silent edit-log row
// that every assignment write inserts — this is the explicit
// "broadcast to staff" action the supervisor takes when the month is
// ready (or when they want to inform staff about a post-publish
// change).
//
// Body: { year_month: "YYYY-MM", kind: "publish" | "edit", note?: string }

const Body = z.object({
  year_month: z.string().regex(/^\d{4}-\d{2}$/, "invalid_year_month"),
  kind: z.enum(["publish", "edit"]),
  note: z.string().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, user.activeBranchId)) return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // 1. Log first so audit captures the action even if LINE flakes.
  const logId = recordPublish(branch.id, d.year_month, d.kind, user.id, d.note ?? null);
  logPersonaAction(user.id, `roster.${d.kind}`, logId);

  // 2. Resolve the staff-facing calendar URL. Same pattern other
  //    Flex callers use — getPublicBaseUrl gives the env-driven base
  //    so the link works regardless of local/prod.
  const baseUrl = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const calendarUrl = `${baseUrl || ""}/staff/persona/calendar?month=${d.year_month}`;

  const flex = rosterPublishedFlex({
    branchName: branch.name,
    yearMonth: d.year_month,
    kind: d.kind,
    note: d.note ?? null,
    calendarUrl,
    headerColor: branch.brand_color
  });

  // Fire-and-forget — don't block the response on LINE delivery.
  // Routes through the IKIGAI OS global group when configured (this is
  // a PERSONA-wide announcement, not a booking thing), falling back
  // to the branch's group when global isn't set up.
  notifyToStaffGroup(branch, flex, "global").catch((e) =>
    console.error("roster publish notify error", e)
  );

  return NextResponse.json({ ok: true, log_id: logId });
}
