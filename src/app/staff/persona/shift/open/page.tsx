// /staff/persona/shift/open — เปิดกะ
//
// Staff submits the morning handover (yesterday's closing amount,
// today's drawer amount, 6-item checklist). On save, the server
// stores a row in daily_reports and pushes a Flex card summary into
// the branch's staff LINE group so everyone sees the open status.

import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ShiftOpenForm from "./ShiftOpenForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เปิดกะ · PERSONA" };

export default function ShiftOpenPage() {
  const user = requireUser();
  const lang = getLang();
  if (!user.activeBranchId) {
    return (
      <div className="card">
        <p className="text-slate-600 mb-3">{t(lang, "admin.notAssignedBranch")}</p>
        <Link href="/staff" className="btn-secondary">{t(lang, "common.back")}</Link>
      </div>
    );
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  // Pre-fill yesterday's closing from the most recent shift_close row
  // (if any) so staff doesn't have to re-type the number they already
  // entered the night before.
  const lastClose = db.prepare(`
    SELECT data FROM daily_reports
    WHERE type = 'shift_close' AND branch_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(branch.id) as { data: string } | undefined;
  let yesterdayClosingHint: number | null = null;
  if (lastClose) {
    try {
      const parsed = JSON.parse(lastClose.data) as { closing_drawer_amount?: number };
      if (typeof parsed.closing_drawer_amount === "number") {
        yesterdayClosingHint = parsed.closing_drawer_amount;
      }
    } catch { /* ignore malformed legacy data */ }
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "staff.persona.shift.open.title")}</h1>
        <p className="text-sm text-slate-500">
          {branch.name} · {t(lang, "staff.persona.shift.open.subtitle")}
        </p>
      </div>
      <ShiftOpenForm
        branchName={branch.name}
        openerName={user.display_name}
        today={todayBkk()}
        yesterdayClosingHint={yesterdayClosingHint}
      />
    </div>
  );
}
