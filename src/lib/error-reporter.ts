// Lightweight error reporter that pushes server-side exceptions into
// the executive LINE group via the platform OA (IKIGAI OS). Replaces
// the "Sentry would be nice" idea for this scale of business — we
// already have a LINE group admins watch all day; one more bubble
// when something crashes is a free pager.
//
// Design notes:
//   - Best-effort only. NEVER throws, NEVER awaits in caller's hot
//     path beyond what `void reportError()` does (which is nothing).
//   - Dedupes within a 5-minute window per error fingerprint so a
//     crash loop doesn't blast the LINE group with 200 duplicates
//     (which would also burn our quota).
//   - Skips when platform OA isn't configured — keeps the
//     library no-op on first-run / dev setups.
//   - Truncates the payload aggressively. LINE text messages cap
//     around 5000 chars; we cap at 800 chars total so the bubble
//     stays glanceable in chat.
//
// Usage:
//   try { ... } catch (e) {
//     reportError(e, { where: "POST /api/foo", branchId: 1 });
//     throw e;          // let the route's error response still fire
//   }

import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { getSystemSettings } from "./db";
import { sendLinePush } from "./line";

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const MAX_MESSAGE_CHARS = 800;

// Process-local dedupe cache. Fingerprint → last-sent timestamp.
// Cleared on process restart, which is acceptable: PM2 restart only
// happens during deploys (a few times a day at most), so we don't
// want to persist across restarts anyway — a fresh crash loop in
// new code should re-alert.
const lastSent = new Map<string, number>();

/** Build a stable fingerprint from where + the error's name + the
 *  first line of its message. We deliberately ignore the rest of
 *  the message so timestamps / IDs / per-request data don't bust
 *  the dedupe — a stack trace pointing at the same line is the
 *  same alert, even if "user id 42 failed" vs "user id 43 failed". */
function fingerprint(where: string, err: unknown): string {
  if (err instanceof Error) {
    const firstLine = (err.message || "").split("\n")[0].slice(0, 80);
    return `${where}|${err.name}|${firstLine}`;
  }
  return `${where}|${String(err).slice(0, 80)}`;
}

/** Format the error for a LINE chat bubble. Keep it scannable in
 *  Thai-language chat where the admin reads on mobile. */
function format(
  where: string,
  err: unknown,
  context: Record<string, unknown>
): string {
  const lines: string[] = [];
  lines.push("🚨 IKIGAI OS — server error");
  lines.push(`at: ${where}`);
  if (err instanceof Error) {
    lines.push(`${err.name}: ${err.message}`);
    if (err.stack) {
      // First 3 stack frames; full trace is in pm2 logs anyway.
      const trimmed = err.stack
        .split("\n")
        .slice(1, 4)
        .map((s) => "  " + s.trim())
        .join("\n");
      if (trimmed) lines.push(trimmed);
    }
  } else {
    lines.push(`(non-Error) ${String(err).slice(0, 200)}`);
  }
  const ctxEntries = Object.entries(context);
  if (ctxEntries.length > 0) {
    lines.push("context:");
    for (const [k, v] of ctxEntries) {
      lines.push(`  ${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  }
  let out = lines.join("\n");
  if (out.length > MAX_MESSAGE_CHARS) {
    out = out.slice(0, MAX_MESSAGE_CHARS - 20) + "\n... (truncated)";
  }
  return out;
}

/** Fire-and-forget report an error to the executive LINE group.
 *
 *  Never throws. Returns void synchronously (the actual push runs
 *  in the background). Caller doesn't need to await unless they
 *  want a tiny delay before doing something else.
 *
 *  Args:
 *    err     — the caught exception or unknown value
 *    where   — short identifier of the call site, e.g. "POST /api/foo"
 *    context — extra debug fields (branchId, userId, requestId, ...)
 *
 *  No-op when:
 *    - platform OA isn't configured (first-run / dev)
 *    - global staff group id isn't configured
 *    - same fingerprint was reported < 5 min ago
 */
export function reportError(
  err: unknown,
  where: string,
  context: Record<string, unknown> = {}
): void {
  // Schedule on next tick so even if we throw here, the caller's
  // microtask isn't disrupted. The whole function is best-effort.
  setTimeout(() => {
    try {
      void deliver(err, where, context);
    } catch {
      // Swallow — error reporter must NEVER cascade an error.
    }
  }, 0);
}

async function deliver(
  err: unknown,
  where: string,
  context: Record<string, unknown>
): Promise<void> {
  const fp = fingerprint(where, err);
  const now = Date.now();
  const prev = lastSent.get(fp);
  if (prev && now - prev < DEDUPE_WINDOW_MS) {
    // Within dedupe window — skip silently. The first push covered
    // this fingerprint already; subsequent ones for 5 min would
    // just be noise + quota burn.
    return;
  }
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) return;
  const sys = getSystemSettings();
  const groupId = sys.global_staff_group_id;
  if (!groupId) return;

  const text = format(where, err, context);
  const result = await sendLinePush(platform.channel_token, {
    to: groupId,
    messages: [{ type: "text", text }]
  });
  if (result.ok) {
    lastSent.set(fp, now);
  }
  // If push failed, DON'T update lastSent — next error will retry.
  // (Common failure: LINE quota hit. We can't alert about an alert
  // failure, so it just logs to pm2 stderr via console.error in
  // sendLinePush' caller flows — not perfect but acceptable.)
}
