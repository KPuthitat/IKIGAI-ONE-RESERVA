"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { t, type Lang } from "@/lib/i18n";
import type { ChannelQuota } from "@/lib/line-quota";

// Live LINE OA quota dashboard.
//
// Initial state is server-rendered (see page.tsx) so the user sees
// real numbers on first paint with zero loading flicker. After that
// we silently re-fetch every 10 minutes — fresh enough to catch
// quota changes from broadcasts the marketing team just sent, cheap
// enough not to hammer LINE's API.
//
// Color tiers map to the percent-used buckets the owner cares about:
//   0-59%  → emerald   (plenty of room)
//   60-79% → amber     (watch it, esp. with broadcasts coming)
//   80-94% → orange    (upgrade soon)
//   95%+   → rose      (will hit cap any day — urgent)
// "none" (unlimited) renders slate; "error" rose with the raw reason.

const REFRESH_MS = 10 * 60 * 1000;
const OA_MANAGER_URL = "https://manager.line.biz";

function tierFor(percent: number): {
  bar: string; text: string; pill: string;
} {
  if (percent >= 95) return {
    bar: "bg-rose-500",
    text: "text-rose-700",
    pill: "bg-rose-100 text-rose-700"
  };
  if (percent >= 80) return {
    bar: "bg-orange-500",
    text: "text-orange-700",
    pill: "bg-orange-100 text-orange-700"
  };
  if (percent >= 60) return {
    bar: "bg-amber-500",
    text: "text-amber-800",
    pill: "bg-amber-100 text-amber-800"
  };
  return {
    bar: "bg-emerald-500",
    text: "text-emerald-700",
    pill: "bg-emerald-100 text-emerald-700"
  };
}

function fmtNumber(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

function fmtRelativeTime(iso: string, lang: Lang): string {
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return lang === "en" ? `${diffSec}s ago` : `${diffSec} วินาทีที่แล้ว`;
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60);
    return lang === "en" ? `${m}m ago` : `${m} นาทีที่แล้ว`;
  }
  const h = Math.floor(diffSec / 3600);
  return lang === "en" ? `${h}h ago` : `${h} ชั่วโมงที่แล้ว`;
}

export default function QuotaClient({
  lang,
  userRole,
  initial,
  initialFetchedAt
}: {
  lang: Lang;
  userRole: string;
  initial: ChannelQuota[];
  initialFetchedAt: string;
}) {
  const [channels, setChannels] = useState<ChannelQuota[]>(initial);
  const [fetchedAt, setFetchedAt] = useState<string>(initialFetchedAt);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tick state purely to force re-render of "x minutes ago" labels.
  const [, setTick] = useState(0);

  // Tiny tick every 30s so the "fetched X minutes ago" copy stays
  // current even between hard refreshes. No-op for actual data.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/messaging/quota"), {
        cache: "no-store"
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setError(j?.error ?? "fetch_failed");
        return;
      }
      setChannels(j.channels as ChannelQuota[]);
      setFetchedAt(j.fetched_at);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
    } finally {
      setRefreshing(false);
    }
  }

  // Auto-refresh every 10 min. We don't refresh on tab focus — the
  // owner specifically asked not to hammer LINE; a stale-by-up-to-
  // 10-min number is fine for a monitoring dashboard.
  useEffect(() => {
    const id = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Aggregate row at top — total quota / used / remaining across
  // every "limited" channel. Excludes "none" (no cap to count) and
  // "error" channels. Gives owner the one-glance summary.
  const limited = channels.filter((c) => c.quotaType === "limited");
  const totalQuota = limited.reduce((s, c) => s + (c.quotaValue ?? 0), 0);
  const totalUsed = limited.reduce((s, c) => s + (c.used ?? 0), 0);
  const totalPercent = totalQuota > 0
    ? Math.round((totalUsed / totalQuota) * 100)
    : 0;
  const totalTier = tierFor(totalPercent);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-slate-500">
          {t(lang, "admin.messaging.quota.fetchedAt", {
            time: fmtRelativeTime(fetchedAt, lang)
          })}
          {" · "}
          {t(lang, "admin.messaging.quota.autoRefresh")}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {refreshing
            ? "↻ " + t(lang, "admin.messaging.quota.refreshing")
            : "↻ " + t(lang, "admin.messaging.quota.refresh")}
        </button>
      </div>

      {error && (
        <div className="card border-rose-300 bg-rose-50/40 text-sm text-rose-700">
          ✗ {error}
        </div>
      )}

      {/* Aggregate summary */}
      {limited.length > 0 && (
        <div className="card space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-bold text-slate-800">
              {t(lang, "admin.messaging.quota.totalLabel")}
            </div>
            <div className={`text-xs px-2 py-0.5 rounded ${totalTier.pill}`}>
              {totalPercent}%
            </div>
          </div>
          <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
            <div
              className={`h-full ${totalTier.bar} transition-all`}
              style={{ width: `${totalPercent}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span>
              {t(lang, "admin.messaging.quota.used")}: {" "}
              <span className="font-mono font-bold text-slate-800">{fmtNumber(totalUsed)}</span>
              {" / "}
              <span className="font-mono">{fmtNumber(totalQuota)}</span>
            </span>
            <span>
              {t(lang, "admin.messaging.quota.remaining")}: {" "}
              <span className="font-mono font-bold text-slate-800">
                {fmtNumber(totalQuota - totalUsed)}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Per-channel cards */}
      <div className="space-y-3">
        {channels.map((c) => (
          <ChannelCard key={c.code} channel={c} lang={lang} userRole={userRole} />
        ))}
      </div>

      <p className="text-[11px] text-slate-400 text-center">
        {t(lang, "admin.messaging.quota.footerNote")}
      </p>
    </div>
  );
}

function ChannelCard({
  channel,
  lang,
  userRole
}: {
  channel: ChannelQuota;
  lang: Lang;
  userRole: string;
}) {
  // Error case — token missing or LINE rejected. Surface what's
  // wrong so admin can act (paste a fresh token, etc).
  if (channel.quotaType === "error") {
    return (
      <div className="card border-rose-200 bg-rose-50/30">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-bold text-slate-800">{channel.label}</div>
            <div className="text-[11px] text-slate-500 font-mono">{channel.code}</div>
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">
            {channel.error === "no_token_in_db"
              ? "⚠ " + t(lang, "admin.messaging.quota.noToken")
              : "✗ " + t(lang, "admin.messaging.quota.error")}
          </span>
        </div>
        {channel.error && channel.error !== "no_token_in_db" && (
          <div className="mt-2 text-[11px] text-rose-700 font-mono break-all">
            {channel.error}
          </div>
        )}
      </div>
    );
  }

  // Unlimited plan — rare; LINE returns type=none for some legacy
  // setups + custom enterprise plans. No bar / no percent, just
  // the used count as info.
  if (channel.quotaType === "none") {
    return (
      <div className="card">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-bold text-slate-800">{channel.label}</div>
            <div className="text-[11px] text-slate-500 font-mono">{channel.code}</div>
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-600">
            ∞ {t(lang, "admin.messaging.quota.unlimited")}
          </span>
        </div>
        <div className="text-xs text-slate-500 mt-2">
          {t(lang, "admin.messaging.quota.used")}: {" "}
          <span className="font-mono font-bold text-slate-800">{fmtNumber(channel.used)}</span>
        </div>
      </div>
    );
  }

  // Normal "limited" plan — main case. Progress bar + percent +
  // numeric breakdown + OA Manager link.
  const tier = tierFor(channel.percentUsed ?? 0);
  return (
    <div className="card space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-bold text-slate-800">{channel.label}</div>
          <div className="text-[11px] text-slate-500 font-mono">{channel.code}</div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded font-bold ${tier.pill}`}>
          {channel.percentUsed}%
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full ${tier.bar} transition-all`}
          style={{ width: `${channel.percentUsed}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>
          {t(lang, "admin.messaging.quota.used")}: {" "}
          <span className="font-mono font-bold text-slate-800">{fmtNumber(channel.used)}</span>
          {" / "}
          <span className="font-mono">{fmtNumber(channel.quotaValue)}</span>
        </span>
        <span className={tier.text}>
          {t(lang, "admin.messaging.quota.remaining")}: {" "}
          <span className="font-mono font-bold">{fmtNumber(channel.remaining)}</span>
        </span>
      </div>
      {/* Action row — super_admin sees the token-rotated timestamp
          for forensics; everyone gets a deep link out to LINE OA
          Manager for the actual upgrade flow. */}
      <div className="flex justify-between items-center pt-1.5 border-t border-slate-100 mt-1">
        {userRole === "super_admin" && channel.updatedAt ? (
          <span className="text-[10px] text-slate-400">
            {t(lang, "admin.messaging.quota.tokenUpdated", {
              date: channel.updatedAt.slice(0, 16).replace("T", " ")
            })}
          </span>
        ) : (
          <span />
        )}
        <Link
          href={OA_MANAGER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-brand hover:underline"
        >
          {t(lang, "admin.messaging.quota.openInManager")} →
        </Link>
      </div>
    </div>
  );
}
