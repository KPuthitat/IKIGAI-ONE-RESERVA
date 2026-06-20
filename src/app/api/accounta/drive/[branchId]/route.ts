import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { setDriveEnabled } from "@/lib/google-drive";

// POST /api/accounta/drive/[branchId] — toggle a branch's Drive sync on/off.
// The Google connection itself is managed by the OAuth flow (start/callback).
// super_admin only.
const Body = z.object({ enabled: z.boolean() });

export async function POST(req: Request, { params }: { params: { branchId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const branchId = Number(params.branchId);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  setDriveEnabled(branchId, parsed.data.enabled, user.id);
  return NextResponse.json({ ok: true });
}
