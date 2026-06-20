import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { disconnectDrive } from "@/lib/google-drive";

// POST /api/accounta/drive/[branchId]/disconnect — forget the branch's
// Google connection (refresh token + folder). super_admin only.
export async function POST(_req: Request, { params }: { params: { branchId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const branchId = Number(params.branchId);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
  }
  disconnectDrive(branchId, user.id);
  return NextResponse.json({ ok: true });
}
