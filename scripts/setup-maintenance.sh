#!/usr/bin/env bash
#
# setup-maintenance.sh — one-time setup for the Nginx maintenance
# page. Run this ONCE on the VPS after deploying the code that
# introduces lib/maintenance-page.ts.
#
# What it does:
#   1. Create /var/www/maintenance/ with the right ownership so
#      the Next.js process (PM2) can regenerate index.html on save.
#   2. Generate a placeholder index.html so Nginx has something to
#      serve even before the admin saves any maintenance message.
#   3. Print the Nginx config snippet to paste into the site config.
#
# Usage:
#   sudo /var/www/reserva/scripts/setup-maintenance.sh
#
# After this script runs, you still need to:
#   1. Paste the printed Nginx snippet into /etc/nginx/sites-available/<site>
#   2. sudo nginx -t   (verify config)
#   3. sudo nginx -s reload
#
# Then test by:
#   • Saving a maintenance message at /admin/system-settings
#   • Stopping pm2: pm2 stop reserva
#   • Opening the site → should see the styled maintenance page
#   • Restart: pm2 start reserva
#
# Idempotent — safe to re-run.

set -euo pipefail

MAINT_DIR="/var/www/maintenance"
APP_DIR="/var/www/reserva"
OWNER="root"   # change if pm2 runs as a different user

echo "==> [1/3] creating ${MAINT_DIR}"
mkdir -p "${MAINT_DIR}"
chown -R "${OWNER}:${OWNER}" "${MAINT_DIR}"
chmod 755 "${MAINT_DIR}"

echo "==> [2/3] writing placeholder index.html"
# Minimal HTML so Nginx serves SOMETHING even before the Next.js app
# has had a chance to regenerate the styled version. The next save
# at /admin/system-settings will replace this with the proper
# branded page (owl + LINE Seed Sans TH).
cat > "${MAINT_DIR}/index.html" <<'EOF'
<!DOCTYPE html>
<html lang="th"><head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="15">
<title>กำลังอัพเดทระบบ</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#1a1a2e;color:#fff;font-family:system-ui,sans-serif;padding:20px}
  .box{max-width:480px;text-align:center;background:rgba(255,255,255,.05);
       border-radius:24px;padding:40px 32px;border:1px solid rgba(255,255,255,.1)}
  h1{color:#fda4af;margin:0 0 16px}
  p{color:rgba(255,255,255,.8);line-height:1.6}
</style></head><body>
<div class="box">
  <h1>กำลังอัพเดทระบบ</h1>
  <p>ขอเวลาสักครู่ จะกลับมาใช้งานได้ภายใน 1-2 นาทีครับ</p>
  <p style="font-size:11px;color:rgba(255,255,255,.4);margin-top:24px">
    หน้านี้จะรีเฟรชอัตโนมัติทุก 15 วินาที
  </p>
</div></body></html>
EOF
chown "${OWNER}:${OWNER}" "${MAINT_DIR}/index.html"

echo "==> [3/3] DONE — paste the snippet below into your Nginx config"
echo ""
echo "─────────────────────────────────────────────────────────────"
cat <<'NGINX'
# ── IKIGAI OS maintenance page ─────────────────────────────────
# Paste these directives INSIDE the existing `server { ... }` block
# that handles ikigaimedihealth.com. Specifically:
#
#   • Add `proxy_intercept_errors on;` and `error_page` line INSIDE
#     the existing `location / { ... }` block (the one with
#     proxy_pass http://127.0.0.1:3010).
#   • Add the new `location @maintenance { ... }` block at the same
#     level as `location /`.
#
# Then: sudo nginx -t && sudo nginx -s reload

location / {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # ── NEW: serve maintenance page on upstream errors ────────
    proxy_intercept_errors on;
    proxy_connect_timeout 3s;
    proxy_read_timeout 30s;
    error_page 502 503 504 = @maintenance;
}

location @maintenance {
    root /var/www/maintenance;
    try_files /index.html =503;
    add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    add_header Pragma "no-cache" always;
    default_type text/html;
}
NGINX
echo "─────────────────────────────────────────────────────────────"
echo ""
echo "After updating Nginx config:"
echo "  sudo nginx -t              # verify"
echo "  sudo nginx -s reload       # apply"
echo ""
echo "Test the maintenance page:"
echo "  1. Save a message at https://ikigaimedihealth.com/admin/system-settings"
echo "  2. pm2 stop reserva"
echo "  3. Refresh the site in browser → should see branded maintenance page"
echo "  4. pm2 start reserva       # restore"
