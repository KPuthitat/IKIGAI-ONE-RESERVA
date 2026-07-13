import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listMenu } from "@/lib/delivera/orders";
import { mealCouponConfig, listCouponMenuAdmin, mealCouponMonthlyReport } from "@/lib/meal-coupons";
import MealCouponsClient from "./MealCouponsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · คูปองอาหาร" };

function bkkMonth(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7); // YYYY-MM
}

export default function MealCouponsAdminPage({
  searchParams
}: { searchParams: { month?: string } }) {
  const user = requireAdmin();
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  const db = getDb();
  const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const config = mealCouponConfig(branchId);
  const couponMenu = listCouponMenuAdmin(branchId);
  // All of this branch's Delivera menu items — the pool the admin picks from.
  const deliveraMenu = listMenu(branchId).map((m) => ({
    id: m.id, name_th: m.name_th, category: m.category, is_available: m.is_available
  }));
  // Distinct work-shift start times at this branch → the eligible-start choices.
  const shiftStarts = (db.prepare(
    "SELECT DISTINCT start_time FROM shift_codes WHERE branch_id = ? AND active = 1 AND kind = 'work' ORDER BY start_time"
  ).all(branchId) as Array<{ start_time: string }>).map((r) => r.start_time);

  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? searchParams.month! : bkkMonth();
  const report = mealCouponMonthlyReport(branchId, month);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">คูปองอาหารพนักงาน</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · พนักงานที่กดเข้างานกะที่กำหนด จะได้คูปองอาหารกลางวัน + เครื่องดื่ม
          เลือกจากเมนู Delivera ที่ตั้งไว้ ใช้ก่อนเวลาหมดอายุ
        </p>
      </div>
      <MealCouponsClient
        key={branchId}
        config={config}
        couponMenu={couponMenu}
        deliveraMenu={deliveraMenu}
        shiftStarts={shiftStarts}
        report={report}
        month={month}
      />
    </div>
  );
}
