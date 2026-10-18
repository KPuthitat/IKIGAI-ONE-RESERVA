import { requireAdmin } from "@/lib/auth";
import { loadPickerStaff } from "@/lib/staff-picker";
import { listExecMeetings } from "@/lib/exec-meetings";
import ExecMeetingsClient from "./ExecMeetingsClient";

export const dynamic = "force-dynamic";

// ประชุมผู้บริหาร — admin management (owner 2026-09-02). Schedule a meeting and
// invite specific staff; only invitees can join. The invitee picker shows every
// branch of the company side by side (owner 2026-09-02: ซ้าย นามะ ขวา อีเมีย) so
// the whole team is visible at once.
export default function ExecMeetingsPage() {
  const user = requireAdmin();
  const { staff, branches } = loadPickerStaff(user.activeBranchId ?? null);

  const meetings = listExecMeetings();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">ประชุมผู้บริหาร</h1>
        <p className="text-sm text-slate-500">
          ตั้งการประชุมและเลือกผู้ได้รับเชิญ · เฉพาะผู้ได้รับเชิญเท่านั้นจึงกดเข้าร่วมและได้รับเบี้ยประชุม
        </p>
      </div>
      <ExecMeetingsClient staff={staff} branches={branches} meetings={meetings} />
    </div>
  );
}
