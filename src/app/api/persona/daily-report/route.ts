import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction, type Branch, type DailyReportType } from "@/lib/db";
import {
  shiftOpenFlex, shiftCloseFlex, readinessFlex, notifyDailyReport
} from "@/lib/line";
import { todayBkk } from "@/lib/time";

// POST /api/persona/daily-report
//
// One endpoint for all 4 daily-report types:
//   shift_open        — เช็คลิสต์ก่อนเริ่มงาน (Phase B, live)
//   shift_close       — เช็คลิสต์หลังเลิกงาน (Phase C, live as of 2026-05)
//   readiness_1130    — รายงานความพร้อมรอบ 11:30 (live as of 2026-05)
//   readiness_1600    — รายงานความพร้อมรอบ 16:00 (live as of 2026-05)
//
// The body always carries `type` + `branch_id` + `data` (JSON blob whose
// shape depends on the type). Server derives `report_date` from
// todayBkk() so staff can't back-date a report. The user_id is taken
// from the session, not the body. The LINE Flex card is pushed to the
// branch's staff_group_id (NOT the session activeBranchId), so
// notifications always land in the right group.
//
// One report per (branch, type, date) — enforced at the DB layer by
// idx_daily_reports_unique_per_day. The route also checks for an
// existing row first so we can return a friendly 409 with the
// previous row's metadata rather than a raw SQLITE_CONSTRAINT.

// Checklist is dynamic — admin can add/edit items at /admin/persona/checklist.
// We store the rendered label alongside the checked state so historical
// reports stay readable even after admin renames or deletes an item.
//
// Optional `note` lets staff explain why an item is being skipped today
// ("ฝนตกหนัก ตั้งป้ายไม่ได้" etc.). When set on an unchecked row, the
// LINE card renders it under the label as a 📝 skipped-with-reason
// item rather than a red ✗ "not done".
const ChecklistEntry = z.object({
  label: z.string().min(1).max(200),
  checked: z.boolean(),
  note: z.string().max(500).nullable().optional()
});

// Per-type data schemas. Each form in the staff UI submits one of these.
const ShiftOpenData = z.object({
  yesterday_closing_amount: z.number().min(0).max(10_000_000).nullable(),
  morning_drawer_amount: z.number().min(0).max(10_000_000).nullable(),
  checklist: z.array(ChecklistEntry).max(50)
});
const ShiftCloseData = z.object({
  closing_drawer_amount: z.number().min(0).max(10_000_000).nullable(),
  checklist: z.array(ChecklistEntry).max(50)
});
// Readiness reports (11:30 + 16:00) — 3 free-text sections + alcohol
// status. All text fields are optional (empty string allowed) so
// staff isn't forced to type anything if there's nothing to report.
// Alcohol always carries a value because the form defaults to "ok".
const ReadinessData = z.object({
  team_communications: z.string().max(2000).default(""),
  menus_not_ready: z.string().max(2000).default(""),
  menus_modified: z.string().max(2000).default(""),
  alcohol_status: z.enum(["ok", "blocked"])
});

const Body = z.object({
  type: z.enum(["shift_open", "shift_close", "readiness_1130", "readiness_1600"]),
  branch_id: z.number().int().positive(),
  data: z.unknown()    // narrowed per-type below
});

// Type-aware data validator. Returns the parsed data on success, or
// a Zod error to send back as 400. Keeps the route handler tidy.
function validateData(
  type: z.infer<typeof Body>["type"],
  data: unknown
): { ok: true; data: unknown } | { ok: false; detail: unknown } {
  let result;
  switch (type) {
    case "shift_open":     result = ShiftOpenData.safeParse(data); break;
    case "shift_close":    result = ShiftCloseData.safeParse(data); break;
    case "readiness_1130":
    case "readiness_1600": result = ReadinessData.safeParse(data); break;
  }
  if (!result.success) return { ok: false, detail: result.error.flatten() };
  return { ok: true, data: result.data };
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { type, branch_id, data } = parsed.data;
  const report_date = todayBkk();

  // Authorization: staff can only submit reports for branches they're
  // assigned to. Stops a curious staff from spoofing a different
  // branch's id in DevTools and pushing into that group.
  if (!userHasBranch(user, branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const v = validateData(type, data);
  if (!v.ok) {
    return NextResponse.json(
      { error: "invalid_data", detail: v.detail },
      { status: 400 }
    );
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(branch_id) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Duplicate guard: one LIVE (non-superseded) report per (branch,
  // type, date). Ties to the unique partial index — we check first
  // so the response includes the existing row's metadata instead of
  // a raw SQLITE_CONSTRAINT.
  const existing = db.prepare(`
    SELECT r.id, r.user_id, r.created_at, u.display_name AS opener_name
    FROM daily_reports r JOIN users u ON r.user_id = u.id
    WHERE r.type = ? AND r.branch_id = ? AND r.report_date = ?
      AND r.superseded_at IS NULL
  `).get(type, branch.id, report_date) as
    | { id: number; user_id: number; created_at: string; opener_name: string }
    | undefined;
  if (existing) {
    return NextResponse.json({
      error: "already_submitted",
      existing: {
        id: existing.id,
        opener_name: existing.opener_name,
        created_at: existing.created_at
      }
    }, { status: 409 });
  }

  // If a previous row for the same (branch, type, date) is now
  // superseded — i.e. admin granted an unlock and the staff is now
  // re-submitting — chain the new row to the most recent superseded
  // one via replaces_id. The locked-view + LINE card will surface
  // "ฉบับแก้ไข" so reviewers know this is a revision.
  const supersededPrev = db.prepare(`
    SELECT id FROM daily_reports
    WHERE type = ? AND branch_id = ? AND report_date = ?
      AND superseded_at IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(type, branch.id, report_date) as { id: number } | undefined;
  const isRevision = !!supersededPrev;

  const insertedAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO daily_reports
      (type, branch_id, user_id, report_date, data, replaces_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type as DailyReportType,
    branch.id,
    user.id,
    report_date,
    JSON.stringify(v.data),
    supersededPrev?.id ?? null,
    insertedAt,
    insertedAt
  );
  const id = result.lastInsertRowid as number;

  // Activity log — minimal: action + by-user + ref_id pointing at
  // the new daily_reports row. Different action verb for revisions
  // so admin reading the log can tell them apart.
  logPersonaAction(
    user.id,
    isRevision ? `daily_report.resubmit.${type}` : `daily_report.submit.${type}`,
    id
  );

  // Build + push the Flex card to the branch staff group. Fire-and-forget
  // so a LINE API hiccup doesn't block the form submission.
  // Each type gets its own Flex builder so admin can tell at a glance
  // which report just landed.
  const normalizeChecklist = (
    items: Array<{ label: string; checked: boolean; note?: string | null }>
  ) =>
    items.map((c) => ({ label: c.label, checked: c.checked, note: c.note ?? null }));

  let flex;
  if (type === "shift_open") {
    const d = v.data as z.infer<typeof ShiftOpenData>;
    flex = shiftOpenFlex({
      branchName: branch.name,
      reportDate: report_date,
      openerName: user.display_name,
      yesterdayClosingAmount: d.yesterday_closing_amount,
      morningDrawerAmount: d.morning_drawer_amount,
      checklist: normalizeChecklist(d.checklist),
      isRevision
    });
  } else if (type === "shift_close") {
    const d = v.data as z.infer<typeof ShiftCloseData>;
    flex = shiftCloseFlex({
      branchName: branch.name,
      reportDate: report_date,
      closerName: user.display_name,
      closingDrawerAmount: d.closing_drawer_amount,
      checklist: normalizeChecklist(d.checklist),
      isRevision
    });
  } else {
    // readiness_1130 / readiness_1600
    const d = v.data as z.infer<typeof ReadinessData>;
    flex = readinessFlex({
      branchName: branch.name,
      reportDate: report_date,
      reporterName: user.display_name,
      slot: type === "readiness_1130" ? "11:30" : "16:00",
      teamCommunications: d.team_communications,
      menusNotReady: d.menus_not_ready,
      menusModified: d.menus_modified,
      alcoholStatus: d.alcohol_status,
      isRevision
    });
  }
  notifyDailyReport(branch, flex).catch((e) =>
    console.error("notify daily-report error", e)
  );

  return NextResponse.json({ ok: true, id });
}
