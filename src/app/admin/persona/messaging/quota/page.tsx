import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { getDb } from "@/lib/db";
import { buildChannelQuota, type ChannelQuota } from "@/lib/line-quota";
import QuotaClient from "./QuotaClient";

// /admin/persona/messaging/quota — live LINE OA quota dashboard.
//
// Owner ran into a silent-quota-exhaustion issue: the OA Manager
// web UI lags reality by hours/days, so they thought IKIGAI OS had
// 194/300 messages left when LINE's API actually reported 295 used.
// Result: shift reports + discipline + roster pushes all started
// failing without any visible warning. This dashboard makes the
// real number visible per channel.
//
// Server component fetches initial state (so the page renders with
// real data on first paint, not a loading skeleton); the client
// component handles the 10-minute auto-refresh.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "โควต้า LINE OA · IKIGAI ONE"
};

type ChannelRow = {
  code: string;
  label: string;
  channel_token: string | null;
  updated_at: string | null;
};

export default async function QuotaPage() {
  const user = requireAdmin();
  const lang = getLang();

  // Fetch initial channel list + LIVE quota numbers server-side.
  // Done in parallel so the page load isn't gated by 8-10 sequential
  // LINE calls. ~200-400ms total wall time for typical 4-5 channels.
  const db = getDb();
  const rows = db.prepare(`
    SELECT code, label, channel_token, updated_at
    FROM messaging_channels
    ORDER BY
      CASE scope WHEN 'platform' THEN 0 ELSE 1 END,
      label
  `).all() as ChannelRow[];

  const initialChannels: ChannelQuota[] = await Promise.all(
    rows.map((r) => buildChannelQuota({
      code: r.code,
      label: r.label,
      token: r.channel_token,
      updatedAt: r.updated_at
    }))
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.messaging.quota.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.messaging.quota.subtitle")}
        </p>
      </div>
      <QuotaClient
        lang={lang}
        // Pass userRole so the client can show / hide super-admin-
        // only details (token last-rotated timestamps, etc).
        userRole={user.role}
        initial={initialChannels}
        initialFetchedAt={new Date().toISOString()}
      />
    </div>
  );
}
