import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { listMyShiftRequests } from "@/lib/shift-requests";
import ShiftRequestClient from "./ShiftRequestClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "คำขอเปลี่ยนเวลางาน · IKIGAI OS" };

// Staff self-service: request an extra shift (PT) or swap a day off (FT).
// v1 records + notifies the manager; the admin reflects it in the roster.
export default function ShiftRequestPage() {
  const user = requireUser();
  const mine = listMyShiftRequests(user.id);
  return <ShiftRequestClient requests={mine} />;
}
