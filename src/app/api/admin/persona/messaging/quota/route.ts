import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { buildChannelQuota, type ChannelQuota } from "@/lib/line-quota";

// GET /api/admin/persona/messaging/quota
//
// Returns real-time message-quota status for every configured LINE
// channel (platform OA + every branch OA). Calls LINE's quota +
// consumption endpoints in parallel — see lib/line-quota.ts for the
// per-channel logic.
//
// Admin-only. Doesn't take any params — we always return every
// channel so the dashboard can show "all channels at a glance".
// Channels with empty tokens render as "not configured" rows.
//
// Performance: 4-5 channels × 2 LINE calls = 8-10 outbound requests
// per dashboard load. LINE rate-limit is generous (1000+ rps per
// channel) so this is safe even on the dashboard's 10-minute
// auto-refresh interval. We don't cache the response — admin
// looking at this page wants fresh numbers; stale data is what
// caused the previous "194/300" UI to mislead during quota
// exhaustion.

type ChannelRow = {
  code: string;
  label: string;
  channel_token: string | null;
  updated_at: string | null;
};

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT code, label, channel_token, updated_at
    FROM messaging_channels
    ORDER BY
      CASE scope WHEN 'platform' THEN 0 ELSE 1 END,
      label
  `).all() as ChannelRow[];

  // Run every channel's API check in parallel. Each takes ~100-200ms
  // so total wall time is dominated by the slowest one, not sum.
  const results: ChannelQuota[] = await Promise.all(
    rows.map((r) => buildChannelQuota({
      code: r.code,
      label: r.label,
      token: r.channel_token,
      updatedAt: r.updated_at
    }))
  );

  return NextResponse.json({
    ok: true,
    channels: results,
    fetched_at: new Date().toISOString()
  });
}
