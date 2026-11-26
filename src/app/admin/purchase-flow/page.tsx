import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { viewerOf } from "@/lib/purchasing";
import FlowTrackerClient from "./FlowTrackerClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ติดตามการจัดซื้อ" };

// Where is every purchase right now, and who is it waiting for (owner 2026-11-26).
export default function PurchaseFlowPage() {
  const user = requireUser();
  const v = viewerOf(user);
  if (user.role === "staff" && !v.isCLevel) redirect("/admin");
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ติดตามการจัดซื้อ</h1>
        <p className="text-sm text-slate-500">ทุกรายการที่ยังไม่เสร็จ — อยู่ขั้นไหน ใครลงนาม/อนุมัติแล้ว และกำลังรอใครอยู่ · ซื้อของเล็กน้อยไม่ต้องทำ Memo ได้ โดย <Link className="text-brand underline" href="/admin/accounta/purchasing">เปิดใบขอซื้อ (PR) ตรง</Link> ขั้น Memo จะแสดงว่า “ข้าม”</p>
      </div>
      <FlowTrackerClient />
    </div>
  );
}
