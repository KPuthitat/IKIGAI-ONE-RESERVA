// /admin/persona/time-certifications — admin inbox for staff time
// certification requests on the active branch. Approving updates
// the underlying time_entries row + audits the change; rejecting
// leaves the entry as-is.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import TimeCertificationsClient from "./TimeCertificationsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "คำขอรับรองเวลา · PERSONA" };

export type PendingCertRow = {
  id: number;
  entry_id: number;
  entry_type: "in" | "out";
  original_ts: string;
  proposed_ts: string;
  reason: string;
  requested_by: number;
  requester_name: string;
  created_at: string;
};

export default function AdminTimeCertificationsPage() {
  const user = requireAdmin();
  const lang = getLang();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }

  const db = getDb();
  const pending = db.prepare(`
    SELECT c.id, c.entry_id, c.original_ts, c.proposed_ts, c.reason,
           c.requested_by, c.created_at,
           e.type AS entry_type,
           u.display_name AS requester_name
    FROM time_certifications c
    JOIN time_entries e ON e.id = c.entry_id
    JOIN users u ON u.id = c.requested_by
    WHERE c.status = 'pending' AND e.branch_id = ?
    ORDER BY c.created_at DESC
  `).all(user.activeBranchId) as PendingCertRow[];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.timeCert.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.timeCert.subtitle")}
        </p>
      </div>
      <TimeCertificationsClient pending={pending} />
    </div>
  );
}
