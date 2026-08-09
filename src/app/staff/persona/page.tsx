import type { Metadata } from "next";
import Link from "next/link";
import { requireUser, userCan } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { nameWithPrefix } from "@/lib/name";
import { bkkDateIso } from "@/lib/time";
import { userHasWorkShiftOn, resolveClockBranchId, scheduledWorkBranchesWithNames } from "@/lib/roster";
import { listUserCouponsForDate } from "@/lib/meal-coupons";
import { resolveDrinkPartner } from "@/lib/partner-drink-orders";
import { myOpenActionItemCount } from "@/lib/meetings";
import TimeClockClient from "./TimeClockClient";
import BranchSwitchPrompt from "./BranchSwitchPrompt";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · ลงเวลา" };

type TimeEntry = { id: number; type: "in" | "out"; ts: string; branch?: string | null };

export default function StaffPersonaPage() {
  const user = requireUser();
  const db = getDb();

  // เลือก entries ของวันนี้ตาม Bangkok local. bkkDateIso is suffix-safe so a
  // ts stored without a "Z" isn't double-shifted into the wrong day
  // (owner 2026-06-13 — fixes entries showing under the wrong date).
  const todayBkk = bkkDateIso(new Date().toISOString());

  // Effective clock branch — follow TODAY's roster, exactly like the clock API
  // (owner 2026-07-16). A cross-branch rotator / just-moved staffer rostered at
  // another site today gets that site's geofence, roster gate, per-branch clock
  // state, and buttons WITHOUT having to switch their active branch first.
  // Single-branch staff are unaffected (resolves to their own branch). Staff
  // with no active branch stay null → buttons disabled, matching the API which
  // rejects clock-in with no_active_branch.
  const clockBranchId = user.activeBranchId == null
    ? null
    : resolveClockBranchId(user.id, user.activeBranchId, todayBkk);

  // Pull the resolved branch row so the client knows which anti-cheat gates are
  // enabled (geofence / QR) and can say "you must be at HYPO" etc.
  const branch = clockBranchId
    ? (db.prepare("SELECT * FROM branches WHERE id = ?")
        .get(clockBranchId) as Branch | undefined)
    : undefined;

  // Clock state is PER-BRANCH (owner 2026-06-09): a staff who works at two
  // branches must clock in/out at each independently. Scope by the resolved
  // clock branch so the in/out state matches the branch they'll actually punch
  // at today. −1 when no branch → no rows → shows clock-in (tap then fails cleanly).
  const branchId = clockBranchId ?? -1;
  const entries = db.prepare(`
    SELECT id, type, ts FROM time_entries
    WHERE user_id = ? AND branch_id = ? AND ts >= datetime('now', '-7 days')
    ORDER BY ts DESC LIMIT 100
  `).all(user.id, branchId) as TimeEntry[];
  const todayEntries = entries.filter((e) => bkkDateIso(e.ts) === todayBkk);

  // The 7-day HISTORY list shows ALL branches (owner 2026-08-01: ลงเวลาข้ามสาขา
  // ไม่มีประวัติให้เห็น — อนุธิดาไปช่วยไฮโป 31 ก.ค. แต่หน้าประวัติกรองเฉพาะสาขาหลัก
  // เลยหาย). Clock state above stays per-branch; only the history is cross-branch,
  // tagging the branch name on each punch so a helped-branch day is obvious.
  const historyEntries = db.prepare(`
    SELECT te.id, te.type, te.ts, b.name AS branch
    FROM time_entries te
    LEFT JOIN branches b ON b.id = te.branch_id
    WHERE te.user_id = ? AND te.ts >= datetime('now', '-7 days')
    ORDER BY te.ts DESC LIMIT 100
  `).all(user.id) as TimeEntry[];

  // ส่งเฉพาะ ts ของ in/out แรก ไปให้ client คำนวณ nextAction + 5-min window เอง
  // (ง่ายต่อการ re-evaluate ทุกวินาทีตามนาฬิกาที่วิ่งอยู่)
  const inSorted = todayEntries.filter((e) => e.type === "in").sort((a, b) => a.ts.localeCompare(b.ts));
  const outSorted = todayEntries.filter((e) => e.type === "out").sort((a, b) => a.ts.localeCompare(b.ts));
  const firstInTs = inSorted[0]?.ts ?? null;
  const firstOutTs = outSorted[0]?.ts ?? null;

  // ตรวจว่า user มี PIN หรือยัง + ชื่อเล่นไว้ขึ้นข้อความ "ไม่มีกะ"
  const userRow = db.prepare(
    "SELECT pin_hash, employment_type, nickname_th, first_name_th FROM users WHERE id = ?"
  ).get(user.id) as
    | { pin_hash: string | null; employment_type: "pt" | "ft" | null; nickname_th: string | null; first_name_th: string | null }
    | undefined;
  const hasPin = Boolean(userRow?.pin_hash);
  const nickname = userRow?.nickname_th || userRow?.first_name_th || user.display_name || "";

  // มีกะงานวันนี้ไหม (owner 2026-06-13) — ใช้ disable ปุ่มเข้า/ออกงาน +
  // ขึ้นข้อความ 2 บรรทัดเมื่อไม่มีกะ. วันหยุดก็นับว่าไม่มีกะ.
  const hasShiftToday =
    clockBranchId != null &&
    userHasWorkShiftOn(user.id, clockBranchId, todayBkk);

  // Called in on a day off / holiday (owner 2026-08-03): a non-rejected OT
  // request for today lets the staff clock in even without a rostered shift (the
  // clock route enforces the same rule). Drives the "ขอ OT วันหยุด" button +
  // enabling the เข้างาน button once the request exists. Pending shows "รออนุมัติ".
  const holidayOtRow = db.prepare(
    "SELECT status FROM ot_requests WHERE user_id = ? AND work_date = ? AND status != 'rejected' LIMIT 1"
  ).get(user.id, todayBkk) as { status: string } | undefined;
  const holidayOtStatus: "none" | "pending" | "approved" =
    !holidayOtRow ? "none" : holidayOtRow.status === "approved" ? "approved" : "pending";

  // Today's scheduled shift end (work kind) — drives the OT prompt when
  // a PT staff clocks out after their shift ends (owner 2026-06-03).
  let scheduledEnd: string | null = null;
  if (clockBranchId) {
    const sc = db.prepare(`
      SELECT sc.end_time FROM roster_assignments ra
      JOIN shift_codes sc ON sc.id = ra.shift_code_id
      WHERE ra.user_id = ? AND ra.assignment_date = ? AND ra.branch_id = ? AND sc.kind = 'work'
      ORDER BY sc.end_time DESC LIMIT 1
    `).get(user.id, todayBkk, clockBranchId) as { end_time: string } | undefined;
    scheduledEnd = sc?.end_time ?? null;
  }

  // Meal coupons for today — surface an entry link to the redeem screen so the
  // staff can find their coupons even after dismissing the clock-in pop-up.
  const coupons = listUserCouponsForDate(user.id, todayBkk);
  const redeemableCoupons = coupons.filter((c) => c.effectiveStatus === "issued").length;
  // Drinks have no coupon now (owner 2026-07-31) — still surface the เบิก link when
  // the branch has a จ้อจี้ partner so staff can order a drink.
  const hasDrinkPartner = user.activeBranchId != null && resolveDrinkPartner(user.activeBranchId) != null;

  // จ้อจี้ partner accounts get a shortcut to the drink-redemption scanner.
  const canRedeemDrinks = userCan(user, "partner.drink.redeem");

  // งานที่ได้รับมอบหมายจากการประชุม (owner 2026-08-04) — โชว์การ์ดพร้อมจำนวนงานค้าง.
  const openTaskCount = myOpenActionItemCount(db, user.id);

  // Cross-branch clock-in helper (owner 2026-07-31): if the ACTIVE branch has no
  // shift today but the staff IS rostered at another branch, offer a one-tap
  // switch pop-up so they don't get stuck at "ไม่มีกะ" / wrong-branch gates.
  const scheduledBranches = user.activeBranchId != null
    ? scheduledWorkBranchesWithNames(user.id, todayBkk) : [];
  const activeHasShiftToday = scheduledBranches.some((b) => b.id === user.activeBranchId);
  const branchSwitchOptions = (!activeHasShiftToday && scheduledBranches.length > 0)
    ? scheduledBranches : [];

  // Branch-transfer targets (owner 2026-08-02, "ย้ายสาขาระหว่างวัน"): every OTHER
  // open branch, with the anti-cheat config the client needs to run the
  // destination's geofence/QR/selfie gates before the transfer PIN. Not scoped
  // to company_id — a staffer can be sent to help any branch, mirroring the
  // payroll per-day cross-branch reattribution (which is also company-agnostic).
  // The client only surfaces the button while the staff has an open clock-in.
  const transferTargets = clockBranchId == null ? [] : (db.prepare(`
    SELECT id, name, geofence_enabled, latitude, longitude, geofence_radius_meters,
           clock_qr_enabled, clock_totp_secret, clock_selfie_enabled
    FROM branches
    WHERE status = 'open' AND id != ?
    ORDER BY display_order ASC, name COLLATE NOCASE
  `).all(clockBranchId) as Array<{
    id: number; name: string; geofence_enabled: number;
    latitude: number | null; longitude: number | null; geofence_radius_meters: number | null;
    clock_qr_enabled: number; clock_totp_secret: string | null; clock_selfie_enabled: number;
  }>).map((b) => ({
    id: b.id,
    name: b.name,
    geofenceEnabled: b.geofence_enabled === 1 || b.clock_totp_secret != null,
    geofenceLat: b.latitude,
    geofenceLng: b.longitude,
    geofenceRadiusMeters: b.geofence_radius_meters ?? 100,
    qrEnabled: b.clock_qr_enabled === 1 || b.clock_totp_secret != null,
    selfieEnabled: b.clock_selfie_enabled === 1
  }));

  return (
    <div className="space-y-3">
      {branchSwitchOptions.length > 0 && (
        <BranchSwitchPrompt nickname={nickname} branches={branchSwitchOptions} />
      )}
      {canRedeemDrinks && (
        <Link
          href="/staff/persona/drink-scan"
          className="block rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-bold text-violet-900 hover:bg-violet-100 transition"
        >
          สแกนรับเครื่องดื่ม (จ้อจี้) →
        </Link>
      )}
      {user.activeBranchId != null && (
        <Link
          href="/staff/persona/mealpass"
          className="block rounded-xl px-4 py-3 text-sm font-semibold text-white hover:opacity-90 transition"
          style={{ background: "#0B1F3A" }}
        >
          🦉 MEALPASS · เครดิตมื้ออาหารของฉัน →
        </Link>
      )}
      {(coupons.length > 0 || hasDrinkPartner) && (
        <Link
          href="/staff/persona/coupons"
          className="block rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 hover:bg-amber-100 transition"
        >
          คูปอง / เบิกเครื่องดื่ม{redeemableCoupons > 0 ? ` · ${redeemableCoupons} ใบพร้อมใช้` : ""} →
        </Link>
      )}
      {openTaskCount > 0 && (
        <Link
          href="/staff/persona/tasks"
          className="block rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900 hover:bg-sky-100 transition"
        >
          งานที่ได้รับมอบหมาย · {openTaskCount} งานค้าง →
        </Link>
      )}
      <Link
        href="/staff/persona/report"
        className="block rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 hover:bg-emerald-100 transition"
      >
        ส่งรายงานปิดกะ / เรื่องเข้าประชุม →
      </Link>
      <TimeClockClient
      userName={nameWithPrefix(user.title_prefix, user.display_name)}
      hasPin={hasPin}
      firstInTs={firstInTs}
      firstOutTs={firstOutTs}
      entries={historyEntries}
      branchName={branch?.name ?? null}
      geofenceEnabled={branch?.geofence_enabled === 1 || branch?.clock_totp_secret != null}
      geofenceLat={branch?.latitude ?? null}
      geofenceLng={branch?.longitude ?? null}
      geofenceRadiusMeters={branch?.geofence_radius_meters ?? 100}
      qrEnabled={branch?.clock_qr_enabled === 1 || branch?.clock_totp_secret != null}
      selfieEnabled={branch?.clock_selfie_enabled === 1}
      isPartTime={userRow?.employment_type === "pt"}
      scheduledEnd={scheduledEnd}
      todayBkk={todayBkk}
      hasShiftToday={hasShiftToday}
      nickname={nickname}
      transferTargets={transferTargets}
      holidayOtStatus={holidayOtStatus}
    />
    </div>
  );
}
