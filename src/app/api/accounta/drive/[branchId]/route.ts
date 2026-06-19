import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { setDriveConfig } from "@/lib/google-drive";

// POST /api/accounta/drive/[branchId] — save a branch's Drive config.
// super_admin only: it stores a service-account credential. saJson:
// omit/null = keep the stored key, "" = clear it, JSON string = replace.
const Body = z.object({
  enabled: z.boolean(),
  saJson: z.string().max(20000).nullable().optional(),
  rootFolderId: z.string().max(200).nullable().optional()
});

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

  const r = setDriveConfig({
    branchId,
    enabled: parsed.data.enabled,
    saJson: parsed.data.saJson ?? null,
    rootFolderId: parsed.data.rootFolderId ?? null,
    updatedBy: user.id
  });
  if (!r.ok) return NextResponse.json({ error: "bad_config", message: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
