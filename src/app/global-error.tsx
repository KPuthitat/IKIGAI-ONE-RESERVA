"use client";

// Top-level error boundary. Shown when something throws OUTSIDE the
// scope of a per-page error.tsx — including chunk-load errors that
// slip past ChunkErrorAutoReload's window listener (rare).
//
// IMPORTANT: global-error.tsx MUST render <html><body> itself because
// it replaces the root layout when an error is thrown during the layout
// itself — which means the layout's next/font + globals.css are NOT in
// scope here. So we inline an @font-face for LINE Seed Sans TH (the
// woff2 files ship under /public/fonts/) and the IKIGAI CI palette
// (cream + brown #a06820 + ink #281a0e) so the page matches the brand
// instead of the old navy/pink default (owner 2026-06-10). The owl
// MASCOT png is the same brand asset used elsewhere.

import { useEffect } from "react";

const BRAND = "#a06820";
const INK = "#281a0e";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error.message, error.digest);
  }, [error]);

  return (
    <html lang="th">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #f7f1e6 0%, #efe3cf 100%)",
          color: INK,
          fontFamily: "'LINE Seed Sans TH', ui-sans-serif, system-ui, sans-serif",
          padding: "20px"
        }}
      >
        <style>{`
          @font-face {
            font-family: 'LINE Seed Sans TH';
            src: url('/fonts/LINESeedSansTH-Regular.woff2') format('woff2');
            font-weight: 400; font-display: swap;
          }
          @font-face {
            font-family: 'LINE Seed Sans TH';
            src: url('/fonts/LINESeedSansTH-Bold.woff2') format('woff2');
            font-weight: 700; font-display: swap;
          }
        `}</style>
        <div
          style={{
            maxWidth: 460,
            width: "100%",
            background: "#fffdf9",
            border: "1px solid #e7d9c2",
            boxShadow: "0 8px 30px rgba(40,26,14,0.10)",
            borderRadius: 24,
            padding: "36px 32px",
            textAlign: "center"
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/owl-mascot.png"
            alt=""
            width={76}
            height={76}
            style={{ display: "block", margin: "0 auto 14px" }}
          />
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 8px", color: INK }}>
            อ๊ะ มีบางอย่างผิดพลาด
          </h1>
          <p style={{ fontSize: 14, color: "#6b5c49", margin: "0 0 24px", lineHeight: 1.6 }}>
            น้องฮูกขออภัย — โหลดหน้านี้ไม่สำเร็จ
            <br />
            ลองอีกครั้งหรือรีเฟรชหน้านี้ดูครับ
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                flex: 1,
                padding: "11px 16px",
                borderRadius: 12,
                border: `1px solid ${BRAND}`,
                background: "transparent",
                color: BRAND,
                fontSize: 14,
                fontWeight: 700,
                fontFamily: "inherit",
                cursor: "pointer"
              }}
            >
              ลองอีกครั้ง
            </button>
            <button
              type="button"
              onClick={() => {
                try { sessionStorage.removeItem("ikigai-chunk-reload-ts"); } catch {}
                window.location.reload();
              }}
              style={{
                flex: 1,
                padding: "11px 16px",
                borderRadius: 12,
                border: "none",
                background: BRAND,
                color: "#fff",
                fontSize: 14,
                fontWeight: 700,
                fontFamily: "inherit",
                cursor: "pointer"
              }}
            >
              รีเฟรชหน้า
            </button>
          </div>
          {error.digest && (
            <p style={{ marginTop: 22, fontSize: 10, color: "#b3a892", fontFamily: "monospace" }}>
              ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
