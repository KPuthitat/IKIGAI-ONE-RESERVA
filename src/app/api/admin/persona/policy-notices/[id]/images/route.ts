import { NextResponse } from "next/server";
import { logPersonaAction } from "@/lib/db";
import { addImage, MAX_IMAGE_BYTES, PolicyError, removeImage } from "@/lib/policy-notices";
import { adminGate, errorResponse } from "@/lib/policy-notices-api";

// POST multipart {file} → attach one picture to a notice that is still being drafted
// DELETE ?image=<id>   → remove one

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = adminGate(); if ("error" in g) return g.error;
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "bad_form", message: "ส่งไฟล์ไม่สำเร็จ" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "no_file", message: "ไม่พบไฟล์" }, { status: 400 });
  try {
    if (file.size > MAX_IMAGE_BYTES) throw new PolicyError("image_too_large");
    const id = addImage(Number(params.id), Buffer.from(await file.arrayBuffer()), file.type);
    logPersonaAction(g.user.id, "policy_notice_image_add", Number(params.id));
    return NextResponse.json({ ok: true, id });
  } catch (e) { return errorResponse(e); }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const g = adminGate(); if ("error" in g) return g.error;
  const imageId = Number(new URL(req.url).searchParams.get("image"));
  if (!Number.isInteger(imageId) || imageId <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  try {
    removeImage(Number(params.id), imageId);
    logPersonaAction(g.user.id, "policy_notice_image_remove", Number(params.id));
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
