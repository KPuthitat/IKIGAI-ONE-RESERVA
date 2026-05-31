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

# ── Deploy window pre-flight (2026-05-28) ────────────────────────
# Owner direction: never silently deploy within 15 min of any
# branch's shift entry/exit time — pretty much guarantees a staff
# member will hit the maintenance page during clock-in. The
# /api/deploy-window endpoint checks today's roster across all
# branches and returns { safe, warnings, nextSafeAt }.
#
# Behaviour:
#   • safe=true → proceed silently
#   • safe=false + stdin is a TTY → list warnings + prompt y/n
#   • safe=false + non-interactive (e.g. CI) → bail with exit 4
#   • FORCE=1 env var → skip the check entirely (use sparingly)
#   • Endpoint unreachable (Next.js already down) → warn + proceed
#     because blocking on "can't even check" defeats emergency
#     recovery deploys.
if [[ "${FORCE:-0}" != "1" ]]; then
  echo "==> [0/6] checking deploy window (±15 min of shift edges)"
  WINDOW_JSON="$(curl -s --max-time 5 "http://${HOST_BIND}:${PORT}/api/deploy-window" 2>/dev/null || echo '')"
  if [[ -z "$WINDOW_JSON" ]]; then
    echo "    ⚠  could not reach /api/deploy-window (Next.js down?) — skipping check"
  else
    SAFE="$(echo "$WINDOW_JSON" | grep -oE '"safe":(true|false)' | head -n1 | cut -d':' -f2 || echo 'true')"
    if [[ "$SAFE" == "false" ]]; then
      echo ""
      echo "    ⛔ DEPLOY WINDOW WARNING — within 15 min of a shift edge:"
      # Extract warnings array entries via grep — avoids jq dep.
      echo "$WINDOW_JSON" \
        | grep -oE '"warnings":\[[^]]*\]' \
        | grep -oE '"[^"]+"' \
        | grep -v '"warnings"' \
        | sed 's/^"/      • /' | sed 's/"$//'
      NEXT="$(echo "$WINDOW_JSON" | grep -oE '"nextSafeAt":"[^"]+"' | cut -d'"' -f4 || echo '')"
      if [[ -n "$NEXT" ]]; then
        echo ""
        echo "    Next safe deploy window starts: $NEXT"
      fi
      echo ""
      if [[ -t 0 ]]; then
        # Interactive — ask the operator.
        read -r -p "    Deploy anyway? [y/N] " REPLY
        case "$REPLY" in
          y|Y|yes|YES)
            echo "    → proceeding (operator override)"
            ;;
          *)
            echo "    → aborted. Try again later or run with FORCE=1 to skip the check."
            exit 4
            ;;
        esac
      else
        echo "    → non-interactive shell, refusing. Set FORCE=1 to override."
        exit 4
      fi
    else
      echo "    ✓ safe window — no shift edges within ±15 min"
    fi
  fi
fi

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
# 2026-05-30: feature growth (calendar views + flex previews + new
# admin tooling) pushed the build past Node's default ~1.5GB heap
# ceiling on this 1GB-RAM droplet, killing it mid type-check with
# "FATAL ERROR: Ineffective mark-compacts near heap limit".
# Allowing 2GB lets the build complete using the 2GB swap file we
# provisioned out-of-band (free -h on prod confirms Swap: 2.0Gi).
# Honour any externally-set NODE_OPTIONS by appending; otherwise
# set our minimum.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=2048"
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

echo "==> [4/6] restarting PM2 (delete + start)"
# Strategy (revised 2026-05-31 after a stuck-reload incident):
#   • `pm2 reload` USED to be the happy path, with delete+start as a
#     fallback. In fork mode (which we use — see ecosystem.config.js)
#     reload's semantics are ambiguous: pm2 may signal the old worker
#     and consider the reload complete before the new one binds, or
#     in some daemon states keep the old process alive entirely while
#     reporting "✓". The deploy then reports success while the staff
#     keep seeing old code.
#   • Delete+start is unambiguous: old process gone, new process up
#     from the fresh build. The 1-2s downtime is irrelevant — Nginx
#     already serves the maintenance page on 502/503/504 during the
#     gap, so the user sees the owl, not a broken connection.
#   • --update-env picks up env-var changes from ecosystem.config.js
#     or .env without a separate cycle.
pm2 delete "$PM2_APP" 2>/dev/null || true
pm2 start ecosystem.config.js --only "$PM2_APP" --update-env || {
  echo "    ✗ pm2 start failed"
  exit 3
}

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
#   120s → 240s on 2026-05-31 (INVENTA expansion — false-alarmed at
#     120s while the process was still loading modules, even though
#     it eventually bound at ~140s and ran fine)
#   240s → 360s on 2026-05-31 (RECRUITA + hire-bridge). The 240s
#     ceiling already wasn't enough — observed cold-start ran past
#     it twice this same day. 6 minutes is the new generous headroom.
# If you bump again, scale the droplet.
#
# Strategy refresh: the old check required BOUND_PID == NEW_PM2_PID,
# but on some PM2 fork-mode spawns `pm2 pid` returns the wrapper pid
# while lsof reports the child node pid that actually owns the
# socket. That mismatch caused the script to keep looping past the
# real bind moment. The new check is:
#   "treat as bound" the moment SOMETHING is listening on :PORT
#   AND a HEAD curl to localhost:PORT returns 200/307. That's what
#   the smoke test cared about anyway — proving the server answers
#   real HTTP, not a specific pid equality. The pid mismatch is then
#   reported as a non-fatal note (rare orphan case).
NEW_PM2_PID="$(pm2 pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]' | grep -oE '^[0-9]+$' || echo '')"
BOUND_PID=""
HTTP_STATUS="000"
for i in $(seq 1 360); do
  BOUND_PID="$(lsof -ti :"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n1 || echo '')"
  if [[ -n "$BOUND_PID" ]]; then
    # Port has a listener — probe with curl to confirm it's really
    # answering HTTP. Don't trust lsof alone; pm2's intermediate
    # bootstrap process can hold the socket briefly before next-server
    # is actually ready to respond.
    HTTP_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
      "http://${HOST_BIND}:${PORT}" || echo '000')"
    if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "307" ]]; then
      echo "    bound + answering on :${PORT} after ${i}s (HTTP ${HTTP_STATUS})"
      break
    fi
  fi
  sleep 1
done

if [[ -z "$BOUND_PID" ]]; then
  echo "    ✗ nothing is listening on :${PORT} after 360s — diagnostics:"
  echo "    --- pm2 list ---"
  pm2 list || true
  echo "    --- pm2 logs ${PM2_APP} (last 30 err lines) ---"
  pm2 logs "$PM2_APP" --err --lines 30 --nostream || true
  exit 2
fi

if [[ "$HTTP_STATUS" != "200" && "$HTTP_STATUS" != "307" ]]; then
  echo "    ✗ :${PORT} bound (pid ${BOUND_PID}) but HTTP ${HTTP_STATUS} — diagnostics:"
  pm2 logs "$PM2_APP" --err --lines 30 --nostream || true
  exit 2
fi

# Soft warn on pid mismatch — the listener answers HTTP correctly, so
# the deploy is fine; the mismatch usually means PM2's pid metadata
# lags briefly behind the actual fork. Worth surfacing as a note so
# operators can spot the rare orphan case.
if [[ -n "$NEW_PM2_PID" && "$BOUND_PID" != "$NEW_PM2_PID" ]]; then
  echo "    ⚠ :${PORT} bound by pid ${BOUND_PID} but pm2 reports pid ${NEW_PM2_PID}"
  echo "      (usually fine — PM2 fork wrapper vs node child)"
fi

echo "    PM2 ${PM2_APP} = pid ${NEW_PM2_PID:-?}, :${PORT} bound by ${BOUND_PID}, HTTP ${HTTP_STATUS}"
echo "==> ✓ deploy complete"
exit 0
