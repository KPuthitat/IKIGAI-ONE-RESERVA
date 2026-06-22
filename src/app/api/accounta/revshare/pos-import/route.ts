import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isRevshareBranch } from "@/lib/revshare-db";
import { parsePosBuffer } from "@/lib/revshare-pos";

// POS .xlsx upload → parse → return a PREVIEW only (categories + date range).
// The admin then picks categories + base on the client and creates a round via
// /api/accounta/revshare/rounds. Nothing is written here.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) {
    return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  }
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > 8 * 1024 * 1024) return NextResponse.json({ error: "file_too_large" }, { status: 400 });
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = parsePosBuffer(buf);
    if (!parsed.categories.length) {
      return NextResponse.json({ error: "no_categories", message: "ไม่พบหมวดสินค้าในไฟล์ — ตรวจรูปแบบไฟล์ POS" }, { status: 422 });
    }
    return NextResponse.json({ ok: true, filename: file.name, ...parsed });
  } catch (e) {
    return NextResponse.json({ error: "parse_failed", message: (e as Error).message }, { status: 422 });
  }
}
