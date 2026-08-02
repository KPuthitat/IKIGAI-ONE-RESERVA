// /admin/insigna — INSIGNA landing dashboard.
//
// Single-page snapshot of the pseudonymous marketing intelligence
// engine: how many customers are pseudonymised in the wall, what
// personas they fall into, who's churning, what channels drive
// revenue. Everything renders from insigna_* tables — no PII
// reachable from this page even if it leaked.
//
// requireAdmin gate (any branch admin can see aggregate INSIGNA;
// per-customer drill-down would need separate gating once it lands).

import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { formatBkkDateTime } from "@/lib/time";
import {
  personaDistribution,
  churnRiskList,
  marketingHeadline
} from "@/lib/insigna";
import Sandbox from "./Sandbox";
import { Icon, type IconName } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "INSIGNA · IKIGAI OS" };

function fmtNum(n: number): string {
  return n.toLocaleString("th-TH");
}

function fmtMoney(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function shortHash(h: string): string {
  // Show first 8 + last 4 hex chars — enough for humans to compare
  // rows without exposing the full pseudonym.
  return `${h.slice(0, 8)}…${h.slice(-4)}`;
}

export default function InsignaDashboard() {
  const user = requireAdmin();
  const db = getDb();

  // ── Top counters ──────────────────────────────────────────
  const counts = {
    customers: (db.prepare("SELECT COUNT(*) AS n FROM insigna_customers").get() as { n: number }).n,
    reservations: (db.prepare("SELECT COUNT(*) AS n FROM insigna_reservations").get() as { n: number }).n,
    visits: (db.prepare("SELECT COUNT(*) AS n FROM insigna_visits").get() as { n: number }).n,
    feedback: (db.prepare("SELECT COUNT(*) AS n FROM insigna_feedback").get() as { n: number }).n,
    audit: (db.prepare("SELECT COUNT(*) AS n FROM insigna_ingestion_audit").get() as { n: number }).n
  };

  // Reservation status breakdown.
  const resStatusRows = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM insigna_reservations
    GROUP BY status
    ORDER BY n DESC
  `).all() as Array<{ status: string; n: number }>;

  // Persona distribution.
  const personas = personaDistribution();

  // Channel performance — last 30 days from rollup.
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000 + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const headline = marketingHeadline({ from: thirtyDaysAgo, to: today });

  // Top churn-risk customers.
  const churn = churnRiskList({ threshold: 0.5, limit: 10 });

  // Recent ingestion audit — proves the bridge is alive.
  const recentEvents = db.prepare(`
    SELECT event_type, customer_hash, received_at
    FROM insigna_ingestion_audit
    ORDER BY received_at DESC
    LIMIT 12
  `).all() as Array<{ event_type: string; customer_hash: string | null; received_at: string }>;

  // SALT presence indicator — we don't dump the value, just whether
  // the env var is set. Without it, the bridge no-ops silently.
  const saltConfigured = !!(process.env.INSIGNA_SALT && process.env.INSIGNA_SALT.length >= 32);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">
              INSIGNA — Marketing Intelligence
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Privacy-first dashboard · ทุก row เป็น pseudonymous (customer_hash)
              · ไม่มี PII อยู่ในตารางใดๆ
            </p>
          </div>
          <div className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-bold ${
            saltConfigured
              ? "bg-emerald-100 text-emerald-700"
              : "bg-amber-100 text-amber-700"
          }`}>
            <Icon name={saltConfigured ? "shield" : "lock"} className="h-3.5 w-3.5" />
            {saltConfigured ? "Wall active" : "INSIGNA_SALT not set"}
          </div>
        </div>
      </div>

      {/* Sandbox — only super_admin can fire test events */}
      {user.role === "super_admin" && <Sandbox />}

      {/* Top counters — 5-wide on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {([
          { label: "Customers", n: counts.customers, icon: "users", tile: "bg-rose-50 text-rose-600" },
          { label: "Reservations", n: counts.reservations, icon: "calendar", tile: "bg-sky-50 text-sky-600" },
          { label: "Visits", n: counts.visits, icon: "check", tile: "bg-emerald-50 text-emerald-600" },
          { label: "Feedback", n: counts.feedback, icon: "inbox", tile: "bg-amber-50 text-amber-600" },
          { label: "Audit events", n: counts.audit, icon: "list", tile: "bg-slate-100 text-slate-500" }
        ] as Array<{ label: string; n: number; icon: IconName; tile: string }>).map((c) => (
          <div key={c.label} className="card">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                {c.label}
              </div>
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${c.tile}`}>
                <Icon name={c.icon} className="h-4 w-4" />
              </span>
            </div>
            <div className="text-3xl font-bold text-slate-800 mt-1 tabular-nums">
              {fmtNum(c.n)}
            </div>
          </div>
        ))}
      </div>

      {/* Reservation status pills */}
      {resStatusRows.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Reservations by status
          </h2>
          <div className="flex flex-wrap gap-2">
            {resStatusRows.map((r) => (
              <div
                key={r.status}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100"
              >
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wide">
                  {r.status}
                </span>
                <span className="text-sm font-bold text-slate-800">{r.n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Two-column layout for persona + churn */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Persona distribution */}
        <div className="card">
          <h2 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-1.5">
            <Icon name="users" className="h-4 w-4 text-violet-600" />
            Persona distribution
          </h2>
          {personas.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">
              ยังไม่มี persona — เกิดอัตโนมัติเมื่อลูกค้ามี ≥ 2 visits
            </div>
          ) : (
            <div className="space-y-2">
              {(() => {
                const max = Math.max(...personas.map((p) => p.n));
                return personas.map((p) => {
                  const pctOfMax = (p.n / max) * 100;
                  return (
                    <div key={p.persona_tag}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-medium text-slate-700">
                          {p.persona_tag}
                        </span>
                        <span className="font-mono text-slate-500">{p.n}</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full bg-brand rounded-full"
                          style={{ width: `${pctOfMax}%` }}
                        />
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>

        {/* Churn risk */}
        <div className="card">
          <h2 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-1.5">
            <Icon name="alert" className="h-4 w-4 text-rose-600" />
            Top churn risk (score ≥ 0.5)
          </h2>
          {churn.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">
              ไม่มีลูกค้า high-risk · หรือยังมี data น้อยเกินไปสำหรับ churn signal
            </div>
          ) : (
            <div className="space-y-1.5">
              {churn.map((c) => (
                <Link
                  key={c.customer_hash}
                  href={`/admin/insigna/customers/${c.customer_hash}`}
                  className="flex items-center gap-2 text-xs p-2 rounded-md bg-rose-50/40 border border-rose-100 hover:bg-rose-100/60 transition"
                >
                  <span className="font-mono text-slate-500">
                    {shortHash(c.customer_hash)}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-700 flex-1">
                    {c.persona_tag ?? "(untagged)"} · {c.total_visits} visits
                  </span>
                  <span className="font-bold text-rose-600">
                    {(c.churn_risk_score * 100).toFixed(0)}%
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Marketing headline */}
      <div className="card">
        <h2 className="text-sm font-bold text-slate-700 mb-3">
          Marketing — last 30 days
        </h2>
        {headline.total_spend === 0 && headline.total_revenue === 0 ? (
          <div className="text-xs text-slate-400 py-6 text-center">
            ยังไม่มี campaigns หรือ daily rollup · เพิ่ม campaign แล้วรอ cron กลางคืน
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Total spend</div>
                <div className="text-xl font-bold text-slate-800">
                  ฿{fmtMoney(headline.total_spend)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Total revenue</div>
                <div className="text-xl font-bold text-slate-800">
                  ฿{fmtMoney(headline.total_revenue)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Blended ROAS</div>
                <div className="text-xl font-bold text-emerald-600">
                  {headline.blended_roas != null
                    ? `${headline.blended_roas.toFixed(2)}x`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Blended CAC</div>
                <div className="text-xl font-bold text-slate-800">
                  {headline.blended_cac != null
                    ? `฿${fmtMoney(headline.blended_cac)}`
                    : "—"}
                </div>
              </div>
            </div>
            {/* per-channel table */}
            {headline.by_channel.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2">Channel</th>
                    <th className="text-right">Spend</th>
                    <th className="text-right">Revenue</th>
                    <th className="text-right">ROAS</th>
                    <th className="text-right">New</th>
                  </tr>
                </thead>
                <tbody>
                  {headline.by_channel.map((c) => (
                    <tr key={c.channel} className="border-b border-slate-100">
                      <td className="py-2 font-medium text-slate-700">{c.channel}</td>
                      <td className="text-right text-slate-600">฿{fmtMoney(c.spend)}</td>
                      <td className="text-right font-bold text-slate-800">฿{fmtMoney(c.revenue)}</td>
                      <td className="text-right text-emerald-600 font-bold">
                        {c.roas != null ? `${c.roas.toFixed(2)}x` : "—"}
                      </td>
                      <td className="text-right text-slate-600">{c.new_customers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {/* Recent audit events — proof of life */}
      <div className="card">
        <h2 className="text-sm font-bold text-slate-700 mb-3">
          Recent ingestion events
        </h2>
        {recentEvents.length === 0 ? (
          <div className="text-xs text-slate-400 py-6 text-center">
            ยังไม่มี events · sales ใหม่ที่ผ่าน booking flow จะปรากฏที่นี่
          </div>
        ) : (
          <div className="space-y-1">
            {recentEvents.map((e, i) => (
              <div
                key={`${e.received_at}-${i}`}
                className="flex items-center gap-2 text-xs py-1 border-b border-slate-100 last:border-b-0"
              >
                <span className="text-[10px] font-mono text-slate-400 w-32 shrink-0">
                  {formatBkkDateTime(e.received_at)}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[10px]">
                  {e.event_type}
                </span>
                {e.customer_hash && (
                  <Link
                    href={`/admin/insigna/customers/${e.customer_hash}`}
                    className="font-mono text-slate-500 text-[10px] hover:text-brand"
                  >
                    {shortHash(e.customer_hash)}
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="text-[10px] text-slate-400 text-center pt-2 flex items-center justify-center gap-1 flex-wrap">
        <Icon name="lock" className="h-3 w-3" />
        Privacy wall: hash = HMAC-SHA256(identifier, INSIGNA_SALT) · one-way ·
        no PII columns in any insigna_* table
        {" · "}
        <Link href="https://github.com/KPuthitat/IKIGAI-ONE-RESERVA/blob/main/src/lib/insigna/README.md"
          className="underline hover:text-brand"
          target="_blank" rel="noopener noreferrer">
          spec
        </Link>
      </div>
    </div>
  );
}
