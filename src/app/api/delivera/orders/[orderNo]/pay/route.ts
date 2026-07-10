import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { hashLineUserId } from "@/lib/insigna/hash";
import { PayBody } from "@/lib/delivera/validate";
import { customerLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { getOrderByNo } from "@/lib/delivera/orders";
import { startPayment, PaymentError } from "@/lib/delivera/payment";

// Public (customer LIFF): choose how to pay an order. COD confirms straight to
// the kitchen; PromptPay returns the QR (payload + rendered image) for the exact
// order total. Ownership is proven via the LIFF token → customer_hash match.
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { orderNo: string } }) {
  const parsed = PayBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  if (!customerLineReady()) return NextResponse.json({ error: "delivera_line_not_configured" }, { status: 503 });

  const prof = await verifyAccessToken(parsed.data.access_token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });

  const order = getOrderByNo(params.orderNo);
  if (!order || order.customer_hash !== hashLineUserId(prof.userId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const r = startPayment(order, parsed.data.method);
    if (r.method === "cod") {
      return NextResponse.json({ ok: true, method: "cod", status: r.status, total: r.total });
    }
    // Generated dynamic QR (data URL) when we have a number; else the store's
    // uploaded static QR image url. TrackClient renders whichever is present.
    const qrImage = r.qrPayload ? await QRCode.toDataURL(r.qrPayload, { margin: 1, width: 320 }) : null;
    return NextResponse.json({
      ok: true, method: "promptpay", status: r.status, total: r.total,
      qr_payload: r.qrPayload, qr_image: qrImage, qr_image_url: r.qrImageUrl
    });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.code, detail: e.detail }, { status: 400 });
    return NextResponse.json({ error: "pay_failed", message: (e as Error).message }, { status: 400 });
  }
}
