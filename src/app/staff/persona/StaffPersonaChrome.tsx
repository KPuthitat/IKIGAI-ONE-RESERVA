"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import StaffPersonaTabs from "./StaffPersonaTabs";

// Shared chrome (back link + module title + 3-tab strip) for the
// PERSONA staff area. The tabs only make sense on the three main
// destinations they navigate between (clock-in, leave, resignation).
// On every other sub-flow (shift handover, calendar, discipline,
// profile, time-certification, etc.) the tabs were appearing as
// unrelated floating UI — the owner asked for them to be scoped to
// the main 3 only, so we flip to an allow-list:
//   • /staff/persona             → clock (root)
//   • /staff/persona/leave       → leave + subroutes
//   • /staff/persona/resignation → resignation + subroutes
// Anything else returns null. Each sub-flow already provides its
// own back link + heading, so removing the chrome leaves a clean
// standalone surface.
const SHOW_PREFIXES = [
  "/staff/persona/leave",
  "/staff/persona/resignation"
];

export default function StaffPersonaChrome({
  labels
}: {
  labels: {
    back: string;
    moduleTitle: string;
    clock: string;
    leave: string;
    resignation: string;
  };
}) {
  const pathname = usePathname() ?? "";
  const isClockRoot = pathname === "/staff/persona" || pathname === "/staff/persona/";
  const isTabRoute = isClockRoot || SHOW_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isTabRoute) {
    return null;
  }
  return (
    <>
      <div>
        <Link href="/staff" className="text-sm text-slate-500 hover:text-brand">
          {labels.back}
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">
          {labels.moduleTitle}
        </h1>
      </div>
      <StaffPersonaTabs
        labels={{
          clock: labels.clock,
          leave: labels.leave,
          resignation: labels.resignation
        }}
      />
    </>
  );
}
