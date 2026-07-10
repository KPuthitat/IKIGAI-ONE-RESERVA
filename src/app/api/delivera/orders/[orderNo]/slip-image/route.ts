import { NextResponse } from "next/server";
import { customerLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { submitSlip, PaymentError } from "@/lib/delivera/payment";
import { saveDeliveraImage, DELIVERA_IMAGE_ALLOWED_MIME, DELIVERA_IMAGE_MAX_BYTES } from "@/lib/delivera/images";

// Public (customer LIFF): upload a PromptPay transfer slip image (multipart:
// access_token + file). Stored under data/delivera/images then attached to the
// order via submitSlip → verified by SlipOK when configured, else pending_verify
// with the image visible on the kitchen board.
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { orderNo: string } }) {
  if (!customerLineReady()) return NextResponse.json({ error: "delivera_line_not_configured" }, { status: 503 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }
  const token = String(form.get("access_token") || "");
  const prof = await verifyAccessToken(token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > DELIVERA_IMAGE_MAX_BYTES) return NextResponse.json({ error: "too_large", message: "ไฟล์เกิน 5 MB" }, { status: 400 });
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!DELIVERA_IMAGE_ALLOWED_MIME.has(mime)) return NextResponse.json({ error: "bad_type", message: "รองรับเฉพาะรูป PNG / JPG / WebP" }, { status: 400 });

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const url = await saveDeliveraImage(buf, mime, `slip-${params.orderNo}`);
    const r = await submitSlip({ orderNo: params.orderNo, lineUserId: prof.userId, slipImageUrl: url });
    return NextResponse.json({ ok: true, pay_status: r.payStatus, verified: r.verified });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.code, detail: e.detail }, { status: 400 });
    return NextResponse.json({ error: "slip_failed", message: (e as Error).message }, { status: 400 });
  }
}
