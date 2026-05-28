// Standalone maintenance page generator.
//
// Why this exists: when Next.js is mid-deploy (or crashed), the
// in-page MaintenanceBanner is useless — the server that would
// render it is exactly the server that's down. To show users
// SOMETHING during that 1–2 min gap, we generate a fully
// self-contained HTML file that Nginx serves via `error_page 502
// 503 504 = @maintenance` whenever the upstream is unreachable.
//
// "Self-contained" means: the page embeds the owl mascot + LINE
// Seed Sans TH font as base64 data URIs inside the HTML. No
// external assets to fetch — even if the static folder is mid-
// rebuild, the page renders perfectly. Page weight is ~150KB but
// that's a one-time download per browser session (cached after).
//
// The HTML has <meta http-equiv="refresh" content="15"> so once
// Next.js boots back, the browser auto-reloads into the real app.
//
// Generation flow:
//   1. Admin saves a message at /admin/system-settings
//   2. POST handler calls writeMaintenancePage(message)
//   3. Function writes /var/www/maintenance/index.html (prod) or
//      ./maintenance-out/index.html (local dev)
//   4. Nginx already configured to serve that file on upstream
//      errors → no further action needed at deploy time

import fs from "node:fs";
import path from "node:path";

// Module-level cache. Reading these 100KB binary files on every
// generation is wasteful — the contents never change between
// process restarts. First call populates the cache; subsequent
// calls return the cached base64 string.
let cachedOwl: string | null = null;
let cachedFontBold: string | null = null;
let cachedFontRegular: string | null = null;

function readAssetBase64(relPath: string): string {
  try {
    const filePath = path.join(process.cwd(), "public", relPath);
    return fs.readFileSync(filePath).toString("base64");
  } catch {
    // Asset missing (e.g. test environment, or path drift) — return
    // empty string so the generator still produces valid HTML, just
    // without the styled font / image. Graceful degradation.
    return "";
  }
}

function getOwlB64(): string {
  if (cachedOwl === null) cachedOwl = readAssetBase64("owl-mascot.png");
  return cachedOwl;
}

function getFontBoldB64(): string {
  if (cachedFontBold === null) {
    cachedFontBold = readAssetBase64("fonts/LINESeedSansTH-Bold.woff2");
  }
  return cachedFontBold;
}

function getFontRegularB64(): string {
  if (cachedFontRegular === null) {
    cachedFontRegular = readAssetBase64("fonts/LINESeedSansTH-Regular.woff2");
  }
  return cachedFontRegular;
}

/** HTML-escape a user-controlled string. The admin's message is
 *  rendered as text inside a <div>, but escaping prevents anyone
 *  with the system-settings page open from sneaking in a <script>. */
function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#x27;"
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

/** Fallback used when the admin hasn't authored a message yet. */
const DEFAULT_MESSAGE =
  "ขอเวลาสักครู่ จะกลับมาใช้งานได้ภายใน 1-2 นาทีครับ";

export function generateMaintenanceHtml(
  message: string | null | undefined
): string {
  const owl = getOwlB64();
  const fontBold = getFontBoldB64();
  const fontRegular = getFontRegularB64();
  const msg = (message ?? "").trim() || DEFAULT_MESSAGE;

  // Inline everything so the file is self-contained. Fonts as base64
  // data URIs inside @font-face, image as data URI on <img src>. The
  // page can render with zero additional HTTP requests, which is
  // exactly what we need when the rest of the app is down.
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>กำลังอัพเดทระบบ · IKIGAI OS</title>
  <style>
    @font-face {
      font-family: 'LINESeedSansTH';
      src: url(data:font/woff2;base64,${fontRegular}) format('woff2');
      font-weight: 400;
      font-display: block;
    }
    @font-face {
      font-family: 'LINESeedSansTH';
      src: url(data:font/woff2;base64,${fontBold}) format('woff2');
      font-weight: 700;
      font-display: block;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      font-family: 'LINESeedSansTH', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #ffffff;
      padding: 20px;
      position: relative;
    }
    .container {
      max-width: 480px;
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 40px 32px;
      text-align: center;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    .owl {
      width: 120px;
      height: 120px;
      margin: 0 auto 24px;
      display: block;
      animation: bob 2.4s ease-in-out infinite;
    }
    @keyframes bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    h1 {
      font-size: 28px;
      font-weight: 700;
      margin: 0 0 8px;
      color: #fda4af;
      letter-spacing: 0.5px;
    }
    .subtitle {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.7);
      margin: 0 0 28px;
      font-weight: 400;
    }
    .message {
      background: rgba(253, 164, 175, 0.08);
      border-left: 3px solid #fda4af;
      padding: 18px 22px;
      border-radius: 12px;
      text-align: left;
      font-size: 15px;
      line-height: 1.65;
      white-space: pre-line;
      margin: 0 0 28px;
      font-weight: 400;
      color: rgba(255, 255, 255, 0.95);
    }
    .dots {
      display: flex;
      gap: 7px;
      justify-content: center;
      margin: 16px 0 12px;
    }
    .dot {
      width: 8px;
      height: 8px;
      background: rgba(253, 164, 175, 0.7);
      border-radius: 50%;
      animation: pulse 1.4s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse {
      0%, 100% { opacity: 0.3; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1.1); }
    }
    .footer {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
      margin: 0;
      font-weight: 400;
    }
    .brand {
      position: fixed;
      bottom: 20px;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.3);
      font-weight: 700;
      letter-spacing: 2px;
    }
    @media (max-width: 480px) {
      .container { padding: 32px 24px; border-radius: 20px; }
      .owl { width: 100px; height: 100px; margin-bottom: 20px; }
      h1 { font-size: 24px; }
      .message { font-size: 14px; padding: 16px 18px; }
    }
  </style>
</head>
<body>
  <main class="container" role="main">
    ${owl ? `<img src="data:image/png;base64,${owl}" alt="" class="owl" aria-hidden="true">` : ""}
    <h1>กำลังอัพเดทระบบ</h1>
    <p class="subtitle">น้องฮูกขออภัยที่รบกวนครับ</p>
    <div class="message">${escapeHtml(msg)}</div>
    <div class="dots" aria-hidden="true">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>
    <p class="footer">หน้านี้จะรีเฟรชอัตโนมัติทุก 15 วินาที</p>
  </main>
  <div class="brand">IKIGAI OS</div>
</body>
</html>`;
}

/** Path the maintenance HTML file is written to. Env var wins for
 *  ops flexibility; otherwise platform default. */
function getOutDir(): string {
  if (process.env.MAINTENANCE_OUT_DIR) return process.env.MAINTENANCE_OUT_DIR;
  return process.platform === "win32"
    ? path.join(process.cwd(), "maintenance-out")
    : "/var/www/maintenance";
}

/** Regenerate the on-disk maintenance HTML file with the current
 *  admin-authored message. Called from the system-settings POST
 *  handler after every save. Non-fatal — a permission error here
 *  (e.g. directory not yet chown'd to the PM2 user) should not
 *  block the save itself. */
export function writeMaintenancePage(
  message: string | null | undefined
): { ok: boolean; path?: string; error?: string } {
  const dir = getOutDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, "index.html");
    fs.writeFileSync(filePath, generateMaintenanceHtml(message), "utf8");
    return { ok: true, path: filePath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("writeMaintenancePage failed (non-fatal):", msg);
    return { ok: false, error: msg };
  }
}
