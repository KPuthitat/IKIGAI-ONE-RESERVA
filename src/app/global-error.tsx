"use client";

// Top-level error boundary. Shown when something throws OUTSIDE the
// scope of a per-page error.tsx — including chunk-load errors that
// slip past ChunkErrorAutoReload's window listener (rare).
//
// Two purposes:
//   1. Replace the cryptic default "Application error: a client-side
//      exception has occurred" wall-of-text with friendly Thai copy.
//   2. Offer a "ลองอีกครั้ง" button that calls reset() — Next.js'
//      built-in retry hook — AND a hard reload as a second affordance.
//
// IMPORTANT: global-error.tsx MUST render <html><body> itself because
// it replaces the root layout when an error is thrown during the
// layout itself.

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error so we can investigate post-incident. digest is
    // a stable hash Next.js attaches to server errors — useful when
    // matching up against pm2 logs.
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
          background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "20px"
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 24,
            padding: "40px 32px",
            textAlign: "center"
          }}
        >
          <div style={{ fontSize: 60, marginBottom: 16 }}>🦉</div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              margin: "0 0 8px",
              color: "#fda4af"
            }}
          >
            อ๊ะ มีบางอย่างผิดพลาด
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "rgba(255,255,255,0.7)",
              margin: "0 0 24px"
            }}
          >
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
                padding: "10px 16px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.2)",
                background: "transparent",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
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
                padding: "10px 16px",
                borderRadius: 10,
                border: "none",
                background: "#fda4af",
                color: "#1a1a2e",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              รีเฟรชหน้า
            </button>
          </div>
          {error.digest && (
            <p
              style={{
                marginTop: 24,
                fontSize: 10,
                color: "rgba(255,255,255,0.3)",
                fontFamily: "monospace"
              }}
            >
              ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
