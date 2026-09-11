import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePayrollAccess } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { isDfBranch, setDoctorWhtRate, eligibleDoctors } from "@/lib/df-db";
import {
  previewDfRound, listRounds, listRoundLines, saveDfRound, payDfRound, revertDfRound
} from "@/lib/df-rounds";

// Weekly Doctor-Fee rounds (owner 2026-09-11). Clinic branch only; payroll
// access. GET returns the preview for a week + the recent-rounds list + doctors.
// POST is PIN-gated: save (draft), pay (transfer + post accounta), revert, or
// set a doctor's WHT rate.

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

export function GET(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const week = new URL(req.url).searchParams.get("week") ?? "";
  const weekInput = dateRe.test(week) ? week : new Date().toISOString().slice(0, 10);
  const preview = previewDfRound(branchId!, weekInput);
  const lines = preview.round ? listRoundLines(preview.round.id) : [];
  return NextResponse.json({
    ok: true, preview, lines, rounds: listRounds(branchId!), doctors: eligibleDoctors()
  });
}

const PostZ = z.object({
  action: z.enum(["save", "pay", "revert", "set_wht"]),
  week: z.string().optional(),
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

  try {
    if (d.action === "set_wht") {
      if (!d.userId || d.rate == null) return NextResponse.json({ error: "bad_params" }, { status: 400 });
      // Only an eligible (clinic) doctor may have a DF WHT rate set — never an
      // arbitrary user id.
      if (!eligibleDoctors().some((doc) => doc.user_id === d.userId)) {
        return NextResponse.json({ error: "not_a_doctor" }, { status: 400 });
      }
      setDoctorWhtRate(d.userId, d.rate);
      return NextResponse.json({ ok: true, doctors: eligibleDoctors() });
    }
    if (!d.week || !dateRe.test(d.week)) return NextResponse.json({ error: "bad_week" }, { status: 400 });
    const round =
      d.action === "save" ? saveDfRound(branchId!, d.week, user.id, d.note)
      : d.action === "pay" ? payDfRound(branchId!, d.week, user.id)
      : revertDfRound(branchId!, d.week);
    const preview = previewDfRound(branchId!, d.week);
    const lines = preview.round ? listRoundLines(preview.round.id) : [];
    return NextResponse.json({ ok: true, round, preview, lines, rounds: listRounds(branchId!) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 400 });
  }
}
