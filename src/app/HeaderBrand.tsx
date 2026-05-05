"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// แสดง breadcrumb ในส่วน header:
//   IKIGAI OS (bold)  •  MODULE (thin)  /  admin|staff
// MODULE จะปรากฏเมื่ออยู่ภายใต้ /admin/<module> หรือ /staff/<module>

const MODULE_BY_PREFIX: Array<[string, string]> = [
  ["/admin/reserva", "RESERVA"],
  ["/admin/persona", "PERSONA"],
  ["/staff/reserva", "RESERVA"],
  ["/staff/persona", "PERSONA"]
];

export default function HeaderBrand({ role }: { role: "admin" | "staff" }) {
  const pathname = usePathname() || "";
  const moduleEntry = MODULE_BY_PREFIX.find(([prefix]) =>
    pathname.startsWith(prefix)
  );
  const moduleName = moduleEntry?.[1];

  return (
    <div className="flex items-baseline gap-2">
      <Link href={`/${role}`} className="brand-wordmark text-white text-lg">
        IKIGAI OS
      </Link>
      {moduleName && (
        <>
          <span className="text-white/40 text-xs">•</span>
          <span className="text-white/85 text-base font-light tracking-[1px]">
            {moduleName}
          </span>
        </>
      )}
      <span className="text-white/40 text-xs">/</span>
      <span className="text-white/60 text-xs tracking-[1px]">{role}</span>
    </div>
  );
}
