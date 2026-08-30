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
  branchName, hasChoice, pickerPath, className = ""
}: {
  branchName: string | null;
  hasChoice: boolean;
  pickerPath: string;
  /** Extra classes from the layout (e.g. flex-1 for balanced widths). */
  className?: string;
}) {
  const { t, lang } = useLang();
  const pathname = usePathname() || "";
  if (pathname === pickerPath || pathname.startsWith(pickerPath + "/")) return null;

  // Shared topbar-control shell so the branch pill matches the view-switch
  // button (owner 2026-08: same look + balanced). h-10 rounded-xl on the dark
  // gradient.
  const shell = `flex items-center gap-2 h-10 px-3 rounded-xl bg-white/10 border border-white/20 text-[13px] min-w-0 ${className}`;

  // RECRUITA is a company-wide module — applications are NOT scoped to
  // the selected branch (the branch is decided at hire time, when the
  // candidate is bridged into PERSONA at the position's branch). Show
  // an "all branches" badge instead of the active-branch pill so admins
  // aren't misled into thinking a NAMA applicant "belongs" to whatever
  // branch happens to be selected.
  if (pathname.startsWith("/admin/recruita")) {
    return (
      <span className={shell}>
        <span className="text-white font-bold truncate">{lang === "en" ? "All branches" : "ทุกสาขา"}</span>
        <span className="text-white/50 truncate">· {lang === "en" ? "company-wide" : "ส่วนกลาง"}</span>
      </span>
    );
  }

  if (!branchName) return null;

  // The whole pill is the "change branch" tap target when the user has a
  // choice (bigger + matches the view-switch button); otherwise a static pill.
  const inner = (
    <>
      <span className="text-white font-bold truncate flex-1 min-w-0">{branchName}</span>
      {hasChoice && (
        <span className="flex-shrink-0 text-[11px] text-brand-light px-2 py-0.5 rounded-full bg-brand/30">
          {t("staff.topbar.changeBranch")}
        </span>
      )}
    </>
  );
  return hasChoice ? (
    <Link href={`${pickerPath}?next=${encodeURIComponent(pathname)}`} className={`${shell} hover:bg-white/[0.16] transition-colors`}>
      {inner}
    </Link>
  ) : (
    <span className={shell}>{inner}</span>
  );
}
