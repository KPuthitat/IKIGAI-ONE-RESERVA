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
  entry_id: number | null;
  entry_type: "in" | "out";
  kind: "correction" | "missing";
  work_date: string | null;
  original_ts: string | null;
  proposed_ts: string;
  reason: string;
  requested_by: number;
  requester_name: string;
  requester_prefix: string | null;
  created_at: string;
};

export type HistoryCertRow = {
  id: number;
  entry_id: number | null;
  entry_type: "in" | "out";
  kind: "correction" | "missing";
  work_date: string | null;
  proposed_ts: string;
  reason: string;
  status: "approved" | "rejected";
  decided_at: string | null;
  decision_note: string | null;
  requester_name: string;
  requester_prefix: string | null;
  decided_by_name: string | null;
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
  // LEFT JOIN — a 'missing' cert has no underlying entry yet; its branch
  // + punch type live on the cert row (owner 2026-06-08).
  const pending = db.prepare(`
    SELECT c.id, c.entry_id, c.original_ts, c.proposed_ts, c.reason,
           c.requested_by, c.created_at, c.kind, c.work_date,
           COALESCE(e.type, c.entry_type) AS entry_type,
           u.display_name AS requester_name,
           u.title_prefix AS requester_prefix
    FROM time_certifications c
    LEFT JOIN time_entries e ON e.id = c.entry_id
    JOIN users u ON u.id = c.requested_by
    WHERE c.status = 'pending' AND COALESCE(e.branch_id, c.branch_id) = ?
    ORDER BY c.created_at DESC
  `).all(user.activeBranchId) as PendingCertRow[];

  // History — decided (approved/rejected) certs so admin can audit what
  // happened (owner 2026-06-15: "ไม่มีการเก็บประวัติ ย้อนไปตรวจสอบไม่ได้").
  const history = db.prepare(`
    SELECT c.id, c.entry_id, c.proposed_ts, c.reason, c.kind, c.work_date,
           c.status, c.decided_at, c.decision_note,
           COALESCE(e.type, c.entry_type) AS entry_type,
           u.display_name AS requester_name,
           u.title_prefix AS requester_prefix,
           du.display_name AS decided_by_name
    FROM time_certifications c
    LEFT JOIN time_entries e ON e.id = c.entry_id
    JOIN users u ON u.id = c.requested_by
    LEFT JOIN users du ON du.id = c.decided_by
    WHERE c.status IN ('approved', 'rejected')
      AND COALESCE(e.branch_id, c.branch_id) = ?
    ORDER BY c.decided_at DESC
    LIMIT 100
  `).all(user.activeBranchId) as HistoryCertRow[];

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
      <TimeCertificationsClient pending={pending} history={history} />
    </div>
  );
}
