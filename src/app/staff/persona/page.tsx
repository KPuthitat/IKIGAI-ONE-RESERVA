import type { Metadata } from "next";
import Link from "next/link";
import { requireUser, userCan } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { nameWithPrefix } from "@/lib/name";
import { bkkDateIso } from "@/lib/time";
import { userHasWorkShiftOn, resolveClockBranchId } from "@/lib/roster";
import { listUserCouponsForDate } from "@/lib/meal-coupons";
import TimeClockClient from "./TimeClockClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · ลงเวลา" };

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

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

  // จ้อจี้ partner accounts get a shortcut to the drink-redemption scanner.
  const canRedeemDrinks = userCan(user, "partner.drink.redeem");

  return (
    <div className="space-y-3">
      {canRedeemDrinks && (
        <Link
          href="/staff/persona/drink-scan"
          className="block rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-bold text-violet-900 hover:bg-violet-100 transition"
        >
          สแกนรับเครื่องดื่ม (จ้อจี้) →
        </Link>
      )}
      {coupons.length > 0 && (
        <Link
          href="/staff/persona/coupons"
          className="block rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 hover:bg-amber-100 transition"
        >
          คูปองของฉัน{redeemableCoupons > 0 ? ` · ${redeemableCoupons} ใบพร้อมใช้` : " · ใช้แล้ว/หมดอายุ"} →
        </Link>
      )}
      <TimeClockClient
      userName={nameWithPrefix(user.title_prefix, user.display_name)}
      hasPin={hasPin}
      firstInTs={firstInTs}
      firstOutTs={firstOutTs}
      entries={entries}
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
    />
    </div>
  );
}
