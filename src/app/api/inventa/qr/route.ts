import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getSessionUser } from "@/lib/auth";

// GET /api/inventa/qr?data=<text>&size=<px>
//   Server-side QR generation (owner R2 2026-06-07). Replaces the old
//   client-side CDN loader (window.QRCode), which silently failed when
//   the CDN was blocked/offline. Generating here means QR labels work
//   regardless of the browser network / CSP, and each <img> URL prints +
//   downloads like any normal image.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const url = new URL(req.url);
  const data = (url.searchParams.get("data") ?? "").trim();
  if (!data || data.length > 512) {
    return NextResponse.json({ error: "invalid_data" }, { status: 400 });
  }
  // Clamp the size to a sane print range.
  const sizeRaw = Number(url.searchParams.get("size"));
  const size = Number.isFinite(sizeRaw) ? Math.min(600, Math.max(80, Math.round(sizeRaw))) : 256;

  try {
    const png = await QRCode.toBuffer(data, {
      type: "png", errorCorrectionLevel: "M", margin: 1, width: size
    });
    // Copy into a plain ArrayBuffer-backed Uint8Array so the body type
    // satisfies BodyInit (Buffer.buffer is ArrayBufferLike).
    const body = new Uint8Array(png);
    return new Response(body, {
      headers: {
        "Content-Type": "image/png",
        // Codes are stable per item → let the browser cache them.
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="qr-${encodeURIComponent(data).slice(0, 40)}.png"`
      }
    });
  } catch {
    return NextResponse.json({ error: "qr_failed" }, { status: 500 });
  }
}
