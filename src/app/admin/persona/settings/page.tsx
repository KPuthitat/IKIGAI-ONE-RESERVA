// /admin/persona/settings — per-branch PERSONA settings.
//
// Phase 1 (this file): readiness round times only — admin sets the
// morning + afternoon HH:MM that the staff form and LINE Flex card
// will display for this branch. Server passes the current branch's
// existing values to a client component which posts the edits back.
//
// The active branch comes from the session (set via topbar pill);
// admin switches branches there, not here.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import BranchSettingsForm from "./BranchSettingsForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตั้งค่าสาขา · PERSONA" };

export default function PersonaSettingsPage() {
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
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.settings.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.settings.subtitle")}
        </p>
      </div>

      <BranchSettingsForm
        morningTime={branch.readiness_morning_time}
        afternoonTime={branch.readiness_afternoon_time}
        brandColor={branch.brand_color}
        latitude={branch.latitude}
        longitude={branch.longitude}
        geofenceRadiusMeters={branch.geofence_radius_meters}
        geofenceEnabled={branch.geofence_enabled === 1}
        clockQrToken={branch.clock_qr_token}
        clockQrEnabled={branch.clock_qr_enabled === 1}
        requireServiceCharge={branch.require_service_charge === 1}
        requireYesterdayClosing={branch.require_yesterday_closing === 1}
        requireMorningOpening={branch.require_morning_opening === 1}
        requireTodayClosing={branch.require_today_closing === 1}
        requireDailyRevenue={branch.require_daily_revenue === 1}
        attendanceSummaryTime={branch.attendance_summary_time}
        shiftNotifyTime={branch.shift_notify_time}
        branchName={branch.name}
      />
    </div>
  );
}
