import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { listPendingShiftRequests } from "@/lib/shift-requests";
import ShiftRequestsAdminClient from "./ShiftRequestsAdminClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "คำขอเปลี่ยนเวลางาน · PERSONA" };

// Supervisor/admin review of staff shift-change requests (extra shift /
// day swap). Approval records the decision + notifies the staff; the
// admin then reflects it in the roster manually.
export default function ShiftRequestsAdminPage() {
  const user = requireAdmin();
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">ยังไม่ได้เลือกสาขา</div>;
  }
  const pending = listPendingShiftRequests(user.activeBranchId);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">คำขอเปลี่ยนเวลางาน</h1>
        <p className="text-sm text-slate-500">
          คำขอขอเพิ่มกะ / สลับวันหยุดที่รออนุมัติ · อนุมัติแล้วระบบจะแจ้งพนักงาน —
          จากนั้นจัดลงตารางงาน (Roster) ให้ด้วย
        </p>
      </div>
      <ShiftRequestsAdminClient pending={pending} />
    </div>
  );
}
