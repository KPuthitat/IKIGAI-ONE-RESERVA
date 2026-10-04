import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { clinicaPostStatus, postClinicaToAccounta, setClinicaAutopost } from "@/lib/clinica-accounta";

// CLINICA → ACCOUNTA posting switch (owner 2026-10-04). GET = status; POST =
// {action: 'enable' | 'repost' | 'disable'}. Writing income rows needs ACCOUNTA
// access as well as the clinic report access.

export const dynamic = "force-dynamic";

export async function GET() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  return NextResponse.json({ ok: true, status: clinicaPostStatus(branchId) });
}

export async function POST(req: Request) {
  requirePermission("reporta.manage");
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const b = await req.json().catch(() => null) as { action?: unknown } | null;
  try {
    if (b?.action === "disable") {
      setClinicaAutopost(branchId, false);
      return NextResponse.json({ ok: true, status: clinicaPostStatus(branchId) });
    }
    if (b?.action === "enable" || b?.action === "repost") {
      const posted = postClinicaToAccounta(branchId, user.id);
      if (b.action === "enable") setClinicaAutopost(branchId, true);   // only once the first post worked
      return NextResponse.json({ ok: true, posted, status: clinicaPostStatus(branchId) });
    }
  } catch (e) {
    return NextResponse.json({ error: "post_failed", message: `ส่งยอดเข้า ACCOUNTA ไม่สำเร็จ: ${(e as Error).message}` }, { status: 500 });
  }
  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
