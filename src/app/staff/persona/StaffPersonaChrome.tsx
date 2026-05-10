"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import StaffPersonaTabs from "./StaffPersonaTabs";

// Shared chrome (back link + module title + 3-tab strip) for the
// PERSONA staff area. Renders nothing on sub-flow paths that are meant
// to feel standalone (currently the shift handover form). Each
// sub-flow is responsible for providing its own back link + heading.
//
// Hidden when pathname starts with one of HIDE_PREFIXES.
const HIDE_PREFIXES = ["/staff/persona/shift"];

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
  if (HIDE_PREFIXES.some((p) => pathname.startsWith(p))) {
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
