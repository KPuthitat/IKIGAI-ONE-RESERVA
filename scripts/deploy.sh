#!/usr/bin/env bash
#
# deploy.sh — one-shot deployment for /var/www/reserva on the VPS.
#
# Two recurring failure modes this script defends against:
#
# 1) Zombie next-server — `pm2 restart` has a race where the old
#    next-server outlives its kill_timeout, gets reparented to init,
#    and keeps holding port 3010. PM2 thinks the new spawn is
#    "online" but it actually fails to bind. Fix: scan port 3010 for
#    pids that aren't the PM2-managed one and SIGKILL them.
#
# 2) PM2 stale state — "Process N not found" error from
#    `pm2 restart reserva`. PM2 keeps an app entry (with a pm_id)
#    but the underlying process has died silently (build overwrote
#    a chunk it was about to load, OOM-kill, manual kill, etc.).
#    Plain `pm2 restart` errors out because it tries to restart the
#    missing process by pm_id instead of starting a new one. Fix:
#    use `pm2 reload ecosystem.config.js` (idempotent — starts the
#    app if missing, gracefully reloads if running), and if THAT
#    still fails, fall back to `pm2 delete + pm2 start`.
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
#   1 — git pull / npm build failed
#   2 — port 3010 still held by something unexpected after cleanup
#   3 — PM2 reload AND fallback delete+start both failed

set -euo pipefail

APP_DIR="/var/www/reserva"
PM2_APP="reserva"
PORT="3010"
HOST_BIND="127.0.0.1"   # matches ecosystem.config.js HOSTNAME

cd "$APP_DIR"

echo "==> [1/6] git pull origin main"
git pull origin main

# Wipe the stale build cache before rebuilding.
#
# Why: when the diff between deploys adds many new files (whole new
# routes, schema-shifting tables, etc.) Next.js' .next/server can
# end up holding manifests that point at chunk hashes from the
# OLD build. Those manifests survive `npm run build` because the
# new build only overlays — it doesn't truncate the directory.
# The mismatch shows up at runtime as
#   TypeError: Cannot read properties of undefined (reading 'entryCSSFiles')
# in webpack/app-render — fatal for the request, which triggers a
# PM2 restart, which loops. Rebuilding from scratch costs ~5-10s
# extra on this VPS and eliminates the class of bug entirely.
# node_modules/.cache also gets cleared so webpack persistent cache
# doesn't retain stale entries.
echo "==> [2/6] clean rebuild (rm -rf .next + npm run build)"
rm -rf .next node_modules/.cache
npm run build

# Snapshot the PID PM2 thinks reserva is — anything else on the port
# after the kill loop is an orphan that needs to die.
#
# IMPORTANT: use `pm2 pid <name>` here. The earlier version of this
# script tried to grep the pid out of `pm2 jlist` JSON, but pm2's
# jlist output contains multiple `"pid":` keys per process (pid,
# parent_pid, pm_id, etc.) and the anchored-regex approach was
# fragile — it matched nothing on some pm2 versions, leaving PM2_PID
# empty, which made the orphan loop treat the legitimate
# PM2-managed process as an orphan and SIGKILL it. `pm2 pid <name>`
# returns just the integer pid on stdout, no JSON, no ambiguity.
echo "==> [3/6] checking for orphan processes on :${PORT}"
PM2_PID="$(pm2 pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]' | grep -oE '^[0-9]+$' || echo '')"

# SAFETY: if PM2 doesn't know the app's pid (entry was deleted, or
# `pm2 pid` returned empty for any reason), skip the orphan kill
# loop entirely. Otherwise we'd treat every listener on :3010 as an
# orphan and nuke the legitimate process — which is exactly how the
# script trashed its own PM2-managed reserva in earlier versions.
# The reload/start step below handles "no process" cases cleanly.
if [[ -z "$PM2_PID" ]]; then
  echo "    PM2 has no pid for ${PM2_APP} — skipping orphan scan"
  echo "    (will start fresh via pm2 reload/start in step 5)"
else
  # lsof -ti :PORT -sTCP:LISTEN prints one pid per line for processes
  # in LISTEN state on the port. Much simpler than the previous
  # `ss | grep | while` pipeline, and doesn't require root on systems
  # where the calling user owns the process.
  mapfile -t PORT_PIDS < <(
    lsof -ti :"${PORT}" -sTCP:LISTEN 2>/dev/null | sort -u
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
  # Brief pause so the kernel releases the socket before the new
  # process tries to bind.
  sleep 1
fi

echo "==> [4/6] reloading PM2 (graceful, then fallback)"
# Strategy:
#   • `pm2 reload ecosystem.config.js` is idempotent — if reserva is
#     running it does a graceful reload; if missing it starts fresh
#     from the config. Either way the app entry ends up matching
#     ecosystem.config.js, which kills the "Process N not found" bug
#     where PM2's entry pm_id pointed at a long-dead process.
#   • If reload fails for any reason (corrupted daemon state, etc.)
#     fall back to delete+start — heavier but always works.
#   • --update-env picks up env-var changes from ecosystem.config.js
#     or .env without a separate cycle.
if pm2 reload ecosystem.config.js --update-env 2>&1 | tee /tmp/pm2-reload.log; then
  if grep -qiE "(error|errored)" /tmp/pm2-reload.log; then
    echo "    reload reported an error — falling back to delete+start"
    pm2 delete "$PM2_APP" 2>/dev/null || true
    pm2 start ecosystem.config.js --update-env || {
      echo "    ✗ fallback pm2 start also failed"
      exit 3
    }
  fi
else
  echo "    reload command failed — falling back to delete+start"
  pm2 delete "$PM2_APP" 2>/dev/null || true
  pm2 start ecosystem.config.js --update-env || {
    echo "    ✗ fallback pm2 start also failed"
    exit 3
  }
fi

echo "==> [5/6] persisting PM2 state"
# pm2 save records the current process list so it survives reboot
# via pm2-systemd integration. Cheap to call on every deploy.
pm2 save

echo "==> [6/6] verifying"
# Boot wait — on the 1 vCPU droplet, Next.js + better-sqlite3 + the
# migrations chain can take 60-120s before the new process binds to
# port 3010, especially after migrations that touch large tables.
# The old `sleep 5 + check once` pattern false-alarmed every deploy
# ("✗ nothing is listening on :3010") even though the process came
# up healthy a few seconds later.
#   30s → 90s   on 2026-05-27 (tier-approval + is_test_account)
#   90s → 120s  on 2026-05-27 (ASCENDA tables + seed)
# If you bump again, also consider scaling the droplet — but the
# real boot time is ~60-100s observed, so 120s gives generous
# headroom without delaying a true-failure case too long.
NEW_PM2_PID="$(pm2 pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]' | grep -oE '^[0-9]+$' || echo '')"
BOUND_PID=""
for i in $(seq 1 120); do
  BOUND_PID="$(lsof -ti :"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n1 || echo '')"
  if [[ -n "$BOUND_PID" && "$BOUND_PID" == "$NEW_PM2_PID" ]]; then
    echo "    bound on :${PORT} after ${i}s"
    break
  fi
  sleep 1
done

if [[ -z "$BOUND_PID" ]]; then
  echo "    ✗ nothing is listening on :${PORT} after 120s — check pm2 logs ${PM2_APP}"
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
