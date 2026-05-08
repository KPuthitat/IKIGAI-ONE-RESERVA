import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t, formatDate, type Lang } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "RESERVA · Admin" };

export default function ReservaDashboardPage() {
  const user = requireUser();
  const lang = getLang();

  if (!user.activeBranchId) {
    return <div className="card">{t(lang, "admin.notAssignedBranch")}</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;
  const today = todayBkk();

  const todays = db.prepare(`
    SELECT * FROM bookings WHERE branch_id = ? AND booking_date = ?
    ORDER BY booking_time ASC
  `).all(branch.id, today) as Booking[];

  const counts = {
    total: todays.length,
    confirmed: todays.filter((b) => b.status === "confirmed").length,
    seated: todays.filter((b) => b.status === "seated").length,
    no_show: todays.filter((b) => b.status === "no_show").length,
    cancelled: todays.filter((b) => b.status === "cancelled").length,
    guests: todays.filter((b) => b.status !== "cancelled").reduce((s, b) => s + b.party_size, 0)
  };

  const weekStats = db.prepare(`
    SELECT booking_date, COUNT(*) AS bookings, SUM(party_size) AS guests,
           SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) AS no_shows
    FROM bookings
    WHERE branch_id = ? AND booking_date >= date(?, '-6 days') AND booking_date <= ?
    GROUP BY booking_date ORDER BY booking_date ASC
  `).all(branch.id, today, today) as Array<{ booking_date: string; bookings: number; guests: number; no_shows: number }>;

  const topSources = db.prepare(`
    SELECT je.value AS source, COUNT(*) AS n
    FROM bookings b, json_each(COALESCE(NULLIF(b.source, ''), '[]')) je
    WHERE b.branch_id = ? AND b.booking_date >= date(?, '-29 days')
    GROUP BY je.value ORDER BY n DESC LIMIT 8
  `).all(branch.id, today) as Array<{ source: string; n: number }>;
  const sourceTotal = topSources.reduce((s, x) => s + x.n, 0);

  const originStats = db.prepare(`
    SELECT COALESCE(customer_origin, '__unknown__') AS origin, COUNT(*) AS n
    FROM bookings
    WHERE branch_id = ? AND booking_date >= date(?, '-29 days')
    GROUP BY customer_origin ORDER BY n DESC
  `).all(branch.id, today) as Array<{ origin: string; n: number }>;

  const memberStats = db.prepare(`
    SELECT
      SUM(CASE WHEN is_member = 1 THEN 1 ELSE 0 END) AS members,
      SUM(CASE WHEN is_member = 0 THEN 1 ELSE 0 END) AS non_members,
      SUM(CASE WHEN is_member IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM bookings
    WHERE branch_id = ? AND booking_date >= date(?, '-29 days')
  `).get(branch.id, today) as { members: number; non_members: number; unknown: number };

  // Channel breakdown for the current calendar month — counts only bookings
  // that actually used a table (status confirmed/seated/completed; cancelled
  // and no_show are excluded so the % reflects real customer flow).
  const monthStart = today.slice(0, 7) + "-01";
  const channelStats = db.prepare(`
    SELECT
      COALESCE(booking_channel, 'online') AS channel,
      COUNT(*) AS n
    FROM bookings
    WHERE branch_id = ?
      AND booking_date >= ?
      AND booking_date <= ?
      AND status IN ('confirmed','seated','completed')
    GROUP BY COALESCE(booking_channel, 'online')
  `).all(branch.id, monthStart, today) as Array<{ channel: string; n: number }>;
  const channelTotal = channelStats.reduce((s, c) => s + c.n, 0);
  const channelMap = new Map(channelStats.map((c) => [c.channel, c.n]));
  const monthLabel = formatDate(monthStart, lang).replace(/^\d+\s*/, ""); // strip day → "พ.ค. 2569"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{branch.name}</h1>
        <p className="text-slate-500 text-sm">
          {t(lang, "admin.dashboard.overviewToday", { date: formatDate(today, lang) })}
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label={t(lang, "admin.dashboard.stat.total")} value={counts.total} />
        <Stat label={t(lang, "admin.dashboard.stat.confirmed")} value={counts.confirmed} tone="blue" />
        <Stat label={t(lang, "admin.dashboard.stat.seated")} value={counts.seated} tone="green" />
        <Stat label={t(lang, "admin.dashboard.stat.noShow")} value={counts.no_show} tone="amber" />
        <Stat label={t(lang, "admin.dashboard.stat.cancelled")} value={counts.cancelled} tone="slate" />
        <Stat label={t(lang, "admin.dashboard.stat.guests")} value={counts.guests} />
      </div>

      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">{t(lang, "admin.dashboard.bookingsToday")}</h2>
          <Link href="/admin/reserva/bookings" className="text-brand text-sm hover:underline">
            {t(lang, "admin.dashboard.viewAll")}
          </Link>
        </div>
        {todays.length === 0 ? (
          <div className="text-slate-500 text-sm">{t(lang, "admin.dashboard.noBookings")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">{t(lang, "admin.dashboard.col.time")}</th>
                  <th>{t(lang, "admin.dashboard.col.customer")}</th>
                  <th>{t(lang, "admin.dashboard.col.party")}</th>
                  <th>{t(lang, "admin.dashboard.col.table")}</th>
                  <th>{t(lang, "admin.dashboard.col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {todays.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100">
                    <td className="py-2 font-medium">{b.booking_time}</td>
                    <td>{b.customer_name}<div className="text-xs text-slate-500">{b.customer_phone}</div></td>
                    <td>{b.party_size}</td>
                    <td>
                      {b.table_id
                        ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(b.table_id) as { label: string } | undefined)?.label ?? "—"
                        : "—"}
                    </td>
                    <td><span className={`px-2 py-0.5 rounded text-xs status-${b.status}`}>{t(lang, `status.${b.status}`)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Channel mix this month — % of customers who came in via online
          booking, phone, or walk-in. Excludes cancelled / no-show. */}
      <section className="card">
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <h2 className="font-semibold">
            {t(lang, "admin.dashboard.channelTitle")}
          </h2>
          <span className="text-xs text-slate-500">
            {monthLabel} · {t(lang, "admin.dashboard.channelTotal", { n: channelTotal })}
          </span>
        </div>
        {channelTotal === 0 ? (
          <div className="text-slate-500 text-sm">{t(lang, "common.dataNotAvailable")}</div>
        ) : (
          <div className="space-y-2">
            {(["online", "phone", "walkin"] as const).map((ch) => {
              const n = channelMap.get(ch) ?? 0;
              const pct = channelTotal > 0 ? Math.round((n / channelTotal) * 100) : 0;
              const tone =
                ch === "online" ? "bg-brand" :
                ch === "phone"  ? "bg-sky-500" :
                                  "bg-emerald-500";
              return (
                <div key={ch} className="text-sm">
                  <div className="flex justify-between mb-0.5">
                    <span>{t(lang, `admin.dashboard.channel.${ch}`)}</span>
                    <span className="text-slate-500 tabular-nums">
                      {n} · {pct}%
                    </span>
                  </div>
                  <div className="bg-slate-100 rounded h-1.5 overflow-hidden">
                    <div className={`${tone} h-full`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid md:grid-cols-2 gap-4">
        <section className="card">
          <h2 className="font-semibold mb-3">{t(lang, "admin.dashboard.last7days")}</h2>
          <BarChart
            data={weekStats.map((d) => ({
              label: d.booking_date.slice(5),
              value: d.bookings,
              sub: t(lang, "admin.dashboard.dayUnit", { n: d.bookings, guests: d.guests })
            }))}
            lang={lang}
          />
        </section>
        <section className="card">
          <h2 className="font-semibold mb-1">{t(lang, "admin.dashboard.sourceTitle")}</h2>
          <p className="text-xs text-slate-500 mb-3">{t(lang, "admin.dashboard.sourceNote")}</p>
          {topSources.length === 0 ? (
            <div className="text-slate-500 text-sm">{t(lang, "common.dataNotAvailable")}</div>
          ) : (
            <ul className="space-y-2">
              {topSources.map((s) => {
                const pct = sourceTotal > 0 ? Math.round((s.n / sourceTotal) * 100) : 0;
                return (
                  <li key={s.source} className="text-sm">
                    <div className="flex justify-between mb-0.5">
                      <span>{sourceLabel(lang, s.source)}</span>
                      <span className="text-slate-500">{s.n} · {pct}%</span>
                    </div>
                    <div className="bg-slate-100 rounded h-1.5 overflow-hidden">
                      <div className="bg-brand h-full" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="font-semibold mb-3">{t(lang, "admin.dashboard.originTitle")}</h2>
          {originStats.length === 0 ? (
            <div className="text-slate-500 text-sm">{t(lang, "common.dataNotAvailable")}</div>
          ) : (
            <ul className="space-y-2">
              {originStats.map((o) => (
                <li key={o.origin} className="flex justify-between text-sm">
                  <span>{originLabel(lang, o.origin)}</span>
                  <span className="text-slate-500">
                    {t(lang, "admin.dashboard.timesUnit", { n: o.n })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="font-semibold mb-3">{t(lang, "admin.dashboard.memberTitle")}</h2>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-2xl font-bold text-emerald-600">{memberStats.members ?? 0}</div>
              <div className="text-xs text-slate-500">{t(lang, "admin.dashboard.member.is")}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-amber-600">{memberStats.non_members ?? 0}</div>
              <div className="text-xs text-slate-500">{t(lang, "admin.dashboard.member.not")}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-400">{memberStats.unknown ?? 0}</div>
              <div className="text-xs text-slate-500">{t(lang, "admin.dashboard.member.unknown")}</div>
            </div>
          </div>
          {(memberStats.non_members ?? 0) > 0 && (
            <p className="text-xs text-slate-500 mt-3 border-t border-slate-100 pt-3">
              {t(lang, "admin.dashboard.member.hint", { n: memberStats.non_members })}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function originLabel(lang: Lang, o: string): string {
  if (o === "__unknown__" || !o) return t(lang, "admin.dashboard.member.unknown");
  const key = `booking.origin.${o}`;
  return t(lang, key);
}

function sourceLabel(lang: Lang, s: string): string {
  // Map known values to translation keys
  const map: Record<string, string> = {
    "Instagram": "booking.source.Instagram",
    "Facebook": "booking.source.Facebook",
    "TikTok": "booking.source.TikTok",
    "Google Maps": "booking.source.GoogleMaps",
    "เพื่อนแนะนำ": "booking.source.friend",
    "ผ่านมาเห็น": "booking.source.passing",
    "อื่นๆ": "booking.source.other"
  };
  return map[s] ? t(lang, map[s]) : s;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const toneClass = tone === "blue" ? "text-blue-600"
    : tone === "green" ? "text-emerald-600"
    : tone === "amber" ? "text-amber-600"
    : tone === "slate" ? "text-slate-500"
    : "text-slate-900";
  return (
    <div className="card text-center">
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function BarChart({
  data, lang
}: { data: Array<{ label: string; value: number; sub?: string }>; lang: Lang }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <div className="text-slate-500 text-sm">{t(lang, "common.dataNotAvailable")}</div>;
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center text-xs gap-2">
          <span className="w-12 text-slate-500">{d.label}</span>
          <div className="flex-1 bg-slate-100 rounded h-5 overflow-hidden">
            <div className="bg-brand h-full" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <span className="w-32 text-right text-slate-600">{d.sub}</span>
        </div>
      ))}
    </div>
  );
}
