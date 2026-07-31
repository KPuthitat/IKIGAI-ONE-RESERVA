import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { listMyShiftRequests } from "@/lib/shift-requests";
import { listPositions, listShiftCodes } from "@/lib/roster";
import ShiftRequestClient from "./ShiftRequestClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "คำขอเปลี่ยนเวลางาน · IKIGAI OS" };

// Staff self-service: request an extra shift (PT) or swap a day off (FT).
// Extra shift now carries the staff-chosen ตำแหน่ง + เวลา so the admin just
// approves (owner 2026-07-31).
export default function ShiftRequestPage() {
  const user = requireUser();
  const mine = listMyShiftRequests(user.id);
  const branchId = user.activeBranchId;
  const positions = branchId
    ? listPositions(branchId).map((p) => ({ id: p.id, title: p.title })) : [];
  const shiftCodes = branchId
    ? listShiftCodes(branchId).filter((s) => s.kind === "work")
        .map((s) => ({ id: s.id, code: s.code, name: s.name })) : [];
  return <ShiftRequestClient requests={mine} positions={positions} shiftCodes={shiftCodes} />;
}
