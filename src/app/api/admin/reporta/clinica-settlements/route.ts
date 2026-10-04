import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { clinicaCashChannels, listSettlements, resolveSettlement } from "@/lib/clinica-db";
import { autopostClinicaIfEnabled } from "@/lib/clinica-accounta";
import { getDb } from "@/lib/db";

// CLINICA receivable settlements — late payments (insurer / company) that an
// import noticed. A reporta.manage user confirms the real date + landing channel,
// or dismisses a false alarm. Owner 2026-10-04.

export const dynamic = "force-dynamic";

export async function GET() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  return NextResponse.json({ ok: true, items: listSettlements(branchId, "pending"), channels: clinicaCashChannels(branchId) });
}

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const b = await req.json().catch(() => null) as { id?: unknown; action?: unknown; settledDate?: unknown; channel?: unknown } | null;
  const id = Number(b?.id);
  if (!b || !Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  const r = b.action === "dismiss"
    ? resolveSettlement(branchId, id, user.id, { action: "dismiss" })
    : b.action === "confirm"
      ? resolveSettlement(branchId, id, user.id, { action: "confirm", settledDate: String(b.settledDate ?? ""), channel: String(b.channel ?? "") })
      : { ok: false, error: "bad_action" };
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "not_found" ? 404 : 400 });
  // The confirmed date / channel changes that bill's receivable rows in ACCOUNTA.
  const bill = getDb().prepare("SELECT bill_date d FROM clinica_settlements WHERE id = ? AND branch_id = ?").get(id, branchId) as { d: string } | undefined;
  const accounta = bill?.d ? autopostClinicaIfEnabled(branchId, user.id, { from: bill.d, to: bill.d }) : { posted: null };
  return NextResponse.json({ ok: true, accounta });
}
