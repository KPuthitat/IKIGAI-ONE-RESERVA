import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Branch, type DailyReportType } from "@/lib/db";
import { shiftOpenFlex, notifyDailyReport } from "@/lib/line";
import { todayBkk } from "@/lib/time";

// POST /api/persona/daily-report
//
// Single endpoint for all 4 daily-report types:
//   shift_open        — เปิดกะ (Phase B)
//   shift_close       — ปิดกะ (Phase C — TODO)
//   readiness_1130    — รายงานความพร้อม รอบ 11:30 (Phase D — TODO)
//   readiness_1600    — รายงานความพร้อม รอบ 16:00 (Phase D — TODO)
//
// The body always carries `type` + `branch_id` + `report_date` + `data`
// (a JSON blob that mirrors the form's field shape for that type). The
// staff client sends `branch_id` explicitly so a person who works
// morning at A and afternoon at B can submit two reports the same day.
// Server validates the staff is assigned to that branch via
// user_branches; if not, request is rejected. The LINE Flex card is
// pushed to that branch's staff_group_id (NOT the session
// activeBranchId), so notifications always land in the right group.

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
const ShiftOpenData = z.object({
  yesterday_closing_amount: z.number().min(0).max(10_000_000).nullable(),
  morning_drawer_amount: z.number().min(0).max(10_000_000).nullable(),
  checklist: z.array(ChecklistEntry).max(50)
});

// `report_date` is no longer accepted from the client — server always
// uses todayBkk(). Same for the user_id / opener — taken from session,
// not the body. This stops a staff from "back-dating" a shift open or
// filing on behalf of someone else.
const Body = z.object({
  type: z.enum(["shift_open", "shift_close", "readiness_1130", "readiness_1600"]),
  branch_id: z.number().int().positive(),
  data: z.unknown()    // narrowed per-type below
});

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

  // Per-type data validation. Other types will be added in Phase C/D.
  if (type === "shift_open") {
    const d = ShiftOpenData.safeParse(data);
    if (!d.success) {
      return NextResponse.json(
        { error: "invalid_data", detail: d.error.flatten() },
        { status: 400 }
      );
    }
  } else {
    return NextResponse.json({ error: "type_not_implemented" }, { status: 501 });
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(branch_id) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  // Duplicate guard for shift_open: only one report per (branch, date).
  // Ties to the unique partial index on daily_reports — we still check
  // here so we can return a friendly error with the existing row info
  // rather than a SQLITE_CONSTRAINT raw exception.
  if (type === "shift_open") {
    const existing = db.prepare(`
      SELECT r.id, r.user_id, r.created_at, u.display_name AS opener_name
      FROM daily_reports r JOIN users u ON r.user_id = u.id
      WHERE r.type = 'shift_open' AND r.branch_id = ? AND r.report_date = ?
    `).get(branch.id, report_date) as
      | { id: number; user_id: number; created_at: string; opener_name: string }
      | undefined;
    if (existing) {
      return NextResponse.json({
        error: "already_opened",
        existing: {
          id: existing.id,
          opener_name: existing.opener_name,
          created_at: existing.created_at
        }
      }, { status: 409 });
    }
  }

  const insertedAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO daily_reports (type, branch_id, user_id, report_date, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    type as DailyReportType,
    branch.id,
    user.id,
    report_date,
    JSON.stringify(data),
    insertedAt,
    insertedAt
  );
  const id = result.lastInsertRowid as number;

  // Build + push the Flex card to the branch staff group. Fire-and-forget
  // so a LINE API hiccup doesn't block the form submission.
  if (type === "shift_open") {
    const d = data as z.infer<typeof ShiftOpenData>;
    const flex = shiftOpenFlex({
      branchName: branch.name,
      reportDate: report_date,
      openerName: user.display_name,
      yesterdayClosingAmount: d.yesterday_closing_amount,
      morningDrawerAmount: d.morning_drawer_amount,
      // Normalize the optional note → string|null so the renderer
      // doesn't have to guard `undefined`.
      checklist: d.checklist.map((c) => ({
        label: c.label,
        checked: c.checked,
        note: c.note ?? null
      }))
    });
    notifyDailyReport(branch, flex).catch((e) =>
      console.error("notify daily-report error", e)
    );
  }

  return NextResponse.json({ ok: true, id });
}
