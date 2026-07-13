import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { nameWithPrefix } from "@/lib/name";
import { bkkDateIso } from "@/lib/time";
import { userHasWorkShiftOn } from "@/lib/roster";
import { listUserCouponsForDate } from "@/lib/meal-coupons";
import TimeClockClient from "./TimeClockClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · ลงเวลา" };

type TimeEntry = { id: number; type: "in" | "out"; ts: string };

export default function StaffPersonaPage() {
  const user = requireUser();
  const db = getDb();

  // Pull the active branch row so the client knows which anti-cheat
  // gates are enabled (geofence / QR). Without it the clock-in
  // button would naively submit and only learn about the failure
  // from the API error — bad UX. We also pre-feed the branch name
  // so the UI can mention "you must be at NAMA PASTA SRIRACHA" etc.
  const branch = user.activeBranchId
    ? (db.prepare("SELECT * FROM branches WHERE id = ?")
        .get(user.activeBranchId) as Branch | undefined)
    : undefined;

  // Clock state is PER-BRANCH (owner 2026-06-09): a staff who works at two
  // branches must clock in/out at each independently. Scoping by the active
  // branch fixes the cross-branch bug where an 'in' at branch A made branch
  // B show "clock out" (and clocking out at B mis-paired the shift). −1 when
  // no active branch → no rows → shows clock-in (tap then fails cleanly).
  const branchId = user.activeBranchId ?? -1;
  const entries = db.prepare(`
    SELECT id, type, ts FROM time_entries
    WHERE user_id = ? AND branch_id = ? AND ts >= datetime('now', '-7 days')
    ORDER BY ts DESC LIMIT 100
  `).all(user.id, branchId) as TimeEntry[];

  // เลือก entries ของวันนี้ตาม Bangkok local. bkkDateIso is suffix-safe so a
  // ts stored without a "Z" isn't double-shifted into the wrong day
  // (owner 2026-06-13 — fixes entries showing under the wrong date).
  const todayBkk = bkkDateIso(new Date().toISOString());
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
    user.activeBranchId != null &&
    userHasWorkShiftOn(user.id, user.activeBranchId, todayBkk);

  // Today's scheduled shift end (work kind) — drives the OT prompt when
  // a PT staff clocks out after their shift ends (owner 2026-06-03).
  let scheduledEnd: string | null = null;
  if (user.activeBranchId) {
    const sc = db.prepare(`
      SELECT sc.end_time FROM roster_assignments ra
      JOIN shift_codes sc ON sc.id = ra.shift_code_id
      WHERE ra.user_id = ? AND ra.assignment_date = ? AND ra.branch_id = ? AND sc.kind = 'work'
      ORDER BY sc.end_time DESC LIMIT 1
    `).get(user.id, todayBkk, user.activeBranchId) as { end_time: string } | undefined;
    scheduledEnd = sc?.end_time ?? null;
  }

  // Meal coupons for today — surface an entry link to the redeem screen so the
  // staff can find their coupons even after dismissing the clock-in pop-up.
  const coupons = listUserCouponsForDate(user.id, todayBkk);
  const redeemableCoupons = coupons.filter((c) => c.effectiveStatus === "issued").length;

  return (
    <div className="space-y-3">
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
      geofenceEnabled={branch?.geofence_enabled === 1}
      geofenceLat={branch?.latitude ?? null}
      geofenceLng={branch?.longitude ?? null}
      geofenceRadiusMeters={branch?.geofence_radius_meters ?? 100}
      qrEnabled={branch?.clock_qr_enabled === 1}
      isPartTime={userRow?.employment_type === "pt"}
      scheduledEnd={scheduledEnd}
      todayBkk={todayBkk}
      hasShiftToday={hasShiftToday}
      nickname={nickname}
    />
    </div>
  );
}
