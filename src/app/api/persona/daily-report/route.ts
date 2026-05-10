import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch, type DailyReportType } from "@/lib/db";
import { shiftOpenFlex, notifyDailyReport } from "@/lib/line";

// POST /api/persona/daily-report
//
// Single endpoint for all 4 daily-report types:
//   shift_open        — เปิดกะ (Phase B)
//   shift_close       — ปิดกะ (Phase C — TODO)
//   readiness_1130    — รายงานความพร้อม รอบ 11:30 (Phase D — TODO)
//   readiness_1600    — รายงานความพร้อม รอบ 16:00 (Phase D — TODO)
//
// The body always carries `type` + `report_date` + `data` (a JSON blob
// that mirrors the form's field shape for that type). Server validates
// the shape per type, persists the row, and pushes a summary Flex card
// to the branch's staff group.

// Checklist is dynamic — admin can add/edit items at /admin/persona/checklist.
// We store the rendered label alongside the checked state so historical
// reports stay readable even after admin renames or deletes an item.
const ChecklistEntry = z.object({
  label: z.string().min(1).max(200),
  checked: z.boolean()
});
const ShiftOpenData = z.object({
  yesterday_closing_amount: z.number().min(0).max(10_000_000).nullable(),
  morning_drawer_amount: z.number().min(0).max(10_000_000).nullable(),
  checklist: z.array(ChecklistEntry).max(50)
});

const Body = z.object({
  type: z.enum(["shift_open", "shift_close", "readiness_1130", "readiness_1600"]),
  report_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  data: z.unknown()    // narrowed per-type below
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { type, report_date, data } = parsed.data;

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
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

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
      checklist: d.checklist
    });
    notifyDailyReport(branch, flex).catch((e) =>
      console.error("notify daily-report error", e)
    );
  }

  return NextResponse.json({ ok: true, id });
}
