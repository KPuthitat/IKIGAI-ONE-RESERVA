// LINE Messaging API quota helpers — used by the admin dashboard at
// /admin/persona/messaging/quota to show real-time message-cap status
// per channel. Calls LINE's quota + consumption endpoints, which are
// the only authoritative source (the LINE OA Manager web UI lags by
// hours, sometimes days — owner ran into this when ikigai-os showed
// "194/300 remaining" while the API reported 295 already consumed).
//
// LINE docs:
//   GET /v2/bot/message/quota
//     → { type: "limited" | "none", value?: number }
//   GET /v2/bot/message/quota/consumption
//     → { totalUsage: number }

export type ChannelQuota = {
  code: string;
  label: string;
  /** True when messaging_channels.channel_token is set. False rows
   *  are shown greyed out — admin knows they need to configure. */
  hasToken: boolean;
  /** "limited" = has a monthly cap (free or paid plans).
   *  "none"    = no cap (rare; treats as infinite headroom).
   *  "error"   = API rejected the token or network failed. */
  quotaType: "limited" | "none" | "error";
  /** Monthly cap (only present when quotaType === "limited"). */
  quotaValue: number | null;
  /** Messages used this month (only present when API call succeeded). */
  used: number | null;
  /** quotaValue - used (only when quotaType === "limited"). */
  remaining: number | null;
  /** 0-100, only when quotaType === "limited". */
  percentUsed: number | null;
  /** Error string from LINE for the "error" case — surfaced in the
   *  dashboard so admin sees the raw reason (invalid token, etc.) */
  error?: string;
  /** When messaging_channels row was last updated — helps admin
   *  correlate "token rotated 2 days ago" with "quota usage suddenly
   *  spiked" scenarios. */
  updatedAt: string | null;
};

/** Fetch quota + consumption for one channel token. Returns the
 *  parsed numbers in a single shape, or an error string. Caller
 *  composes the full ChannelQuota row. */
async function fetchOne(token: string): Promise<
  | { ok: true; quota: { type: "limited" | "none"; value?: number }; usage: number }
  | { ok: false; error: string }
> {
  try {
    // Run the two LINE calls in parallel — they're independent and
    // both fast (~100ms). Sequential would double the dashboard load
    // time per channel.
    const [qRes, uRes] = await Promise.all([
      fetch("https://api.line.me/v2/bot/message/quota", {
        headers: { Authorization: `Bearer ${token}` },
        // Disable Next.js fetch cache — dashboard expects fresh
        // numbers each render. Per-request rate to LINE is fine.
        cache: "no-store"
      }),
      fetch("https://api.line.me/v2/bot/message/quota/consumption", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      })
    ]);
    if (!qRes.ok) {
      const text = await qRes.text();
      return { ok: false, error: `quota HTTP ${qRes.status}: ${text.slice(0, 200)}` };
    }
    if (!uRes.ok) {
      const text = await uRes.text();
      return { ok: false, error: `consumption HTTP ${uRes.status}: ${text.slice(0, 200)}` };
    }
    const quota = await qRes.json() as { type: "limited" | "none"; value?: number };
    const usage = await uRes.json() as { totalUsage: number };
    return { ok: true, quota, usage: usage.totalUsage };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "network_error"
    };
  }
}

/** Compose a single ChannelQuota row given a channel's metadata +
 *  token. Empty token short-circuits to "no token" without an API
 *  call. Error case keeps the channel visible so admin sees it
 *  needs attention. */
export async function buildChannelQuota(args: {
  code: string;
  label: string;
  token: string | null;
  updatedAt: string | null;
}): Promise<ChannelQuota> {
  const base = {
    code: args.code,
    label: args.label,
    updatedAt: args.updatedAt
  };
  if (!args.token) {
    return {
      ...base,
      hasToken: false,
      quotaType: "error",
      quotaValue: null,
      used: null,
      remaining: null,
      percentUsed: null,
      error: "no_token_in_db"
    };
  }
  const res = await fetchOne(args.token);
  if (!res.ok) {
    return {
      ...base,
      hasToken: true,
      quotaType: "error",
      quotaValue: null,
      used: null,
      remaining: null,
      percentUsed: null,
      error: res.error
    };
  }
  if (res.quota.type === "none") {
    return {
      ...base,
      hasToken: true,
      quotaType: "none",
      quotaValue: null,
      used: res.usage,
      remaining: null,    // infinite
      percentUsed: null   // no meaningful percentage
    };
  }
  const value = res.quota.value ?? 0;
  const used = res.usage;
  const remaining = Math.max(0, value - used);
  const percentUsed = value > 0 ? Math.min(100, Math.round((used / value) * 100)) : 0;
  return {
    ...base,
    hasToken: true,
    quotaType: "limited",
    quotaValue: value,
    used,
    remaining,
    percentUsed
  };
}
