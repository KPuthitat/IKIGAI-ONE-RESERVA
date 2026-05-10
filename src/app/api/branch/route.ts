import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, setActiveBranch, userHasBranch } from "@/lib/auth";

// POST /api/branch — set the caller's session active branch.
// Used by both admin (BranchSwitcher in admin layouts) and staff
// (BranchPicker after login + topbar "เปลี่ยนสาขา" link). The role
// gate is the same for both: caller must already be assigned to that
// branch via user_branches.

const Body = z.object({ branch_id: z.number().int() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "ยังไม่ได้เข้าระบบ" }, { status: 401 });
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  if (!userHasBranch(user, parsed.data.branch_id)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าสาขานี้" }, { status: 403 });
  }
  setActiveBranch(parsed.data.branch_id);
  return NextResponse.json({ ok: true });
}
