"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLang } from "@/lib/LangProvider";

// Topbar indicator for staff — shows "วันนี้: <branch>" plus a small
// "เปลี่ยน" link that returns to /staff/branch-picker so staff can swap
// branches mid-day (e.g. half-day at A, then B in the afternoon). Hidden
// on the picker itself (no point linking to the page you're on) and for
// staff with only one branch (no choice to make).

export default function TodaysBranchPill({
  branchName, hasChoice
}: {
  branchName: string | null;
  /** True when the staff has more than one assigned branch — only then
   *  do we render the "เปลี่ยน" link. Single-branch staff just see the
   *  static name. */
  hasChoice: boolean;
}) {
  const { t } = useLang();
  const pathname = usePathname() || "";
  if (pathname.startsWith("/staff/branch-picker")) return null;
  if (!branchName) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] bg-white/[.10] border border-white/[.20] rounded-full pl-2.5 pr-1 py-0.5">
      <span className="text-white/50 tracking-[0.5px]">{t("staff.topbar.today")}</span>
      <span className="text-white font-bold">{branchName}</span>
      {hasChoice && (
        <Link
          href={`/staff/branch-picker?next=${encodeURIComponent(pathname)}`}
          className="text-brand-light hover:text-white px-1.5 py-0.5 rounded-full bg-brand/30 hover:bg-brand/50 ml-0.5 transition"
        >
          {t("staff.topbar.changeBranch")}
        </Link>
      )}
    </span>
  );
}
