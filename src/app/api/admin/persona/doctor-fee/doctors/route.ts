import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePayrollAccess } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { isDfBranch, eligibleDoctors, setDoctorWhtRate, setDoctorGuarantee } from "@/lib/df-db";

// Per-doctor Doctor-Fee settings (owner 2026-09-13): the WHT rate for the weekly
// payout and the guarantee (การันตี) arrangement. Clinic branch only; payroll
// access. GET lists the eligible doctors + their settings; POST is PIN-gated and
// updates one doctor, returning the refreshed list.

export const dynamic = "force-dynamic";

function ctx() {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isDfBranch(branchId) };
}

export function GET() {
  const { ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  return NextResponse.json({ ok: true, doctors: eligibleDoctors() });
}

const PostZ = z.object({
  userId: z.number().int().positive(),
  wht_rate: z.number().min(0).max(1).optional(),
  guarantee_enabled: z.boolean().optional(),
  guarantee_rate: z.number().min(0).max(100000).optional(),   // baht per hour
  guarantee_wht: z.boolean().optional(),
  pin: z.string()
});

export async function POST(req: Request) {
  const { user, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const parsed = PostZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const status = verifyAdminPin(user.id, d.pin);
  if (!status.ok) return NextResponse.json({ error: status.reason }, { status: status.reason === "no_pin" ? 400 : 403 });

  // Only an eligible (clinic) doctor may have DF settings — never an arbitrary id.
  const doc = eligibleDoctors().find((x) => x.user_id === d.userId);
  if (!doc) return NextResponse.json({ error: "not_a_doctor" }, { status: 400 });

  try {
    if (d.wht_rate != null) setDoctorWhtRate(d.userId, d.wht_rate);
    // Guarantee is set as a unit — take current values as the base and apply only
    // the fields that were sent, so a partial update never clobbers the rest.
    if (d.guarantee_enabled != null || d.guarantee_rate != null || d.guarantee_wht != null) {
      setDoctorGuarantee(d.userId, {
        enabled: d.guarantee_enabled ?? doc.guarantee_enabled,
        rate: d.guarantee_rate ?? doc.guarantee_rate,
        wht: d.guarantee_wht ?? doc.guarantee_wht
      });
    }
    return NextResponse.json({ ok: true, doctors: eligibleDoctors() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 400 });
  }
}
