import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { isSalesaBranch, clearDay } from "@/lib/salesa-db";

// Delete one day's imported sales + menu (owner 2026-09-16: เผื่อกรณีนำเข้าผิด
// ให้ลบแล้วนำเข้าใหม่). Re-importing a file overwrites in place, so this is only
// for removing a wrong day entirely. Admin/หัวหน้างาน (reporta.manage) only.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({ date: z.string().regex(ISO) });

export async function POST(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return NextResponse.json({ error: "no_branch" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const removed = clearDay(branchId, parsed.data.date);
  return NextResponse.json({ ok: true, removed });
}
