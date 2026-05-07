#!/usr/bin/env bash
# Deploy / update script — รันบนเซิร์ฟเวอร์ในไดเรกทอรี /var/www/reserva
# Usage:  sudo bash deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

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
