#!/usr/bin/env bash
#
# deploy.sh — one-shot deployment for /var/www/reserva on the VPS.
#
# Why this exists: `pm2 reload` and `pm2 restart` both have a race
# window where the old next-server can outlive its kill_timeout, get
# reparented to init (PID 1), and keep holding port 3010. PM2 thinks
# the new spawn is "online" but it actually fails to bind, leaving an
# orphan serving stale code. The fix has always been the same: find
# the process on port 3010 that isn't the PM2-managed one and SIGKILL
# it. This script automates that check so deploys are reliable.
#
# Usage (on the VPS):
#   cd /var/www/reserva
#   ./scripts/deploy.sh
#
# Or one-liner from anywhere:
#   /var/www/reserva/scripts/deploy.sh
#
# Exit codes:
#   0 — deploy succeeded, reserva is online + serving on port 3010
#   1 — git pull / npm build / pm2 restart failed
#   2 — port 3010 still held by something unexpected after cleanup

set -euo pipefail

APP_DIR="/var/www/reserva"
PM2_APP="reserva"
PORT="3010"
HOST_BIND="127.0.0.1"   # matches ecosystem.config.js HOSTNAME

cd "$APP_DIR"

echo "==> [1/5] git pull origin main"
git pull origin main

echo "==> [2/5] npm run build"
npm run build

# Snapshot the PID PM2 thinks reserva is — anything else on the port
# after the kill loop is an orphan that needs to die.
echo "==> [3/5] checking for orphan processes on :${PORT}"
PM2_PID="$(pm2 jlist 2>/dev/null \
  | grep -oE "\"name\":\"${PM2_APP}\"[^}]*\"pid\":[0-9]+" \
  | grep -oE '[0-9]+$' \
  || echo '')"

# Loop through every pid currently bound to the port and kill any that
# isn't the PM2-managed one. Idempotent — empty match list = nothing
# to do.
mapfile -t PORT_PIDS < <(
  ss -tlnp 2>/dev/null \
    | grep -oE "pid=[0-9]+" \
    | grep -oE '[0-9]+' \
    | sort -u \
    | while read -r pid; do
        if ss -tlnp "sport = :${PORT}" 2>/dev/null \
           | grep -q "pid=${pid}"; then
          echo "$pid"
        fi
      done
)

for pid in "${PORT_PIDS[@]:-}"; do
  [[ -z "$pid" ]] && continue
  if [[ "$pid" == "$PM2_PID" ]]; then
    echo "    pid $pid is PM2-managed (${PM2_APP}) — leaving it alone"
    continue
  fi
  echo "    pid $pid is an orphan on :${PORT} — SIGKILL"
  kill -9 "$pid" || true
done

# Brief pause so the kernel releases the socket before pm2 restart
# tries to bind from the new process.
sleep 1

echo "==> [4/5] pm2 restart ${PM2_APP}"
# --update-env reloads any env-var changes from ecosystem.config.js
# or .env without needing a delete/start cycle.
pm2 restart "$PM2_APP" --update-env

# Give Next.js a moment to come up. 5s is enough for our typical boot
# time (~1-3s "Ready in...") plus a safety margin.
sleep 5

echo "==> [5/5] verifying"
# Bound pid should match the new PM2 reserva pid. If not, something
# else swooped in on port 3010 again — bail out so the human can
# investigate.
NEW_PM2_PID="$(pm2 jlist 2>/dev/null \
  | grep -oE "\"name\":\"${PM2_APP}\"[^}]*\"pid\":[0-9]+" \
  | grep -oE '[0-9]+$' \
  || echo '')"
BOUND_PID="$(ss -tlnp "sport = :${PORT}" 2>/dev/null \
  | grep -oE 'pid=[0-9]+' \
  | head -n1 \
  | grep -oE '[0-9]+' \
  || echo '')"

if [[ -z "$BOUND_PID" ]]; then
  echo "    ✗ nothing is listening on :${PORT}"
  exit 2
fi

if [[ "$BOUND_PID" != "$NEW_PM2_PID" ]]; then
  echo "    ✗ :${PORT} held by pid ${BOUND_PID} but PM2 ${PM2_APP} is pid ${NEW_PM2_PID}"
  echo "      (re-run the script, or kill -9 ${BOUND_PID} manually)"
  exit 2
fi

# Quick smoke test — Next.js should answer with a redirect to /login
# for the root URL. A 5xx or no response means the new process
# bound but didn't fully boot.
HTTP_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  "http://${HOST_BIND}:${PORT}" || echo '000')"
echo "    PM2 ${PM2_APP} = pid ${NEW_PM2_PID}, :${PORT} bound, HTTP ${HTTP_STATUS}"

if [[ "$HTTP_STATUS" == "307" || "$HTTP_STATUS" == "200" ]]; then
  echo "==> ✓ deploy complete"
  exit 0
fi

echo "    ✗ unexpected HTTP status ${HTTP_STATUS} — check pm2 logs ${PM2_APP}"
exit 2
