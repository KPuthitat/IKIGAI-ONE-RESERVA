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
  const { t, lang } = useLang();
  const pathname = usePathname() || "";
  if (pathname === pickerPath || pathname.startsWith(pickerPath + "/")) return null;

  // RECRUITA is a company-wide module — applications are NOT scoped to
  // the selected branch (the branch is decided at hire time, when the
  // candidate is bridged into PERSONA at the position's branch). Show
  // an "all branches" badge instead of the active-branch pill so admins
  // aren't misled into thinking a NAMA applicant "belongs" to whatever
  // branch happens to be selected.
  if (pathname.startsWith("/admin/recruita")) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] bg-white border border-[#DDCBAE] rounded-full px-2.5 py-0.5">
        <span className="text-slate-800 font-bold">{lang === "en" ? "All branches" : "ทุกสาขา"}</span>
        <span className="text-slate-400">· {lang === "en" ? "company-wide" : "ส่วนกลาง"}</span>
      </span>
    );
  }

  if (!branchName) return null;

  // 2026-05-25 final layout — revert to original inline pill but
  // drop "วันนี้" prefix and the emoji. Same horizontal style as
  // before, just less crowded.
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] bg-white border border-[#DDCBAE] rounded-full pl-2.5 pr-1 py-0.5">
      <span className="text-slate-800 font-bold">{branchName}</span>
      {hasChoice && (
        <Link
          href={`${pickerPath}?next=${encodeURIComponent(pathname)}`}
          className="text-brand-dark hover:text-white px-1.5 py-0.5 rounded-full bg-brand/15 hover:bg-brand ml-0.5 transition"
        >
          {t("staff.topbar.changeBranch")}
        </Link>
      )}
    </span>
  );
}
