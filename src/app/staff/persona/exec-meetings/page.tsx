import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listExecMeetingsForUser, getStaffMeetingView, type StaffMeetingView } from "@/lib/exec-meetings";
import ExecMeetingStaffClient from "./ExecMeetingStaffClient";

export const dynamic = "force-dynamic";

// ประชุมผู้บริหาร — staff view (owner 2026-09-02). Every staff member can open
// this menu, but only invitees can join. Join replaces clock-in (must have
// clocked out of work first); minutes (4 fields) are required before สิ้นสุด
// การประชุม, which pays เบี้ยประชุม by minutes attended.
export default function StaffExecMeetingsPage() {
  const user = getSessionUser();
  if (!user) redirect("/login");

  const invited = listExecMeetingsForUser(user.id);
  const views = invited
    .map((m) => getStaffMeetingView(m.id, user.id))
    .filter((v): v is StaffMeetingView => v != null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800">ประชุมผู้บริหาร</h1>
        <p className="text-sm text-slate-500">
          เฉพาะผู้ได้รับเชิญจึงกดเข้าร่วมได้ · ต้องลงเวลาออกงานก่อน · กรอกรายงานให้ครบก่อนสิ้นสุดการประชุม
        </p>
      </div>
      <ExecMeetingStaffClient meetings={views} />
    </div>
  );
}
