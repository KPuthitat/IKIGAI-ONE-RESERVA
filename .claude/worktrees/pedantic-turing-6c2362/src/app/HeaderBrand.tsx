"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// IKIGAI OS•MODULE / ROLE  (centered, role = thin uppercase)

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

  return (
    <div className="flex items-baseline gap-1 whitespace-nowrap text-base">
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
      <span className="text-white/40 ml-2">/</span>
      <span className="text-white/60 font-light tracking-[1.5px] uppercase">
        {role}
      </span>
    </div>
  );
}
