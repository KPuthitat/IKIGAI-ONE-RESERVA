import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { listPendingEarlyLeave } from "@/lib/early-leave";
import EarlyLeaveAdminClient from "./EarlyLeaveAdminClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · ขออนุมัติออกก่อน" };

export default function EarlyLeaveAdminPage() {
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

  const pending = listPendingEarlyLeave(branchId);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">← กลับ PERSONA</Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">คำขออนุมัติออกก่อนเวลา</h1>
        <p className="text-sm text-slate-500 mt-1">
          พนักงานที่เบิกอาหารกลางวันแล้วต้องกลับก่อนครบกะ ขออนุมัติไว้ที่นี่ — <b>อนุมัติ</b> แล้วจะไม่โดนหักค่าเครดิตอาหารจาก Service Charge
        </p>
      </div>
      <EarlyLeaveAdminClient key={branchId} pending={pending} />
    </div>
  );
}
