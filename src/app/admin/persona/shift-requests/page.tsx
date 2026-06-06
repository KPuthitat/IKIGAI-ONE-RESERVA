import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { listPendingShiftRequests } from "@/lib/shift-requests";
import {
  listPositions, listShiftCodes, getRegularPositionId,
  occupiedPositionIdsOnDate, userPositionOnDate, defaultWorkShiftCodeId
} from "@/lib/roster";
import ShiftRequestsAdminClient, { type RosterCtx } from "./ShiftRequestsAdminClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "คำขอเปลี่ยนเวลางาน · PERSONA" };

// Supervisor/admin review of staff shift-change requests (extra shift /
// day swap). Approving now writes straight into the roster (owner
// 2026-06-06): pick a free slot, PIN-confirm, done.
export default function ShiftRequestsAdminPage() {
  const user = requireAdmin();
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">ยังไม่ได้เลือกสาขา</div>;
  }
  const branchId = user.activeBranchId;
  const pending = listPendingShiftRequests(branchId);
  const positions = listPositions(branchId).map((p) => ({ id: p.id, title: p.title }));
  const shiftCodes = listShiftCodes(branchId).map((s) => ({
    id: s.id, code: s.code, name: s.name, kind: s.kind
  }));
  const defaultShiftCodeId = defaultWorkShiftCodeId(branchId);

  // Per-request roster context for the approve-and-assign modal.
  const rosterCtx: Record<number, RosterCtx> = {};
  for (const r of pending) {
    rosterCtx[r.id] = {
      regularPositionId: getRegularPositionId(branchId, r.user_id),
      occupiedWork: occupiedPositionIdsOnDate(branchId, r.work_date),
      offDatePositionId: r.kind === "swap" && r.off_date
        ? userPositionOnDate(branchId, r.user_id, r.off_date)
        : null
    };
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">คำขอเปลี่ยนเวลางาน</h1>
        <p className="text-sm text-slate-500">
          คำขอขอเพิ่มกะ / สลับวันหยุดที่รออนุมัติ · อนุมัติแล้วระบบจะ<b>จัดลงตารางงานให้ทันที</b>
          (เลือกตำแหน่งว่าง → ยืนยันด้วย PIN)
        </p>
      </div>
      <ShiftRequestsAdminClient
        pending={pending}
        positions={positions}
        shiftCodes={shiftCodes}
        defaultShiftCodeId={defaultShiftCodeId}
        rosterCtx={rosterCtx}
      />
    </div>
  );
}
