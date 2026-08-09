import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { bkkDateIso } from "@/lib/time";
import { getMealpassConfig } from "@/lib/mealpass";
import MealpassConfirmClient, { type PendingOrder } from "./MealpassConfirmClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · ยืนยัน MEALPASS" };

export default function MealpassConfirmPage() {
  const user = requireAdmin();
  const today = bkkDateIso(new Date().toISOString());
  const branchId = user.activeBranchId ?? null;

  const pending: PendingOrder[] = branchId != null
    ? (getDb().prepare(`
        SELECT o.code AS code, u.display_name AS staffName, o.menu_name_snap AS menuName,
               o.meal_class AS mealClass, o.credits AS credits, o.baht AS baht
        FROM mealpass_orders o JOIN users u ON u.id = o.user_id
        WHERE o.branch_id = ? AND o.order_date = ? AND o.kind = 'meal' AND o.status = 'pending'
        ORDER BY o.id ASC`).all(branchId, today) as PendingOrder[])
    : [];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">ยืนยันมื้ออาหาร (MEALPASS)</h1>
        <p className="text-sm text-slate-500 mt-1">พนักงานแสดงรหัส MP-xxxx — กดยืนยันเพื่อตัดเครดิต</p>
      </div>
      {branchId == null
        ? <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน</div>
        : <MealpassConfirmClient pending={pending} config={getMealpassConfig(branchId)} />}
    </div>
  );
}
