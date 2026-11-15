import type { Metadata } from "next";
import Link from "next/link";
import { canModule, requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isSalesaBranch } from "@/lib/salesa-db";
import { defaultRange, purchaseTrend, vendorShifts, type Bucket } from "@/lib/purchase-trend";
import PurchaseTrendClient from "./PurchaseTrendClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ซื้อเทียบยอดขาย · ANALYTICA" };

const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const WINDOW: Record<Bucket, number> = { day: 7, week: 4, month: 3 };   // how many buckets make "recent" (vs the same number before)

export default function PurchaseTrendPage({ searchParams }: { searchParams: { b?: string } }) {
  const user = requirePermission("reporta.manage");
  const bucket: Bucket = searchParams.b === "day" || searchParams.b === "month" ? searchParams.b : "week";
  const back = <Link href="/admin/reporta" className="text-sm text-slate-500 hover:text-brand">← กลับ ANALYTICA</Link>;
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) {
    return <div className="space-y-4">{back}<div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div></div>;
  }
  if (!canModule(user, "accounta.manage")) {
    return <div className="space-y-4">{back}<div className="card text-sm text-slate-500">หน้านี้ใช้ข้อมูลรายจ่ายจาก ACCOUNTA — ต้องมีสิทธิ์ ACCOUNTA จึงจะเปิดดูได้</div></div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const { from, to } = defaultRange(bucket, todayBkk());
  const trend = purchaseTrend(db, branchId, from, to, bucket);
  const shifts = vendorShifts(trend, WINDOW[bucket]);
  return (
    <div className="space-y-4">
      {back}
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ซื้อเทียบยอดขาย · {branch?.name ?? `#${branchId}`}</h1>
        <p className="text-sm text-slate-500 mt-1">ซื้อของจากแต่ละผู้ขายเมื่อเทียบกับยอดขาย — ดูว่าสัดส่วนซื้อ ÷ ขายเปลี่ยนไปอย่างไร เพื่อใช้วิเคราะห์การจัดซื้อ</p>
      </div>
      <PurchaseTrendClient trend={trend} shifts={shifts} windowSize={WINDOW[bucket]} />
    </div>
  );
}
