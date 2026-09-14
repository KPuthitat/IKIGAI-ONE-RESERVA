import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePayrollAccess } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { isDfBranch, eligibleDoctors } from "@/lib/df-db";
import { previewDfRound, dfDoctorDailyCard, mondayOf, sundayOf, getRound, listRoundLines, payMondayFor } from "@/lib/df-rounds";
import { dfDoctorDailyFlex, dfDoctorWeeklyFlex, notifyDoctorDf, type DfDailyCard } from "@/lib/df-line";
import { nameWithPrefix } from "@/lib/name";

// Send a Doctor-Fee LINE card to ONE doctor's personal LINE (owner 2026-09-13),
// mirroring the จ้อจี้/revshare notify flow but per-doctor. PIN-gated: the
// operator verifies the figure, then confirms with PIN before it goes out. Two
// kinds: daily (a day's DF share) and weekly (the round payout summary). Amounts
// are recomputed server-side — never trusted from the client.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Full month names — no abbreviations (owner 2026-09-13).
const TH_MON = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function thDate(iso: string): string { const [y, m, d] = iso.split("-").map(Number); return `${d} ${TH_MON[m]} ${y + 543}`; }
function weekLabel(a: string, b: string): string {
  const [, am, ad] = a.split("-").map(Number); const [by, bm, bd] = b.split("-").map(Number);
  return `${ad}${am === bm ? "" : ` ${TH_MON[am]}`}–${bd} ${TH_MON[bm]} ${by + 543}`;
}
function monthLabel(iso: string): string { const [y, m] = iso.split("-").map(Number); return `${TH_MON[m]} ${y + 543}`; }

function ctx() {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isDfBranch(branchId) };
}

// Assemble the daily card (per-code split + patients + running totals) for one
// doctor+day, or null when they earned no DF that day. Shared by the send (POST)
// and the preview (GET).
function buildDailyCard(branchId: number, userId: number, date: string, doctorName: string, clinicName: string): DfDailyCard | null {
  const data = dfDoctorDailyCard(branchId, date, userId);
  if (!data || data.dayShare <= 0) return null;
  return {
    doctorName, clinicName, dateLabel: thDate(date),
    perCode: data.perCode, patients: data.patients, doctorCount: data.doctorCount, dayShare: data.dayShare,
    weekLabel: weekLabel(mondayOf(date), sundayOf(date)), weekAccum: data.weekAccum,
    monthLabel: monthLabel(date), monthAccum: data.monthAccum
  };
}

// GET the daily card figures for the preview (read-only, no PIN, no send).
export function GET(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const userId = Number(sp.get("userId"));
  const date = sp.get("date") ?? "";
  if (!Number.isInteger(userId) || userId <= 0 || !ISO.test(date)) {
    return NextResponse.json({ error: "bad_params" }, { status: 400 });
  }
  const doc = eligibleDoctors().find((x) => x.user_id === userId);
  if (!doc) return NextResponse.json({ error: "not_a_doctor" }, { status: 400 });
  const u = getDb().prepare("SELECT display_name, title_prefix FROM users WHERE id = ?")
    .get(userId) as { display_name: string; title_prefix: string | null } | undefined;
  const doctorName = nameWithPrefix(u?.title_prefix ?? null, u?.display_name ?? `#${userId}`);
  const clinicName = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)?.name ?? "คลินิก";
  const card = buildDailyCard(branchId!, userId, date, doctorName, clinicName);
  if (!card) return NextResponse.json({ error: "no_df_that_day" }, { status: 404 });
  return NextResponse.json({ ok: true, card });
}

const Body = z.object({
  kind: z.enum(["daily", "weekly"]),
  userId: z.number().int().positive(),
  date: z.string().regex(ISO).optional(),   // daily
  week: z.string().regex(ISO).optional(),   // weekly (any in-week date)
  pin: z.string()
});

export async function POST(req: Request) {
  const { user, branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const status = verifyAdminPin(user.id, d.pin);
  if (!status.ok) return NextResponse.json({ error: status.reason }, { status: status.reason === "no_pin" ? 400 : 403 });

  // The doctor must be eligible on this branch's program.
  const doc = eligibleDoctors().find((x) => x.user_id === d.userId);
  if (!doc) return NextResponse.json({ error: "not_a_doctor" }, { status: 400 });

  // Resolve the doctor's personal LINE + name.
  const u = getDb().prepare("SELECT line_user_id, display_name, title_prefix FROM users WHERE id = ?")
    .get(d.userId) as { line_user_id: string | null; display_name: string; title_prefix: string | null } | undefined;
  if (!u?.line_user_id) {
    return NextResponse.json({ error: "no_line", message: "แพทย์ท่านนี้ยังไม่ได้ผูก LINE ในระบบพนักงาน" }, { status: 400 });
  }
  const doctorName = nameWithPrefix(u.title_prefix, u.display_name);
  const clinicName = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)?.name ?? "คลินิก";

  let flex;
  if (d.kind === "daily") {
    if (!d.date) return NextResponse.json({ error: "date_required" }, { status: 400 });
    if (doc.guarantee_enabled) {
      return NextResponse.json({ error: "guarantee_no_daily", message: "แพทย์ระบบการันตีไม่มีการ์ด DF รายวัน — ใช้สรุปรายสัปดาห์" }, { status: 400 });
    }
    const card = buildDailyCard(branchId!, d.userId, d.date, doctorName, clinicName);
    if (!card) {
      return NextResponse.json({ error: "no_df_that_day", message: "ไม่มีค่าตอบแทน DF ของแพทย์ท่านนี้ในวันดังกล่าว" }, { status: 400 });
    }
    flex = dfDoctorDailyFlex(card);
  } else {
    if (!d.week) return NextResponse.json({ error: "week_required" }, { status: 400 });
    const weekStart = mondayOf(d.week);
    const wkLabel = weekLabel(weekStart, sundayOf(d.week));
    // A PAID week uses its FROZEN snapshot (what was actually transferred); an
    // unpaid week uses the live preview.
    const round = getRound(branchId!, weekStart);
    let card: Parameters<typeof dfDoctorWeeklyFlex>[0] | null = null;
    if (round && round.status === "paid") {
      const fl = listRoundLines(round.id).find((x) => x.user_id === d.userId);
      if (fl) {
        card = {
          doctorName, clinicName, weekLabel: wkLabel, payDateLabel: thDate(payMondayFor(weekStart)),
          workedDays: fl.worked_days,
          grossFee: fl.gross_fee, whtRate: fl.wht_rate, whtAmount: fl.wht_amount, netFee: fl.net_fee,
          isGuarantee: fl.is_guarantee === 1, guaranteeHours: fl.guarantee_hours, guaranteeAmount: fl.guarantee_amount,
          dfEarned: fl.df_earned, deficitBefore: fl.deficit_before, deficitAfter: fl.deficit_after
        };
      }
    } else {
      const line = previewDfRound(branchId!, d.week).doctors.find((x) => x.user_id === d.userId);
      if (line) {
        card = {
          doctorName, clinicName, weekLabel: wkLabel, payDateLabel: thDate(payMondayFor(weekStart)),
          workedDays: line.workedDays,
          grossFee: line.grossFee, whtRate: line.whtRate, whtAmount: line.whtAmount, netFee: line.netFee,
          isGuarantee: line.isGuarantee, guaranteeHours: line.guaranteeHours, guaranteeAmount: line.guaranteeAmount,
          dfEarned: line.dfEarned, deficitBefore: line.deficitBefore, deficitAfter: line.deficitAfter
        };
      }
    }
    if (!card) return NextResponse.json({ error: "no_round_line", message: "ไม่มีค่าตอบแทนของแพทย์ท่านนี้ในสัปดาห์ดังกล่าว" }, { status: 400 });
    flex = dfDoctorWeeklyFlex(card);
  }

  const res = await notifyDoctorDf(u.line_user_id, flex);
  if (!res.ok) {
    const msg = res.error === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า IKIGAI OS platform OA"
      : res.error === "monthly_quota_exceeded" ? "LINE เกินโควตาข้อความรายเดือนแล้ว"
      : "ส่ง LINE ไม่สำเร็จ";
    return NextResponse.json({ error: res.error ?? "send_failed", message: msg }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
