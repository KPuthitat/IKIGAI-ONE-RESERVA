import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { testDriveConfig } from "@/lib/google-drive";

// POST /api/accounta/drive/[branchId]/test — verify the branch's Drive
// credentials + folder access without uploading a real bill. super_admin
// only (touches the stored credential).
export async function POST(_req: Request, { params }: { params: { branchId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const branchId = Number(params.branchId);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
  }
  const r = await testDriveConfig(branchId);
  return NextResponse.json(r.ok ? { ok: true } : { ok: false, message: r.error });
}
