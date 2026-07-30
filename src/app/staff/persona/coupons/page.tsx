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

  // Food coupon still redeems from the branch's Delivera menu. The DRINK coupon
  // is now fulfilled by the branch's จ้อจี้ partner (paid, via QR) — owner
  // 2026-07-30 — so it no longer uses the internal drink menu.
  const foodMenu = branchId != null ? listEligibleMenu(branchId, "food") : [];
  const cutoff = branchId != null ? mealCouponConfig(branchId).redeemCutoff : "15:00";
  const hasDrinkPartner = branchId != null && resolveDrinkPartner(branchId) != null;

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
        hasBranch={branchId != null}
        hasDrinkPartner={hasDrinkPartner}
      />
    </div>
  );
}
