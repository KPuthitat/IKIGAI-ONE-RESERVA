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

  // 2026-05-25 final layout — revert to original inline pill but
  // drop "วันนี้" prefix and the emoji. Same horizontal style as
  // before, just less crowded.
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] bg-white/[.10] border border-white/[.20] rounded-full pl-2.5 pr-1 py-0.5">
      <span className="text-white font-bold">{branchName}</span>
      {hasChoice && (
        <Link
          href={`${pickerPath}?next=${encodeURIComponent(pathname)}`}
          className="text-brand-light hover:text-white px-1.5 py-0.5 rounded-full bg-brand/30 hover:bg-brand/50 ml-0.5 transition"
        >
          {t("staff.topbar.changeBranch")}
        </Link>
      )}
    </span>
  );
}
