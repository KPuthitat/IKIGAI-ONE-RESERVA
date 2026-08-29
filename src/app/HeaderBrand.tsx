"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Topbar brand (owner 2026-08): a two-line wordmark — IKIGAI OS + a
// role/module subtitle — on the dark coffee gradient header, so text is
// white. No logo mark and no bold weight per owner preference; a touch of
// letter-spacing gives the wordmark presence without the heavy weight.

const MODULE_BY_PREFIX: Array<[string, string]> = [
  ["/admin/reserva", "RESERVA"],
  ["/admin/persona", "PERSONA"],
  ["/admin/ascenda", "ASCENDA"],
  ["/admin/accounta", "ACCOUNTA"],
  ["/admin/recruita", "RECRUITA"],
  ["/staff/reserva", "RESERVA"],
  ["/staff/persona", "PERSONA"],
  ["/staff/inventa", "INVENTA"],
  ["/staff/ascenda", "ASCENDA"]
];

export default function HeaderBrand({ role }: { role: "admin" | "staff" }) {
  const pathname = usePathname() || "";
  const moduleEntry = MODULE_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix));
  const moduleName = moduleEntry?.[1];
  const portal = role === "admin" ? "ADMIN CONSOLE" : "STAFF PORTAL";

  return (
    <Link href={`/${role}`} className="block leading-tight min-w-0">
      <span className="block text-white text-[15px] sm:text-base font-normal tracking-[1.5px]">
        IKIGAI OS
      </span>
      <span className="block text-[10px] sm:text-[11px] font-light tracking-[1px] text-white/60 truncate -mt-0.5">
        {moduleName ? `${portal} · ${moduleName}` : portal}
      </span>
    </Link>
  );
}
