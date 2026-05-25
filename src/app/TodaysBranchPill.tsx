"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLang } from "@/lib/LangProvider";

// Topbar indicator shown on both staff and admin layouts: the
// currently-active branch name + a small "เปลี่ยน" link that drops
// the user on the branch picker for their role. Used to be staff-only
// (with /staff/branch-picker hard-coded); now takes a pickerPath prop
// so /admin can reuse the same component.
//
// Hidden in two cases:
//   1. Already on the picker — no point linking to where you are.
//   2. Single-branch user with no choice to make — render only the
//      static branch name (no "เปลี่ยน" link).

export default function TodaysBranchPill({
  branchName, hasChoice, pickerPath
}: {
  branchName: string | null;
  hasChoice: boolean;
  pickerPath: string;
}) {
  const { t } = useLang();
  const pathname = usePathname() || "";
  if (pathname === pickerPath || pathname.startsWith(pickerPath + "/")) return null;
  if (!branchName) return null;

  // 2026-05-25 layout rework — "วันนี้" prefix removed (took up
  // too much horizontal space + wrapped awkwardly in the narrow
  // sidebar). Now: pin-icon + branch name on row 1, small "เปลี่ยน"
  // chip on row 2 if there's a choice. Stays compact + each line
  // wraps cleanly on narrow viewports.
  return (
    <div className="flex flex-col items-start gap-1 max-w-full">
      <div className="inline-flex items-start gap-1.5 text-[12px] text-white font-bold break-words">
        <span aria-hidden className="text-white/60 mt-0.5 select-none">📍</span>
        <span className="leading-tight">{branchName}</span>
      </div>
      {hasChoice && (
        <Link
          href={`${pickerPath}?next=${encodeURIComponent(pathname)}`}
          className="text-[10px] text-brand-light hover:text-white px-2 py-0.5 rounded-full bg-brand/30 hover:bg-brand/50 transition"
        >
          {t("staff.topbar.changeBranch")}
        </Link>
      )}
    </div>
  );
}
