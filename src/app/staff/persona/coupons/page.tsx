import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bkkDateIso } from "@/lib/time";
import { resolveDrinkPartner } from "@/lib/partner-drink-orders";
import CouponsClient from "./CouponsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · เบิกเครื่องดื่ม" };

export default function DrinkOrderPage() {
  const user = requireUser();
  const todayBkk = bkkDateIso(new Date().toISOString());
  const branchId = user.activeBranchId ?? null;

  const branch = branchId != null
    ? (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined)
    : undefined;

  const hasDrinkPartner = branchId != null && resolveDrinkPartner(branchId) != null;

  // Drink orders require a clock-in today — except execs / no-clock staff, who
  // never punch (owner 2026-07-31), so they may order any day.
  const isExec = branchId != null && ((getDb().prepare(
    "SELECT COALESCE(track_attendance, 1) AS ta FROM users WHERE id = ?"
  ).get(user.id) as { ta: number } | undefined)?.ta ?? 1) === 0;
  let canOrderDrink = isExec;
  if (branchId != null && !isExec) {
    const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
    const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();
    canOrderDrink = !!getDb().prepare(
      "SELECT 1 FROM time_entries WHERE user_id = ? AND branch_id = ? AND type = 'in' AND ts >= ? AND ts <= ? LIMIT 1"
    ).get(user.id, branchId, startIso, endIso);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">← กลับหน้าลงเวลา</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">เบิกเครื่องดื่ม (จ้อจี้)</h1>
        <p className="text-sm text-slate-500 mt-1">
          สั่งได้ตลอด จ่ายเอง · สาขา {branch?.name ?? "—"} · มื้ออาหารดูที่เมนู MEALPASS
        </p>
      </div>
      <CouponsClient
        hasBranch={branchId != null}
        hasDrinkPartner={hasDrinkPartner}
        canOrderDrink={canOrderDrink}
      />
    </div>
  );
}
