"use client";

import { useEffect, useState } from "react";

// Render a string as a QR image. qrcode is imported dynamically so it stays out
// of the main bundle (same pattern as ClockQrClient). If generation fails the
// component renders nothing — callers always show the text code as a fallback.
export default function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDataUrl(null);   // clear the old QR immediately so a stale code is never shown
    (async () => {
      try {
        const QR = (await import("qrcode")).default;
        const url = await QR.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: "M" });
        if (alive) setDataUrl(url);
      } catch {
        /* fallback: the text code shown by the caller is enough */
      }
    })();
    return () => { alive = false; };
  }, [value, size]);

  if (!dataUrl) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={dataUrl} alt={`QR ${value}`} width={size} height={size}
      className="mx-auto rounded-lg" style={{ width: size, height: "auto" }} />
  );
}
