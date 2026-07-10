// /staff/persona/shift/close — เช็คลิสต์หลังเลิกงาน
//
// One submission per (branch, date). Same lock + edit-request flow
// as the other 3 daily-report types. The form takes a closing-drawer
// amount + the per-branch checklist; the next day's pre-shift form
// reads this row's `data.closing_drawer_amount` to pre-fill its
// "ยอดเงินปิดกะเมื่อวาน" hint.

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem } from "@/lib/db";
import { listShiftCloseChannels, materialPurchaseQuota, ledgerDashboard } from "@/lib/accounta-db";
import { parseChecklistOptions } from "@/lib/checklist-options";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import ShiftCloseForm from "./ShiftCloseForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Check list หลังเลิกงาน · PERSONA" };

export default function ShiftClosePage({
  searchParams
}: { searchParams: { date?: string } }) {
  const user = requireUser();
  const lang = getLang();
  if (user.branches.length === 0) {
    return (
      <div className="card">
        <p className="text-slate-600 mb-3">{t(lang, "admin.notAssignedBranch")}</p>
        <Link href="/staff" className="btn-secondary">{t(lang, "common.back")}</Link>
      </div>
    );
  }
  if (!user.activeBranchId) {
    redirect(`/staff/branch-picker?next=${encodeURIComponent("/staff/persona/shift/close")}`);
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  const today = todayBkk();
  const typeLabel = t(lang, "staff.persona.shiftReport.typeLabel.shiftClose");

  // 7-day back-date/edit window (owner 2026-06-22): today + 6 days back.
  const windowDates = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.now() + 7 * 3600_000 - i * 86400_000).toISOString().slice(0, 10)
  );
  const selectedDate = searchParams.date && windowDates.includes(searchParams.date)
    ? searchParams.date : today;

  // Which dates in the window already have a live report (for the pill ✓).
  const submitted = new Set(
    (db.prepare(
      "SELECT report_date FROM daily_reports WHERE type='shift_close' AND branch_id=? AND superseded_at IS NULL AND report_date >= ?"
    ).all(branch.id, windowDates[6]) as Array<{ report_date: string }>).map((r) => r.report_date)
  );

  // The live report for the selected date → pre-fill + edit mode.
  const liveRow = db.prepare(
    "SELECT data FROM daily_reports WHERE type='shift_close' AND branch_id=? AND report_date=? AND superseded_at IS NULL"
  ).get(branch.id, selectedDate) as { data: string } | undefined;
  let previousData: Record<string, unknown> | null = null;
  const isEdit = !!liveRow;
  if (liveRow) {
    try { previousData = JSON.parse(liveRow.data); } catch { previousData = null; }
  }

  const checklist = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'shift_close' AND branch_id = ? AND active = 1
    ORDER BY display_order ASC, id ASC
  `).all(branch.id) as ShiftChecklistItem[];

  const dayLabel = (d: string) => {
    if (d === today) return "วันนี้";
    const [y, m, dd] = d.split("-").map(Number);
    return `${dd}/${m}`;
  };

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold">{typeLabel}</h1>
        <p className="text-sm text-slate-500">{branch.name}</p>
      </div>

      {/* Date selector — submit/edit within the last 7 days (owner 2026-06-22). */}
      <div className="card space-y-1.5">
        <div className="text-xs font-bold text-slate-600">เลือกวันที่ของรายงาน (ย้อนหลังได้ 7 วัน)</div>
        <div className="flex flex-wrap gap-1.5">
          {windowDates.map((d) => (
            <Link key={d} href={`/staff/persona/shift/close?date=${d}`}
              className={`text-xs px-2.5 py-1.5 rounded-md border ${
                d === selectedDate
                  ? "bg-brand text-white border-brand"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}>
              {dayLabel(d)}{submitted.has(d) ? " ✓" : ""}
            </Link>
          ))}
        </div>
        <p className="text-[11px] text-slate-400">
          ✓ = ส่งแล้ว (กดเพื่อแก้ไข) · ของเดิมจะถูกเก็บเป็นประวัติ
        </p>
      </div>

      <ShiftCloseForm
        reportDate={selectedDate}
        isEdit={isEdit}
        branchId={branch.id}
        branchName={branch.name}
        closerName={nameWithPrefix(user.title_prefix, user.display_name)}
        requireServiceCharge={branch.require_service_charge === 1}
        requireTodayClosing={branch.require_today_closing === 1}
        requireDailyRevenue={branch.require_daily_revenue === 1}
        // Master income channels — staff fill a mandatory per-channel
        // breakdown that must reconcile to ยอดขายวันนี้ before they can
        // submit (owner 2026-06-21). Only relevant when the branch records
        // daily revenue; the form gates the panel on requireDailyRevenue.
        incomeChannels={branch.require_daily_revenue === 1 ? listShiftCloseChannels(branch.id) : []}
        // Material-purchase quota for today (owner 2026-06-21). null when the
        // branch hasn't enabled it. The form shows today's quota + records how
        // much was ordered, flagging over-quota on the report.
        materialQuota={(() => { const md = ledgerDashboard(branch.id, "month", selectedDate); return materialPurchaseQuota(branch.id, selectedDate, md.forecast, md.salesRevenue); })()}
        previousData={previousData}
        // Per-branch headline label + order + in-red-box knobs.
        // The form forwards these into the live FlexPreview so the
        // staff sees what the LINE Flex card will actually look like
        // (custom labels + chosen order) before they hit submit.
        defaultFieldConfig={{
          // Fixed layout (owner 2026-06-09): only ยอดขายวันนี้ in the red
          // box; ปิดกะ + เซอร์วิสชาร์จ as bold rows. Mirrors the LINE card.
          closing_drawer: {
            label: branch.sc_drawer_label || "ยอดเงินปิดกะวันนี้",
            display_order: branch.sc_drawer_order,
            in_red_box: false
          },
          service_charge: {
            label: branch.sc_svc_label || "เซอร์วิสชาร์จวันนี้",
            display_order: branch.sc_svc_order,
            in_red_box: false
          },
          daily_revenue: {
            label: branch.sc_revenue_label || "ยอดขายวันนี้",
            display_order: branch.sc_revenue_order,
            in_red_box: true
          }
        }}
        checklistItems={checklist
          .map((c) => ({
            id: c.id,
            label: c.label,
            kind: (c.kind ?? "checkbox") as "checkbox" | "text" | "choice" | "amount" | "section",
            options: c.kind === "choice" ? parseChecklistOptions(c) : undefined,
            parent_id: c.parent_id ?? null,
            is_headline: !!c.is_headline_amount,
            description: c.description ?? null
          }))
          .filter((c) => c.kind !== "choice" || (c.options?.length ?? 0) >= 2)}
      />
    </div>
  );
}
