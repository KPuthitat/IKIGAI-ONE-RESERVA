"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Topbar brand. Always single-line, regardless of sidebar state.
// "IKIGAI OS • MODULE / ROLE" on inside-module pages, or
// "IKIGAI OS / ROLE PORTAL" on the module-picker landing pages
// (/admin, /staff) — the longer role suffix gives the brand a
// proper title when there's no module name carrying the context.
//
// Mobile keeps just the wordmark + module so the row fits beside
// the language toggle + logout button on ~360 px viewports; the
// "/ role" suffix returns at sm.

const MODULE_BY_PREFIX: Array<[string, string]> = [
  ["/admin/reserva", "RESERVA"],
  ["/admin/persona", "PERSONA"],
  ["/admin/ascenda", "ASCENDA"],
  ["/staff/reserva", "RESERVA"],
  ["/staff/persona", "PERSONA"],
  ["/staff/ascenda", "ASCENDA"]
];

export default function HeaderBrand({ role }: { role: "admin" | "staff" }) {
  const pathname = usePathname() || "";
  const moduleEntry = MODULE_BY_PREFIX.find(([prefix]) =>
    pathname.startsWith(prefix)
  );
  const moduleName = moduleEntry?.[1];

  // Module-picker landing pages get the longer "ROLE PORTAL"
  // suffix; drilled-in pages stay terse since the module name
  // already carries the context.
  const roleLabel = moduleName ? role : `${role} portal`;

  return (
    <div className="flex items-baseline gap-1 whitespace-nowrap text-sm sm:text-base">
      <Link href={`/${role}`} className="brand-wordmark text-white">
        IKIGAI OS
      </Link>
      {moduleName && (
        <>
          <span className="text-white/40 px-0.5">•</span>
          <span className="text-white/85 font-light tracking-[0.5px]">
            {moduleName}
          </span>
        </>
      )}
      <span className="text-white/40 ml-2 hidden sm:inline">/</span>
      <span className="text-white/60 font-light tracking-[1.5px] uppercase hidden sm:inline">
        {roleLabel}
      </span>
    </div>
  );
}
