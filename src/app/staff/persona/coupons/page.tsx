import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bkkDateIso } from "@/lib/time";
import {
  listUserCouponsForDate, listEligibleMenu, mealCouponConfig
} from "@/lib/meal-coupons";
import { resolveDrinkPartner } from "@/lib/partner-drink-orders";
import CouponsClient from "./CouponsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · คูปองของฉัน" };

export default function MealCouponsPage() {
  const user = requireUser();
  const todayBkk = bkkDateIso(new Date().toISOString());
  const coupons = listUserCouponsForDate(user.id, todayBkk);

  const branchId = user.activeBranchId ?? null;
  const branch = branchId != null
    ? (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)
    : undefined;

  // Food still redeems from the branch's Delivera menu (coupon-gated). Drinks are
  // now fulfilled by the branch's จ้อจี้ partner — no coupon, unlimited, self-paid,
  // available once the staff has clocked in today (owner 2026-07-31).
  const foodMenu = branchId != null ? listEligibleMenu(branchId, "food") : [];
  const cutoff = branchId != null ? mealCouponConfig(branchId).redeemCutoff : "15:00";
  const hasDrinkPartner = branchId != null && resolveDrinkPartner(branchId) != null;

  // Drink orders require the staff to have clocked IN today at this branch.
  let clockedInToday = false;
  if (branchId != null) {
    const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
    const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();
    clockedInToday = !!getDb().prepare(
      "SELECT 1 FROM time_entries WHERE user_id = ? AND branch_id = ? AND type = 'in' AND ts >= ? AND ts <= ? LIMIT 1"
    ).get(user.id, branchId, startIso, endIso);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับหน้าลงเวลา</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">คูปอง / เบิกของฉัน</h1>
        <p className="text-sm text-slate-500 mt-1">
          คูปองอาหารกลางวัน (ใช้ก่อน {cutoff} น.) + เครื่องดื่มจ้อจี้ (สั่งได้ตลอด จ่ายเอง) · สาขา {branch?.name ?? "—"}
        </p>
      </div>
      <CouponsClient
        coupons={coupons}
        foodMenu={foodMenu}
        hasBranch={branchId != null}
        hasDrinkPartner={hasDrinkPartner}
        clockedInToday={clockedInToday}
      />
    </div>
  );
}
