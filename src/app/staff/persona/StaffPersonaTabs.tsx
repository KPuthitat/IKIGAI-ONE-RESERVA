"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function StaffPersonaTabs({
  labels
}: {
  labels: { clock: string; leave: string; resignation: string };
}) {
  const pathname = usePathname();
  const isLeave = pathname?.startsWith("/staff/persona/leave");
  const isResignation = pathname?.startsWith("/staff/persona/resignation");
  const isMeeting = pathname?.startsWith("/staff/persona/exec-meetings");
  const isClock = !isLeave && !isResignation && !isMeeting;

  const cls = (active: boolean) =>
    `flex-1 text-center py-2 rounded-lg text-sm font-medium transition ${
      active ? "bg-brand text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
    }`;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-1.5 flex gap-1">
      <Link href="/staff/persona" className={cls(isClock)}>{labels.clock}</Link>
      <Link href="/staff/persona/leave" className={cls(isLeave)}>{labels.leave}</Link>
      <Link href="/staff/persona/exec-meetings" className={cls(isMeeting)}>ประชุม</Link>
      <Link href="/staff/persona/resignation" className={cls(isResignation)}>{labels.resignation}</Link>
    </div>
  );
}
