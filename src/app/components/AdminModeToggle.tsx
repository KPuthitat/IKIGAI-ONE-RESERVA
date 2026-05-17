"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLang } from "@/lib/LangProvider";

// A segmented STAFF / ADMIN switch shown ONLY to users granted admin
// rights (the layout decides whether to mount it). An admin is an
// employee first — they live in employee mode and flip this to enter
// the admin console. Active side is derived from the current path so
// the toggle always reflects where you actually are.
//
//   TH: พนักงาน | ผู้ดูแลระบบ      EN: STAFF | ADMIN
//   heading: "ADMIN CONSOLE"
export default function AdminModeToggle() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { lang } = useLang();

  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

  const L = lang === "en"
    ? { heading: "ADMIN CONSOLE", staff: "STAFF", admin: "ADMIN" }
    : { heading: "ADMIN CONSOLE", staff: "พนักงาน", admin: "ผู้ดูแลระบบ" };

  const go = (toAdmin: boolean) => {
    if (toAdmin === inAdmin) return;
    router.push(toAdmin ? "/admin" : "/staff");
  };

  const segBase =
    "flex-1 text-center text-xs font-bold py-1.5 rounded-md transition-colors cursor-pointer select-none";
  const active = "bg-brand text-white shadow";
  const idle = "text-white/60 hover:text-white";

  return (
    <div>
      <div className="text-[10px] font-bold tracking-[1.5px] text-white/40 uppercase mb-1.5">
        {L.heading}
      </div>
      <div
        className="flex items-center gap-1 p-1 rounded-lg bg-white/10"
        role="tablist"
        aria-label={L.heading}
      >
        <button
          type="button"
          role="tab"
          aria-selected={!inAdmin}
          onClick={() => go(false)}
          className={`${segBase} ${!inAdmin ? active : idle}`}
        >
          {L.staff}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={inAdmin}
          onClick={() => go(true)}
          className={`${segBase} ${inAdmin ? active : idle}`}
        >
          {L.admin}
        </button>
      </div>
    </div>
  );
}
