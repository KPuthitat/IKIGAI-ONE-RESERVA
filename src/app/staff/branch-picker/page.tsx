// /staff/branch-picker — first-stop after login for multi-branch staff.
//
// "เลือกก่อนว่าวันนี้ทำงานสาขาไหน" — staff with >1 assigned branches
// must pick before any form (shift open/close, leave, etc.) becomes
// available. The choice writes to session.active_branch_id; subsequent
// pages read it via getSessionUser. Staff can return here anytime via
// the topbar "เปลี่ยนสาขา" link to switch (e.g. half-day at A, then B
// in the afternoon).
//
// Auto-skip behavior:
//   - 0 branches → polite error ("contact admin to assign you")
//   - 1 branch  → auto-set + redirect to /staff (no UI shown, no choice
//                 to make, friction-free)
//   - >1        → render BranchPickerClient

import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser, setActiveBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import BranchPickerClient from "../../BranchPickerClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เลือกสาขา" };

export default function BranchPickerPage({
  searchParams
}: { searchParams: { next?: string } }) {
  const user = requireUser();
  const lang = getLang();
  const next = searchParams.next || "/staff";

  if (user.branches.length === 0) {
    return (
      <div className="card text-center space-y-3">
        <h1 className="text-xl font-bold text-slate-800">
          {t(lang, "staff.branchPicker.empty.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "staff.branchPicker.empty.body")}
        </p>
      </div>
    );
  }

  if (user.branches.length === 1) {
    // Auto-pick — no point showing a one-option screen. Persist the
    // choice so the topbar pill renders correctly downstream.
    setActiveBranch(user.branches[0].id);
    redirect(next);
  }

  // Resolve each branch's company name so staff see which company a
  // branch belongs to before choosing (helps when branch names alone
  // are ambiguous across the group).
  const companyById = new Map<number, string>(
    (getDb()
      .prepare("SELECT id, name_th FROM companies")
      .all() as Array<{ id: number; name_th: string }>).map((c) => [c.id, c.name_th])
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "staff.branchPicker.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "staff.branchPicker.subtitle", { name: user.display_name })}
        </p>
      </div>
      <BranchPickerClient
        branches={user.branches.map((b) => ({
          id: b.id,
          name: b.name,
          company: b.company_id != null ? companyById.get(b.company_id) ?? null : null
        }))}
        activeBranchId={user.activeBranchId}
        next={next}
      />
    </div>
  );
}
