// /staff/persona/time-certification — staff lists their recent
// clock entries and requests an admin-approved correction when
// they discover one is wrong but it's outside the 5-min self-fix
// window. Limited to entries within the last 30 days (anything
// older usually means the pay period has closed already).

import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import TimeCertificationClient from "./TimeCertificationClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รับรองเวลา · PERSONA" };

type EntryRow = {
  id: number;
  type: "in" | "out";
  ts: string;
  branch_id: number | null;
};
type CertRow = {
  id: number;
  entry_id: number | null; // NULL for a 'missing' (forgot-to-punch) request
  proposed_ts: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  decision_note: string | null;
};

export default function StaffTimeCertificationPage() {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();

  // Last 30 days of entries — old enough to cover a full pay cycle,
  // recent enough that "wait, when did I forget to clock in?" is
  // still answerable from memory.
  const entries = db.prepare(`
    SELECT id, type, ts, branch_id FROM time_entries
    WHERE user_id = ? AND ts >= datetime('now', '-30 days')
    ORDER BY ts DESC
    LIMIT 100
  `).all(user.id) as EntryRow[];

  const myCerts = db.prepare(`
    SELECT id, entry_id, proposed_ts, reason, status,
           decided_at, decision_note
    FROM time_certifications
    WHERE requested_by = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(user.id) as CertRow[];

  // Index pending certs by entry_id so the client can disable the
  // "request" button on entries that already have one in flight.
  const pendingByEntry = new Map<number, CertRow>();
  for (const c of myCerts) {
    // Missing-punch certs have no entry_id yet — they don't gate any
    // existing entry's "request" button, so skip them here.
    if (c.status === "pending" && c.entry_id != null) pendingByEntry.set(c.entry_id, c);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "staff.persona.timeCert.title")}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "staff.persona.timeCert.subtitle")}
        </p>
      </div>
      <TimeCertificationClient
        entries={entries}
        certs={myCerts}
        pendingEntryIds={[...pendingByEntry.keys()]}
      />
    </div>
  );
}
