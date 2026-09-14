import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePayrollAccess } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { isDfBranch, setDoctorWhtRate, eligibleDoctors, clearImportedMonth, clearImportedDay } from "@/lib/df-db";
import { buildDfMonthRounds, saveDfRound, payDfRound, revertDfRound, dfDayDetail, dfDayDoctorSplit } from "@/lib/df-rounds";

// Weekly Doctor-Fee rounds, revshare-style month view (owner 2026-09-13). Clinic
// branch only; payroll access. GET returns the month (daily rows grouped into
// Mon–Sun rounds) + doctors. POST is PIN-gated: save (draft), pay (transfer +
// post accounta), revert, or set a doctor's WHT rate — and returns the refreshed
// month view.

export const dynamic = "force-dynamic";
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

function ctx() {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isDfBranch(branchId) };
}

function pinGate(userId: number, pin: string): NextResponse | null {
  const status = verifyAdminPin(userId, pin);
  if (status.ok) return null;
  return NextResponse.json({ error: status.reason }, { status: status.reason === "no_pin" ? 400 : 403 });
}

function bkkNow(): { year: number; month: number } {
  const d = new Date(Date.now() + 7 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function GET(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  // Drill-down: one day's source invoice lines.
  const day = sp.get("day") ?? "";
  if (dateRe.test(day)) {
    return NextResponse.json({ ok: true, day, lines: dfDayDetail(branchId!, day), doctors: dfDayDoctorSplit(branchId!, day) });
  }
  const now = bkkNow();
  const year = Number(sp.get("year")) || now.year;
  const month = Number(sp.get("month")) || now.month;
  return NextResponse.json({ ok: true, view: buildDfMonthRounds(branchId!, year, month), doctors: eligibleDoctors() });
}

const PostZ = z.object({
  action: z.enum(["save", "pay", "revert", "set_wht", "clear_month", "clear_day"]),
  week: z.string().optional(),
  year: z.number().int().optional(),
  month: z.number().int().min(1).max(12).optional(),
  note: z.string().max(300).optional(),
  userId: z.number().int().positive().optional(),
  rate: z.number().min(0).max(1).optional(),
  pin: z.string()
});

export async function POST(req: Request) {
  const { user, branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const parsed = PostZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  const gate = pinGate(user.id, d.pin); if (gate) return gate;
  const now = bkkNow();
  const year = d.year || now.year;
  const month = d.month || now.month;

  try {
    if (d.action === "set_wht") {
      if (!d.userId || d.rate == null) return NextResponse.json({ error: "bad_params" }, { status: 400 });
      // Only an eligible (clinic) doctor may have a DF WHT rate set — never an
      // arbitrary user id.
      if (!eligibleDoctors().some((doc) => doc.user_id === d.userId)) {
        return NextResponse.json({ error: "not_a_doctor" }, { status: 400 });
      }
      setDoctorWhtRate(d.userId, d.rate);
      return NextResponse.json({ ok: true, view: buildDfMonthRounds(branchId!, year, month), doctors: eligibleDoctors() });
    }
    if (d.action === "clear_month") {
      const removed = clearImportedMonth(branchId!, year, month);
      return NextResponse.json({ ok: true, removed, view: buildDfMonthRounds(branchId!, year, month), doctors: eligibleDoctors() });
    }
    // clear_day carries the target date in `week` (an ISO YYYY-MM-DD).
    if (d.action === "clear_day") {
      if (!d.week || !dateRe.test(d.week)) return NextResponse.json({ error: "bad_day" }, { status: 400 });
      const removed = clearImportedDay(branchId!, d.week);
      return NextResponse.json({ ok: true, removed, view: buildDfMonthRounds(branchId!, year, month), doctors: eligibleDoctors() });
    }
    if (!d.week || !dateRe.test(d.week)) return NextResponse.json({ error: "bad_week" }, { status: 400 });
    if (d.action === "save") saveDfRound(branchId!, d.week, user.id, d.note);
    else if (d.action === "pay") payDfRound(branchId!, d.week, user.id);
    else revertDfRound(branchId!, d.week);
    return NextResponse.json({ ok: true, view: buildDfMonthRounds(branchId!, year, month), doctors: eligibleDoctors() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 400 });
  }
}
