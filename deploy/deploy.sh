#!/usr/bin/env bash
# Deploy / update script — รันบนเซิร์ฟเวอร์ในไดเรกทอรี /var/www/reserva
# Usage:  sudo bash deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Auto-backup DB before any change ──
# เก็บ snapshot ของ SQLite ไว้ใน data/backups/ ก่อน pull/build/migrate
# เผื่อ migration ใหม่ทำลายข้อมูล จะ restore ได้ทันที
# เก็บไว้ 14 ไฟล์ล่าสุด (~2 สัปดาห์ของการ deploy รายวัน)
if [ -f data/reserva.db ]; then
  mkdir -p data/backups
  TS=$(date +%Y%m%d-%H%M%S)
  cp data/reserva.db "data/backups/reserva.db.$TS"
  echo "→ Backed up DB to data/backups/reserva.db.$TS"
  # ลบ backup เก่าเก็บแค่ 14 ไฟล์ล่าสุด
  ls -1t data/backups/reserva.db.* 2>/dev/null | tail -n +15 | xargs -r rm -f
fi

echo "→ Pulling latest code (ถ้าเป็น git repo)"
if [ -d .git ]; then git pull --ff-only; fi

echo "→ Installing ALL dependencies (need devDeps for build: tailwindcss/postcss/typescript)"
npm install --no-audit --no-fund

echo "→ Building Next.js (with low-RAM safeguard for 1GB VPS)"
NODE_OPTIONS="--max-old-space-size=768" npm run build

echo "→ Pruning devDependencies after build (keep node_modules slim)"
npm prune --omit=dev

echo "→ Ensuring data dir exists"
mkdir -p data
chown -R www-data:www-data data

echo "→ Initializing DB if missing"
if [ ! -f data/reserva.db ]; then
  npm run db:init
  chown www-data:www-data data/reserva.db
fi

echo "→ Restarting service"
systemctl restart reserva

echo "✓ Deployed. Tail log: journalctl -u reserva -f"
