"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function StaffPersonaTabs({
  labels
}: {
  labels: { clock: string; leave: string };
}) {
  const pathname = usePathname();
  const isLeave = pathname?.startsWith("/staff/persona/leave");
  const isClock = !isLeave;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-1.5 flex gap-1">
      <Link
        href="/staff/persona"
        className={`flex-1 text-center py-2 rounded-lg text-sm font-medium transition ${
          isClock
            ? "bg-brand text-white shadow-sm"
            : "text-slate-600 hover:bg-slate-50"
        }`}
      >
        ⏰ {labels.clock}
      </Link>
      <Link
        href="/staff/persona/leave"
        className={`flex-1 text-center py-2 rounded-lg text-sm font-medium transition ${
          isLeave
            ? "bg-brand text-white shadow-sm"
            : "text-slate-600 hover:bg-slate-50"
        }`}
      >
        🌴 {labels.leave}
      </Link>
    </div>
  );
}
