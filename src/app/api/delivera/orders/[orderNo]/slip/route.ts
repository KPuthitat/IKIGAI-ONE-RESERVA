import { NextResponse } from "next/server";
import { SlipBody } from "@/lib/delivera/validate";
import { customerLineReady } from "@/lib/delivera/env";
import { verifyAccessToken } from "@/lib/delivera/line";
import { submitSlip, PaymentError } from "@/lib/delivera/payment";

// Public (customer LIFF): attach a payment slip to a PromptPay order. Verified
// automatically by SlipOK when configured (amount match + trans-ref de-dupe),
// otherwise queued as pending_verify for manual confirmation on the kitchen board.
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { orderNo: string } }) {
  const parsed = SlipBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  if (!customerLineReady()) return NextResponse.json({ error: "delivera_line_not_configured" }, { status: 503 });

  const prof = await verifyAccessToken(parsed.data.access_token);
  if (!prof) return NextResponse.json({ error: "line_auth_failed" }, { status: 401 });

  try {
    const r = await submitSlip({
      orderNo: params.orderNo, lineUserId: prof.userId,
      slipData: parsed.data.slip_data ?? null, slipImageUrl: parsed.data.slip_image_url ?? null
    });
    return NextResponse.json({ ok: true, pay_status: r.payStatus, verified: r.verified });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.code, detail: e.detail }, { status: 400 });
    return NextResponse.json({ error: "slip_failed", message: (e as Error).message }, { status: 400 });
  }
}
