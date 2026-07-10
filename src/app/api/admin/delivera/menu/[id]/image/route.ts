import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getMenuItem, updateMenuItem } from "@/lib/delivera/orders";
import { saveDeliveraImage, deleteDeliveraImage, DELIVERA_IMAGE_ALLOWED_MIME, DELIVERA_IMAGE_MAX_BYTES } from "@/lib/delivera/images";

// Admin (session): upload/replace (POST) or remove (DELETE) a menu item's photo.
// Branch-scoped via the lib. Stores the image under data/delivera/images and
// saves its public url on the item.
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  const item = getMenuItem(id, user.activeBranchId);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > DELIVERA_IMAGE_MAX_BYTES) return NextResponse.json({ error: "too_large", message: "ไฟล์เกิน 5 MB" }, { status: 400 });
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!DELIVERA_IMAGE_ALLOWED_MIME.has(mime)) return NextResponse.json({ error: "bad_type", message: "รองรับเฉพาะรูป PNG / JPG / WebP" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const url = await saveDeliveraImage(buf, mime, `menu-${id}`);
  await deleteDeliveraImage(item.image_url);   // clean up the previous photo
  updateMenuItem(id, user.activeBranchId, { image_url: url });
  return NextResponse.json({ ok: true, image_url: url });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  const item = getMenuItem(id, user.activeBranchId);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await deleteDeliveraImage(item.image_url);
  updateMenuItem(id, user.activeBranchId, { image_url: null });
  return NextResponse.json({ ok: true });
}
