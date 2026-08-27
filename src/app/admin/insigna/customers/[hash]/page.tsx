// /admin/insigna/customers/[hash] — pseudonymous customer drill-down.
//
// Everything visible on this page is non-identifying. The hash itself
// is the most identifying value — and even THAT requires the salt to
// reverse, which lives only in process.env. Read sections:
//
//   Header     persona + churn + visits + acquisition + tags
//   Visits     last 20 visit rows with table_zone + arrival hour
//   Orders     top 5 menu items by quantity (across all visits)
//   Feedback   list of rating + comment rows
//   Touchpts   campaigns this customer has touched
//   Attrib     which campaigns got credit (first_touch model default)

import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getCustomerProfile, isCustomerHash } from "@/lib/insigna";
import { bkkDateIso, formatBkkDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Customer · INSIGNA" };

function fmt(n: number): string {
  return n.toLocaleString("th-TH");
}
function fmtMoney(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function bkkHourLabel(iso: string): string {
  // Bangkok hour-of-day from UTC ISO. The visit list shows this so a
  // pattern ("always 12pm lunch") is visible at a glance.
  const bkk = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  const h = bkk.getUTCHours();
  return `${String(h).padStart(2, "0")}:${String(bkk.getUTCMinutes()).padStart(2, "0")}`;
}

function bkkDate(iso: string): string {
  const bkk = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 10);
}

export default function CustomerDrillDown({
  params
}: {
  params: { hash: string };
}) {
  requireAdmin();
  if (!isCustomerHash(params.hash)) notFound();
  const profile = getCustomerProfile(params.hash);
  if (!profile) notFound();

  const db = getDb();

  // Tags.
  const tags = db.prepare(`
    SELECT tag, source, confidence
    FROM insigna_customer_tags
    WHERE customer_hash = ?
    ORDER BY created_at DESC
  `).all(params.hash) as Array<{ tag: string; source: string; confidence: number }>;

  // Last 20 visits.
  const visits = db.prepare(`
    SELECT v.visit_token, v.arrived_at, v.departed_at, v.party_size,
           v.party_type, v.table_zone, v.staff_notes,
           COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS total
    FROM insigna_visits v
    LEFT JOIN insigna_order_items oi ON oi.visit_token = v.visit_token
    WHERE v.customer_hash = ?
    GROUP BY v.visit_token
    ORDER BY v.arrived_at DESC
    LIMIT 20
  `).all(params.hash) as Array<{
    visit_token: string;
    arrived_at: string;
    departed_at: string | null;
    party_size: number;
    party_type: string;
    table_zone: string | null;
    staff_notes: string | null;
    total: number;
  }>;

  // Top-5 menu items by quantity ordered.
  const topMenu = db.prepare(`
    SELECT oi.menu_name_snapshot AS name, oi.category,
           SUM(oi.quantity) AS qty,
           SUM(oi.quantity * oi.unit_price) AS revenue
    FROM insigna_order_items oi
    JOIN insigna_visits v ON v.visit_token = oi.visit_token
    WHERE v.customer_hash = ?
    GROUP BY oi.menu_name_snapshot, oi.category
    ORDER BY qty DESC
    LIMIT 5
  `).all(params.hash) as Array<{
    name: string; category: string; qty: number; revenue: number;
  }>;

  // Feedback.
  const feedback = db.prepare(`
    SELECT f.rating, f.food_rating, f.service_rating, f.ambience_rating,
           f.comment, f.sentiment, f.submitted_at
    FROM insigna_feedback f
    JOIN insigna_visits v ON v.visit_token = f.visit_token
    WHERE v.customer_hash = ?
    ORDER BY f.submitted_at DESC
    LIMIT 10
  `).all(params.hash) as Array<{
    rating: number; food_rating: number | null;
    service_rating: number | null; ambience_rating: number | null;
    comment: string | null; sentiment: string | null; submitted_at: string;
  }>;

  // Touchpoints.
  const touchpoints = db.prepare(`
    SELECT t.timestamp, t.touchpoint_type, t.campaign_id,
           c.campaign_name, c.channel
    FROM insigna_campaign_touchpoints t
    LEFT JOIN insigna_marketing_campaigns c ON c.campaign_id = t.campaign_id
    WHERE t.customer_hash = ?
    ORDER BY t.timestamp DESC
    LIMIT 20
  `).all(params.hash) as Array<{
    timestamp: string; touchpoint_type: string;
    campaign_id: string; campaign_name: string | null; channel: string | null;
  }>;

  // Attribution (first_touch model — same default as the rollup).
  const attribution = db.prepare(`
    SELECT al.campaign_id, al.channel, al.attribution_model,
           COUNT(DISTINCT al.visit_token) AS visits,
           ROUND(SUM(al.attributed_revenue), 2) AS revenue
    FROM insigna_attribution_ledger al
    JOIN insigna_visits v ON v.visit_token = al.visit_token
    WHERE v.customer_hash = ?
      AND al.attribution_model = 'first_touch'
    GROUP BY al.campaign_id, al.channel
    ORDER BY revenue DESC
  `).all(params.hash) as Array<{
    campaign_id: string; channel: string; attribution_model: string;
    visits: number; revenue: number;
  }>;

  return (
    <div className="space-y-5">
      {/* Back link */}
      <div>
        <Link
          href="/admin/insigna"
          className="text-xs text-slate-500 hover:text-brand inline-flex items-center gap-1"
        >
          ← กลับไป INSIGNA dashboard
        </Link>
      </div>

      {/* Header — hash + persona + key counters */}
      <div className="card">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
              Customer hash · pseudonymous
            </div>
            <div className="font-mono text-xs text-slate-700 break-all mt-1">
              {profile.customer_hash}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              ทุกข้อมูลด้านล่างเป็น behavioural · ไม่มี PII
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`text-[10px] px-2 py-1 rounded-full font-bold ${
              profile.persona_tag
                ? "bg-brand text-white"
                : "bg-slate-200 text-slate-600"
            }`}>
              {profile.persona_tag ?? "(no persona yet)"}
            </span>
            {profile.churn_risk_score >= 0.5 && (
              <span className="text-[10px] px-2 py-1 rounded-full font-bold bg-rose-100 text-rose-700">
                ⚠ {(profile.churn_risk_score * 100).toFixed(0)}% churn risk
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 pt-4 border-t border-slate-200">
          <div>
            <div className="text-[10px] uppercase text-slate-500 font-bold">Total visits</div>
            <div className="text-2xl font-bold text-slate-800">{fmt(profile.total_visits)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-slate-500 font-bold">Birth year</div>
            <div className="text-2xl font-bold text-slate-800">
              {profile.birth_year ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-slate-500 font-bold">Gender</div>
            <div className="text-2xl font-bold text-slate-800">
              {profile.gender ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-slate-500 font-bold">Acquisition</div>
            <div className="text-sm font-bold text-slate-800 mt-2 truncate">
              {profile.acquisition_source ?? "—"}
            </div>
            {profile.acquisition_campaign && (
              <div className="text-[10px] text-slate-500 truncate">
                {profile.acquisition_campaign}
              </div>
            )}
          </div>
          <div>
            <div className="text-[10px] uppercase text-slate-500 font-bold">Consent</div>
            <div className="text-[11px] mt-2 space-y-0.5">
              <div className="flex items-center gap-1">
                <span>{profile.consent_marketing ? "✓" : "✗"}</span>
                <span className={profile.consent_marketing ? "text-emerald-700" : "text-slate-400"}>marketing</span>
              </div>
              <div className="flex items-center gap-1">
                <span>{profile.consent_analytics ? "✓" : "✗"}</span>
                <span className={profile.consent_analytics ? "text-emerald-700" : "text-slate-400"}>analytics</span>
              </div>
            </div>
          </div>
        </div>

        {tags.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <div className="text-[10px] uppercase text-slate-500 font-bold mb-2">Tags</div>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span
                  key={t.tag}
                  className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                    t.tag.startsWith("__")
                      ? "bg-amber-100 text-amber-800"
                      : t.source === "STAFF"
                        ? "bg-sky-100 text-sky-700"
                        : t.source === "AI"
                          ? "bg-purple-100 text-purple-700"
                          : "bg-slate-100 text-slate-700"
                  }`}
                  title={`source=${t.source} · confidence=${t.confidence}`}
                >
                  {t.tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Two-column: visits + top menu */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Visits (2/3) */}
        <div className="card lg:col-span-2">
          <h2 className="text-sm font-bold text-slate-700 mb-3">
            Recent visits ({visits.length})
          </h2>
          {visits.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">
              ยังไม่มี visit — รอ admin flip booking → seated
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2">Date</th>
                  <th className="text-left">Time</th>
                  <th className="text-left">Party</th>
                  <th className="text-left">Zone</th>
                  <th className="text-right">Spent</th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => (
                  <tr key={v.visit_token} className="border-b border-slate-100">
                    <td className="py-1.5 font-mono text-slate-700">{bkkDate(v.arrived_at)}</td>
                    <td className="font-mono text-slate-600">{bkkHourLabel(v.arrived_at)}</td>
                    <td className="text-slate-700">
                      {v.party_size}{" "}
                      <span className="text-[10px] text-slate-400">({v.party_type})</span>
                    </td>
                    <td className="text-slate-500 text-[10px]">{v.table_zone ?? "—"}</td>
                    <td className="text-right font-bold text-slate-800">
                      {v.total > 0 ? `฿${fmtMoney(v.total)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Top menu (1/3) */}
        <div className="card">
          <h2 className="text-sm font-bold text-slate-700 mb-3">
            Top dishes
          </h2>
          {topMenu.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">
              ยังไม่มี orders
            </div>
          ) : (
            <div className="space-y-2">
              {topMenu.map((m) => (
                <div
                  key={m.name + m.category}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="flex-1 truncate text-slate-700">{m.name}</span>
                  <span className="text-[10px] text-slate-400">{m.category}</span>
                  <span className="font-bold text-slate-800">×{m.qty}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Feedback */}
      <div className="card">
        <h2 className="text-sm font-bold text-slate-700 mb-3">
          Feedback ({feedback.length})
        </h2>
        {feedback.length === 0 ? (
          <div className="text-xs text-slate-400 py-6 text-center">
            ยังไม่ได้ส่ง feedback
          </div>
        ) : (
          <div className="space-y-2">
            {feedback.map((f, i) => (
              <div
                key={i}
                className="text-xs p-2.5 rounded-md border border-slate-200"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-amber-500 font-bold">
                    {"★".repeat(f.rating)}
                    <span className="text-slate-200">
                      {"★".repeat(5 - f.rating)}
                    </span>
                  </span>
                  <span className="text-[10px] text-slate-400">
                    food {f.food_rating ?? "—"} · svc {f.service_rating ?? "—"} · amb {f.ambience_rating ?? "—"}
                  </span>
                  <span className="text-[10px] text-slate-400 ml-auto">
                    {bkkDateIso(f.submitted_at)}
                  </span>
                </div>
                {f.comment && (
                  <div className="text-slate-700 italic">&ldquo;{f.comment}&rdquo;</div>
                )}
                {f.sentiment && (
                  <div className="text-[10px] text-slate-500 mt-1">
                    AI: {f.sentiment}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Marketing — touchpoints + attribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-sm font-bold text-slate-700 mb-3">
            Campaign touchpoints
          </h2>
          {touchpoints.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">
              ไม่มี touchpoints — ยังไม่ได้บันทึก campaign interactions
            </div>
          ) : (
            <div className="space-y-1.5">
              {touchpoints.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-[10px] text-slate-400 w-24 shrink-0">
                    {formatBkkDateTime(t.timestamp)}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-mono">
                    {t.touchpoint_type}
                  </span>
                  <span className="text-slate-700 truncate">
                    {t.campaign_name ?? t.campaign_id}
                  </span>
                  {t.channel && (
                    <span className="text-[10px] text-slate-500">· {t.channel}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="text-sm font-bold text-slate-700 mb-3">
            Attribution (first-touch)
          </h2>
          {attribution.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">
              ยังไม่มี attribution — ลูกค้ายังไม่ได้ visit หรือไม่มี touchpoint
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2">Campaign</th>
                  <th className="text-left">Channel</th>
                  <th className="text-right">Visits</th>
                  <th className="text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {attribution.map((a) => (
                  <tr key={a.campaign_id + a.channel} className="border-b border-slate-100">
                    <td className="py-1.5 truncate text-slate-700">{a.campaign_id}</td>
                    <td className="text-slate-500">{a.channel}</td>
                    <td className="text-right text-slate-600">{a.visits}</td>
                    <td className="text-right font-bold text-slate-800">฿{fmtMoney(a.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
