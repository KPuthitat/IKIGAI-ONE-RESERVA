import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Branch, type DailyReportType } from "@/lib/db";
import {
  shiftOpenFlex,
  shiftCloseFlex,
  readinessFlex,
  notifyToStaffGroup
} from "@/lib/line";

// POST /api/persona/daily-report/[id]/resend-notification
//
// Manual fallback when the auto-push at /api/persona/daily-report
// didn't reach the LINE group (token misconfigured, group not yet
// joined, transient LINE outage, etc.). Anyone who can view the
// report (staff at the branch, branch admin, super_admin) can hit
// this; the endpoint rebuilds the Flex card from the stored row and
// re-pushes via the same notifyToStaffGroup path the auto-flow uses.
//
// We do NOT touch the daily_reports row — re-sending a notification
// doesn't constitute a "revision" (no isRevision flag flip). Each
// resend is a fresh push.
//
// Auth: caller must have the branch in their session.branches (staff
// at the branch, branch admin, or super_admin). Defense-in-depth so
// a curious user can't trigger pushes for branches they shouldn't see.

type ChecklistEntry = {
  label: string;
  checked: boolean;
  note?: string | null;
  is_child?: boolean;
};

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT r.id, r.type, r.branch_id, r.user_id, r.report_date, r.data,
           r.replaces_id, r.superseded_at,
           u.display_name AS opener_name
    FROM daily_reports r
    JOIN users u ON r.user_id = u.id
    WHERE r.id = ?
  `).get(id) as
    | {
        id: number;
        type: DailyReportType;
        branch_id: number;
        user_id: number;
        report_date: string;
        data: string;
        replaces_id: number | null;
        superseded_at: string | null;
        opener_name: string;
      }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!userHasBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(row.branch_id) as Branch | undefined;
  if (!branch) {
    return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data);
  } catch {
    return NextResponse.json({ error: "corrupt_data" }, { status: 500 });
  }

  // isRevision flag mirrors the auto-flow — true when this row chains
  // off a previously-superseded row. Lets the Flex header carry the
  // "ฉบับแก้ไข" badge consistently with what was originally sent.
  const isRevision = row.replaces_id != null;

  // Shared normalizer — matches the one in the POST route.
  const normalizeChecklist = (items: ChecklistEntry[]) =>
    items.map((c) => ({
      label: c.label,
      checked: c.checked,
      note: c.note ?? null,
      is_child: !!c.is_child
    }));

  let flex;
  if (row.type === "shift_open") {
    const d = data as {
      yesterday_closing_amount: number | null;
      morning_drawer_amount: number | null;
      checklist: ChecklistEntry[];
    };
    flex = shiftOpenFlex({
      branchName: branch.name,
      reportDate: row.report_date,
      openerName: row.opener_name,
      yesterdayClosingAmount: d.yesterday_closing_amount,
      morningDrawerAmount: d.morning_drawer_amount,
      checklist: normalizeChecklist(d.checklist ?? []),
      isRevision,
      headerColor: branch.brand_color
    });
  } else if (row.type === "shift_close") {
    const d = data as {
      closing_drawer_amount: number | null;
      checklist: ChecklistEntry[];
    };
    flex = shiftCloseFlex({
      branchName: branch.name,
      reportDate: row.report_date,
      closerName: row.opener_name,
      closingDrawerAmount: d.closing_drawer_amount,
      checklist: normalizeChecklist(d.checklist ?? []),
      isRevision,
      headerColor: branch.brand_color
    });
  } else {
    // readiness_1130 / readiness_1600
    const d = data as { checklist: ChecklistEntry[] };
    const isMorning = row.type === "readiness_1130";
    flex = readinessFlex({
      branchName: branch.name,
      reportDate: row.report_date,
      reporterName: row.opener_name,
      slotLabel: isMorning ? "รอบเช้า" : "รอบบ่าย",
      slotTime: isMorning
        ? branch.readiness_morning_time
        : branch.readiness_afternoon_time,
      checklist: normalizeChecklist(d.checklist ?? []),
      isRevision,
      headerColor: branch.brand_color
    });
  }

  // Unlike the auto-flow we await the push — caller wants to know
  // whether the resend actually succeeded so the UI can show
  // success/fail toast. notifyToStaffGroup throws on hard failures
  // (e.g. invalid token), so a thrown error surfaces as 500 below.
  try {
    await notifyToStaffGroup(branch, flex, "global");
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("daily-report resend-notification failed", e);
    return NextResponse.json(
      { error: "push_failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
