import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bkkDateIso } from "@/lib/time";
import {
  listUserCouponsForDate, listEligibleMenu, mealCouponConfig
} from "@/lib/meal-coupons";
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

  // Eligible menu of the branch the staff is currently at — coupons are
  // branch-agnostic; redemption draws from the active branch's list.
  const foodMenu = branchId != null ? listEligibleMenu(branchId, "food") : [];
  const drinkMenu = branchId != null ? listEligibleMenu(branchId, "drink") : [];
  const cutoff = branchId != null ? mealCouponConfig(branchId).redeemCutoff : "15:00";

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับหน้าลงเวลา</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">คูปองของฉัน</h1>
        <p className="text-sm text-slate-500 mt-1">
          คูปองอาหารกลางวัน + เครื่องดื่มของวันนี้ · ใช้ก่อน {cutoff} น. · สาขา {branch?.name ?? "—"}
        </p>
      </div>
      <CouponsClient
        coupons={coupons}
        foodMenu={foodMenu}
        drinkMenu={drinkMenu}
        hasBranch={branchId != null}
      />
    </div>
  );
}
