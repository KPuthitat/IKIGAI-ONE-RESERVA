import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getBranchSettings, setBranchSettings } from "@/lib/delivera/db";
import { saveDeliveraImage, deleteDeliveraImage, DELIVERA_IMAGE_ALLOWED_MIME, DELIVERA_IMAGE_MAX_BYTES } from "@/lib/delivera/images";

// Admin (session): upload/replace (POST) or remove (DELETE) the branch's own
// PromptPay QR image. When set it takes precedence over the generated dynamic QR.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > DELIVERA_IMAGE_MAX_BYTES) return NextResponse.json({ error: "too_large", message: "ไฟล์เกิน 5 MB" }, { status: 400 });
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!DELIVERA_IMAGE_ALLOWED_MIME.has(mime)) return NextResponse.json({ error: "bad_type", message: "รองรับเฉพาะรูป PNG / JPG / WebP" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const url = await saveDeliveraImage(buf, mime, `qr-${user.activeBranchId}`);
  await deleteDeliveraImage(getBranchSettings(user.activeBranchId).promptpay_qr_url);
  setBranchSettings(user.activeBranchId, { promptpay_qr_url: url });
  return NextResponse.json({ ok: true, promptpay_qr_url: url });
}

export async function DELETE() {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  await deleteDeliveraImage(getBranchSettings(user.activeBranchId).promptpay_qr_url);
  setBranchSettings(user.activeBranchId, { promptpay_qr_url: null });
  return NextResponse.json({ ok: true });
}
