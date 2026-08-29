"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import OwlMascot from "./components/OwlMascot";

// Topbar brand — PGH-style (owner 2026-08): the น้องฮูก logo + a two-line
// wordmark (IKIGAI OS + a role/module subtitle). Sits on the dark coffee
// gradient header, so text is white. The module name, when inside a module,
// rides in the subtitle so the brand block always says where you are without
// a separate crumb.

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
    <Link href={`/${role}`} className="flex items-center gap-2.5 min-w-0">
      <span className="grid place-items-center w-9 h-9 rounded-xl bg-white/10 border border-white/20 flex-shrink-0">
        <OwlMascot size={26} ariaLabel="IKIGAI OS" />
      </span>
      <span className="leading-tight min-w-0">
        <span className="block brand-wordmark text-white text-[15px] sm:text-base">
          IKIGAI OS
        </span>
        <span className="block text-[10px] sm:text-[11px] font-light tracking-[1px] text-white/60 truncate -mt-0.5">
          {moduleName ? `${portal} · ${moduleName}` : portal}
        </span>
      </span>
    </Link>
  );
}
